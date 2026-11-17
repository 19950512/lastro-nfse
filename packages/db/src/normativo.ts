import { EXTRATOR_REGRAS, extrairCabecalho, extrairRelacoes, type TipoRelacao } from '@lastro/normas';
import type pg from 'pg';

export interface TrechoNormativo {
  readonly id: string;
  readonly ordem: number;
  readonly texto: string;
  readonly secao: string | null;
}

export interface DocumentoNormativo {
  readonly snapshotId: string;
  readonly documentoId: string;
  readonly fonteId: string;
  readonly url: string;
  readonly trechos: readonly TrechoNormativo[];
}

export interface MetadadoProposto {
  readonly chave: string;
  readonly tipo: string;
  readonly numero: string;
  readonly orgao: string | null;
  readonly dataAto: string | null;
  readonly titulo: string;
  readonly evidenciaTrechoId: string;
}

export interface RelacaoParaGravar {
  readonly tipo: TipoRelacao;
  readonly destinoChave: string | null;
  readonly destinoDescricao: string;
  readonly dispositivo: string | null;
  readonly efeitoEm: string | null;
  readonly evidenciaTrechoId: string;
  readonly evidenciaTexto: string;
}

export const TIPOS_FATO = ['prazo', 'obrigacao', 'vigencia', 'valor', 'pendente'] as const;
export type TipoFato = (typeof TIPOS_FATO)[number];

export interface FatoParaGravar {
  readonly tipo: TipoFato;
  readonly tema: string;
  readonly enunciado: string;
  readonly publico: string | null;
  readonly dataEfeito: string | null;
  readonly evidenciaTrechoId: string;
  readonly evidenciaTexto: string;
}

export interface ResultadoNormativo {
  readonly metadado: MetadadoProposto | null;
  readonly relacoes: readonly RelacaoParaGravar[];
  readonly fatos: readonly FatoParaGravar[];
  readonly detalhe: string | null;
}

const MAX_TRECHOS_POR_DOCUMENTO = 4000;

/**
 * Versões indexáveis com texto extraído que este extrator ainda não analisou.
 *
 * invariant: lê só a extração vigente (a versão anômala não liberada não entra), como a busca.
 */
export async function listarPendentesNormativos(
  pool: pg.Pool,
  extrator: string,
  opcoes: { limite: number; fontes?: readonly string[] | undefined },
): Promise<DocumentoNormativo[]> {
  const docs = await pool.query<{ snapshot_id: string; documento_id: string; fonte_id: string; url: string; extracao_id: string }>(
    `SELECT x.snapshot_id, x.documento_id, x.fonte_id, d.url, x.id AS extracao_id
       FROM extracao_vigente x JOIN documento d ON d.id = x.documento_id
      WHERE x.tipo = 'texto'
        AND ($2::text[] IS NULL OR x.fonte_id = ANY ($2))
        AND NOT EXISTS (SELECT 1 FROM extracao_normativa n WHERE n.snapshot_id = x.snapshot_id AND n.extrator = $1)
      ORDER BY x.criada_em
      LIMIT $3`,
    [extrator, opcoes.fontes === undefined || opcoes.fontes.length === 0 ? null : [...opcoes.fontes], opcoes.limite],
  );
  if (docs.rows.length === 0) return [];
  const trechos = await pool.query<{ extracao_id: string; id: string; ordem: number; texto: string; secao: string | null }>(
    `SELECT t.extracao_id, t.id, t.ordem, t.texto, t.secao FROM trecho t
      WHERE t.extracao_id = ANY ($1::uuid[]) AND t.ordem < $2 ORDER BY t.extracao_id, t.ordem`,
    [docs.rows.map((d) => d.extracao_id), MAX_TRECHOS_POR_DOCUMENTO],
  );
  const porExtracao = new Map<string, TrechoNormativo[]>();
  for (const t of trechos.rows) {
    const lista = porExtracao.get(t.extracao_id) ?? [];
    lista.push({ id: t.id, ordem: t.ordem, texto: t.texto, secao: t.secao });
    porExtracao.set(t.extracao_id, lista);
  }
  return docs.rows.map((d) => ({
    snapshotId: d.snapshot_id,
    documentoId: d.documento_id,
    fonteId: d.fonte_id,
    url: d.url,
    trechos: porExtracao.get(d.extracao_id) ?? [],
  }));
}

/**
 * Grava o que um extrator propôs para uma versão, numa transação, e marca a versão como analisada.
 *
 * invariant: tudo entra como proposta (sem decisão de curadoria); duplicatas de outra rodada ou de outro
 * extrator são ignoradas pelos índices únicos. Evidência que não existe literalmente no trecho derruba a
 * transação inteira (trigger do banco), então o extrator precisa garantir a substring antes de chamar.
 */
export async function gravarNormativo(pool: pg.Pool, doc: DocumentoNormativo, extrator: string, r: ResultadoNormativo): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let itens = 0;
    if (r.metadado !== null) {
      const m = r.metadado;
      await c.query(
        `INSERT INTO metadado_ato (snapshot_id, documento_id, extrator, chave, tipo, numero, orgao, data_ato, titulo, evidencia_trecho_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
        [doc.snapshotId, doc.documentoId, extrator, m.chave, m.tipo, m.numero, m.orgao, m.dataAto, m.titulo.slice(0, 500), m.evidenciaTrechoId],
      );
      itens++;
    }
    for (const rel of r.relacoes) {
      const ins = await c.query(
        `INSERT INTO relacao_normativa (origem_documento_id, tipo, destino_chave, destino_descricao, dispositivo, efeito_em,
                                        evidencia_trecho_id, evidencia_texto, extrator)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [doc.documentoId, rel.tipo, rel.destinoChave, rel.destinoDescricao.slice(0, 500), rel.dispositivo, rel.efeitoEm, rel.evidenciaTrechoId, rel.evidenciaTexto, extrator],
      );
      itens += ins.rowCount ?? 0;
    }
    for (const f of r.fatos) {
      const ins = await c.query(
        `INSERT INTO fato (tipo, tema, enunciado, publico, data_efeito, evidencia_trecho_id, evidencia_texto, extrator)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [f.tipo, f.tema, f.enunciado, f.publico, f.dataEfeito, f.evidenciaTrechoId, f.evidenciaTexto, extrator],
      );
      itens += ins.rowCount ?? 0;
    }
    await c.query('INSERT INTO extracao_normativa (snapshot_id, extrator, itens, detalhe) VALUES ($1, $2, $3, $4)', [
      doc.snapshotId,
      extrator,
      itens,
      r.detalhe?.slice(0, 2000) ?? null,
    ]);
    await c.query('COMMIT');
    return itens;
  } catch (erro) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    c.release();
  }
}

const TRECHOS_CABECALHO = 3;

/**
 * Análise por regras (sem LLM): identidade do ato pelo cabeçalho e relações declaradas no texto.
 *
 * why: só documento com identidade de ato propõe relação. Páginas de listagem ("Atos conjuntos") citam
 * ementas de vários atos ("Altera o Ato Conjunto nº 4") e virariam origem de relações que não são delas.
 */
export function analisarPorRegras(doc: DocumentoNormativo): ResultadoNormativo {
  const primeiros = doc.trechos.slice(0, TRECHOS_CABECALHO);
  let metadado: MetadadoProposto | null = null;
  for (const t of primeiros) {
    const cab = extrairCabecalho(t.texto);
    if (cab?.referencia.chave != null) {
      const ref = cab.referencia;
      metadado = { chave: ref.chave ?? '', tipo: ref.tipo, numero: ref.numero, orgao: ref.orgao, dataAto: ref.data, titulo: cab.titulo, evidenciaTrechoId: t.id };
      break;
    }
  }
  if (metadado === null) return { metadado: null, relacoes: [], fatos: [], detalhe: 'sem identificação de ato no cabeçalho' };
  const relacoes: RelacaoParaGravar[] = [];
  for (const t of doc.trechos) {
    for (const r of extrairRelacoes(t.texto, metadado.chave)) {
      relacoes.push({
        tipo: r.tipo,
        destinoChave: r.destino.chave,
        destinoDescricao: r.destino.texto.replace(/\s+/g, ' ').trim(),
        dispositivo: r.dispositivo,
        efeitoEm: r.efeitoEm,
        evidenciaTrechoId: t.id,
        evidenciaTexto: r.evidencia,
      });
    }
  }
  return { metadado, relacoes, fatos: [], detalhe: null };
}

export interface ResumoNormativo {
  readonly url: string;
  readonly chave: string | null;
  readonly relacoes: number;
  readonly fatos: number;
  readonly itensGravados: number;
}

export async function processarNormasPorRegras(
  pool: pg.Pool,
  opcoes: { limite: number; aoProcessar?: (r: ResumoNormativo) => void },
): Promise<ResumoNormativo[]> {
  const saida: ResumoNormativo[] = [];
  for (const doc of await listarPendentesNormativos(pool, EXTRATOR_REGRAS, { limite: opcoes.limite })) {
    const r = analisarPorRegras(doc);
    const itens = await gravarNormativo(pool, doc, EXTRATOR_REGRAS, r);
    const resumo = { url: doc.url, chave: r.metadado?.chave ?? null, relacoes: r.relacoes.length, fatos: r.fatos.length, itensGravados: itens };
    opcoes.aoProcessar?.(resumo);
    saida.push(resumo);
  }
  return saida;
}
