import { verificarOrigem } from '@lastro/core';
import { extrairDocumento, VERSAO_EXTRATOR, type Extracao } from '@lastro/parsers';
import type pg from 'pg';

export interface SnapshotPendente {
  readonly snapshotId: string;
  readonly documentoId: string;
  readonly fonteId: string;
  readonly url: string;
  readonly sha256: string;
  readonly mime: string;
}

export interface ResultadoProcessamento {
  readonly snapshotId: string;
  readonly url: string;
  readonly tipo: Extracao['tipo'] | 'falha';
  readonly detalhe: string | null;
  readonly itens: number;
}

const LOTE_INSERCAO = 500;

/** Snapshots indexáveis (ver view `snapshot_indexavel`) ainda sem extração na versão atual do extrator. */
export async function listarPendentes(pool: pg.Pool, limite: number, versao = VERSAO_EXTRATOR): Promise<SnapshotPendente[]> {
  const r = await pool.query<{ snapshot_id: string; documento_id: string; fonte_id: string; url: string; sha256: string; mime: string }>(
    `SELECT si.snapshot_id, si.documento_id, si.fonte_id, d.url, s.sha256, s.mime
       FROM snapshot_indexavel si
       JOIN snapshot s ON s.id = si.snapshot_id
       JOIN documento d ON d.id = si.documento_id
      WHERE NOT EXISTS (SELECT 1 FROM extracao x WHERE x.snapshot_id = si.snapshot_id AND x.versao_extrator = $1)
      ORDER BY s.coletado_em
      LIMIT $2`,
    [versao, limite],
  );
  return r.rows.map((l) => ({ snapshotId: l.snapshot_id, documentoId: l.documento_id, fonteId: l.fonte_id, url: l.url, sha256: l.sha256, mime: l.mime }));
}

function lotes<T>(itens: readonly T[]): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += LOTE_INSERCAO) saida.push(itens.slice(i, i + LOTE_INSERCAO));
  return saida;
}

function contarItens(extracao: Extracao): number {
  switch (extracao.tipo) {
    case 'texto':
      return extracao.trechos.length;
    case 'tabelas':
      return extracao.tabelas.reduce((n, t) => n + t.linhas.length, 0);
    case 'leiaute':
      return extracao.campos.length;
    case 'ignorado':
      return 0;
  }
}

/**
 * Grava uma extração e tudo o que ela produziu numa transação só.
 *
 * invariant: append-only. Reprocessar com outro extrator cria outra linha em `extracao`; a anterior
 * continua existindo, para que citações antigas (ids de trecho) sigam resolvíveis.
 */
export async function gravarExtracao(
  pool: pg.Pool,
  pendente: SnapshotPendente,
  resultado: Extracao | { readonly tipo: 'falha'; readonly motivo: string },
  versao = VERSAO_EXTRATOR,
): Promise<void> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const detalhe = resultado.tipo === 'falha' || resultado.tipo === 'ignorado' ? resultado.motivo.slice(0, 2000) : null;
    const x = await cliente.query<{ id: string }>(
      'INSERT INTO extracao (snapshot_id, versao_extrator, tipo, detalhe) VALUES ($1, $2, $3, $4) RETURNING id',
      [pendente.snapshotId, versao, resultado.tipo, detalhe],
    );
    const extracaoId = x.rows[0]?.id;
    if (extracaoId === undefined) throw new Error('INSERT de extração sem retorno');
    const base = [extracaoId, pendente.snapshotId, pendente.documentoId, pendente.fonteId] as const;

    if (resultado.tipo === 'texto' || resultado.tipo === 'tabelas' || resultado.tipo === 'leiaute') {
      for (const lote of lotes(resultado.trechos)) {
        await cliente.query(
          `INSERT INTO trecho (extracao_id, snapshot_id, documento_id, fonte_id, ordem, texto, pagina_ini, pagina_fim, secao)
           SELECT $1, $2, $3, $4, * FROM unnest($5::int[], $6::text[], $7::int[], $8::int[], $9::text[])`,
          [
            ...base,
            lote.map((t) => t.ordem),
            lote.map((t) => t.texto),
            lote.map((t) => t.paginaIni),
            lote.map((t) => t.paginaFim),
            lote.map((t) => (t.secao === null ? null : t.secao.slice(0, 500))),
          ],
        );
      }
    }

    if (resultado.tipo === 'tabelas') {
      for (const tabela of resultado.tabelas) {
        const t = await cliente.query<{ id: string }>(
          `INSERT INTO tabela_referencia (extracao_id, snapshot_id, documento_id, fonte_id, slug, titulo, planilha, colunas)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [...base, tabela.slug, tabela.titulo, tabela.planilha, tabela.colunas],
        );
        const tabelaId = t.rows[0]?.id;
        if (tabelaId === undefined) throw new Error('INSERT de tabela sem retorno');
        for (const lote of lotes(tabela.linhas)) {
          await cliente.query(
            `INSERT INTO linha_referencia (tabela_id, ordem, dados, codigos)
             SELECT $1, l.ordem, l.dados, ARRAY(SELECT jsonb_array_elements_text(l.codigos))
               FROM jsonb_to_recordset($2::jsonb) AS l(ordem int, dados jsonb, codigos jsonb)`,
            [tabelaId, JSON.stringify(lote.map((l) => ({ ordem: l.ordem, dados: l.dados, codigos: l.codigos })))],
          );
        }
      }
    }

    if (resultado.tipo === 'leiaute') {
      for (const lote of lotes(resultado.campos)) {
        await cliente.query(
          `INSERT INTO campo_leiaute (extracao_id, snapshot_id, documento_id, fonte_id, nome, caminho, tipo, min_ocorrencias, max_ocorrencias, descricao, arquivo, versao)
           SELECT $1, $2, $3, $4, * FROM unnest($5::text[], $6::text[], $7::text[], $8::int[], $9::text[], $10::text[], $11::text[], $12::text[])`,
          [
            ...base,
            lote.map((c) => c.nome),
            lote.map((c) => c.caminho),
            lote.map((c) => c.tipo),
            lote.map((c) => c.minOcorrencias),
            lote.map((c) => c.maxOcorrencias),
            lote.map((c) => c.descricao),
            lote.map((c) => c.arquivo),
            lote.map((c) => c.versao),
          ],
        );
      }
    }
    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
}

export interface DependenciasProcessamento {
  readonly pool: pg.Pool;
  lerOriginal(sha: string): Promise<Buffer>;
  readonly extrair?: (corpo: Buffer, mime: string, url: string) => Promise<Extracao>;
}

/**
 * Processa os snapshots pendentes: lê os bytes do storage (hash conferido), extrai e grava.
 *
 * invariant: falha de parser vira extração do tipo `falha` (registrada, não repetida em laço);
 * falha de banco ou storage interrompe, para não marcar como processado o que não foi.
 */
export async function processarPendentes(
  deps: DependenciasProcessamento,
  opcoes: { limite: number; aoProcessar?: (r: ResultadoProcessamento) => void },
): Promise<ResultadoProcessamento[]> {
  const extrair = deps.extrair ?? extrairDocumento;
  const resultados: ResultadoProcessamento[] = [];
  for (const pendente of await listarPendentes(deps.pool, opcoes.limite)) {
    let resultado: Extracao | { tipo: 'falha'; motivo: string };
    const origem = verificarOrigem(pendente.url);
    if (!origem.permitido) {
      resultado = { tipo: 'falha', motivo: `origem recusada: ${origem.motivo}` };
    } else {
      const corpo = await deps.lerOriginal(pendente.sha256);
      try {
        resultado = await extrair(corpo, pendente.mime, pendente.url);
      } catch (erro) {
        resultado = { tipo: 'falha', motivo: erro instanceof Error ? `${erro.name}: ${erro.message}` : 'erro desconhecido' };
      }
    }
    await gravarExtracao(deps.pool, pendente, resultado);
    const r: ResultadoProcessamento = {
      snapshotId: pendente.snapshotId,
      url: pendente.url,
      tipo: resultado.tipo,
      detalhe: resultado.tipo === 'falha' || resultado.tipo === 'ignorado' ? resultado.motivo : null,
      itens: resultado.tipo === 'falha' ? 0 : contarItens(resultado),
    };
    opcoes.aoProcessar?.(r);
    resultados.push(r);
  }
  return resultados;
}
