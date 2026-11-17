import { verificarOrigem } from '@lastro/core';
import {
  ErroArquivo,
  sha256,
  type ArquivoVersionado,
  type EventoMudanca,
  type NovoSnapshot,
  type RegistroSnapshot,
  type RegistroVerificacao,
  type TipoEvento,
} from '@lastro/ingest';
import type pg from 'pg';
import type { StorageWorm } from './storage.ts';

interface LinhaSnapshot {
  id: string;
  fonte_id: string;
  url: string;
  url_final: string;
  coletado_em: Date;
  sha256: string;
  impressao: string;
  bytes: string;
  mime: string;
  etag: string | null;
  ultima_modificacao: string | null;
}

interface LinhaEvento {
  id: string;
  tipo: TipoEvento;
  fonte_id: string;
  url: string;
  snapshot_anterior: string | null;
  snapshot_novo: string | null;
  detectado_em: Date;
  resumo: string;
  anomalia: string | null;
}

function paraSnapshot(l: LinhaSnapshot): RegistroSnapshot {
  return {
    id: l.id,
    fonteId: l.fonte_id,
    url: l.url,
    urlFinal: l.url_final,
    coletadoEm: l.coletado_em.toISOString(),
    sha256: l.sha256,
    impressao: l.impressao,
    bytes: Number(l.bytes),
    mime: l.mime,
    etag: l.etag,
    ultimaModificacao: l.ultima_modificacao,
  };
}

function paraEvento(l: LinhaEvento): EventoMudanca {
  return {
    id: l.id,
    tipo: l.tipo,
    fonteId: l.fonte_id,
    url: l.url,
    snapshotAnterior: l.snapshot_anterior,
    snapshotNovo: l.snapshot_novo,
    detectadoEm: l.detectado_em.toISOString(),
    resumo: l.resumo,
    anomalia: l.anomalia,
  };
}

const SELECAO_EVENTO = `
  SELECT e.id, e.tipo, e.fonte_id, d.url, e.snapshot_anterior, e.snapshot_novo, e.detectado_em, e.resumo, e.anomalia
    FROM evento_mudanca e JOIN documento d ON d.id = e.documento_id`;

const SELECAO_SNAPSHOT = `
  SELECT s.id, s.fonte_id, d.url, s.url_final, s.coletado_em, s.sha256, s.impressao, s.bytes, s.mime,
         s.etag, s.ultima_modificacao
    FROM snapshot s JOIN documento d ON d.id = s.documento_id`;

function exigirOrigem(url: string): void {
  const origem = verificarOrigem(url);
  if (!origem.permitido) throw new ErroArquivo(`recusado: ${origem.motivo}`);
}

/**
 * Arquivo versionado em Postgres (metadados) + storage WORM (bytes), ARQUITETURA.md §2.1.
 *
 * invariant: os bytes vão para o storage antes da linha no banco, então nenhum snapshot aponta
 * para objeto inexistente. Toda URL passa de novo pela lista oficial antes de entrar no banco.
 */
export class ArquivoPostgres implements ArquivoVersionado {
  private readonly pool: pg.Pool;
  private readonly storage: StorageWorm;

  constructor(pool: pg.Pool, storage: StorageWorm) {
    this.pool = pool;
    this.storage = storage;
  }

  private async garantirDocumento(cliente: pg.Pool | pg.PoolClient, url: string, fonteId: string): Promise<string> {
    exigirOrigem(url);
    const inserido = await cliente.query<{ id: string }>(
      'INSERT INTO documento (fonte_id, url) VALUES ($1, $2) ON CONFLICT (url) DO NOTHING RETURNING id',
      [fonteId, url],
    );
    const novo = inserido.rows[0];
    if (novo !== undefined) return novo.id;
    const existente = await cliente.query<{ id: string }>('SELECT id FROM documento WHERE url = $1', [url]);
    const linha = existente.rows[0];
    if (linha === undefined) throw new ErroArquivo(`documento sumiu durante a gravação: ${url}`);
    return linha.id;
  }

  async ultimoSnapshot(url: string): Promise<RegistroSnapshot | undefined> {
    const r = await this.pool.query<LinhaSnapshot>(
      `${SELECAO_SNAPSHOT} WHERE d.url = $1 ORDER BY s.coletado_em DESC, s.id DESC LIMIT 1`,
      [url],
    );
    const linha = r.rows[0];
    return linha === undefined ? undefined : paraSnapshot(linha);
  }

  async gravarSnapshot(novo: NovoSnapshot, agora: Date): Promise<RegistroSnapshot> {
    exigirOrigem(novo.url);
    exigirOrigem(novo.urlFinal);
    if (sha256(novo.corpo) !== novo.sha256) throw new ErroArquivo(`hash divergente para ${novo.url}`);

    await this.storage.gravar(novo.sha256, novo.corpo, novo.mime);

    const cliente = await this.pool.connect();
    try {
      await cliente.query('BEGIN');
      const documentoId = await this.garantirDocumento(cliente, novo.url, novo.fonteId);
      const r = await cliente.query<{ id: string; coletado_em: Date }>(
        `INSERT INTO snapshot (documento_id, fonte_id, url_final, coletado_em, sha256, impressao, bytes, mime,
                               etag, ultima_modificacao, chave_storage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, coletado_em`,
        [
          documentoId,
          novo.fonteId,
          novo.urlFinal,
          agora,
          novo.sha256,
          novo.impressao,
          novo.corpo.byteLength,
          novo.mime,
          novo.etag,
          novo.ultimaModificacao,
          this.storage.chave(novo.sha256),
        ],
      );
      await cliente.query('COMMIT');
      const linha = r.rows[0];
      if (linha === undefined) throw new ErroArquivo('INSERT sem retorno');
      return {
        id: linha.id,
        fonteId: novo.fonteId,
        url: novo.url,
        urlFinal: novo.urlFinal,
        coletadoEm: linha.coletado_em.toISOString(),
        sha256: novo.sha256,
        impressao: novo.impressao,
        bytes: novo.corpo.byteLength,
        mime: novo.mime,
        etag: novo.etag,
        ultimaModificacao: novo.ultimaModificacao,
      };
    } catch (erro) {
      await cliente.query('ROLLBACK').catch(() => undefined);
      throw erro;
    } finally {
      cliente.release();
    }
  }

  lerConteudo(sha: string): Promise<Buffer> {
    return this.storage.ler(sha);
  }

  async registrarVerificacao(registro: RegistroVerificacao): Promise<void> {
    const r = await this.pool.query(
      `INSERT INTO verificacao_coleta (documento_id, sha256, verificado_em)
       SELECT id, $2, $3 FROM documento WHERE url = $1`,
      [registro.url, registro.sha256, new Date(registro.verificadoEm)],
    );
    if (r.rowCount !== 1) throw new ErroArquivo(`verificação de documento desconhecido: ${registro.url}`);
  }

  async registrarEvento(evento: Omit<EventoMudanca, 'id'>): Promise<EventoMudanca> {
    const documentoId = await this.garantirDocumento(this.pool, evento.url, evento.fonteId);
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO evento_mudanca (tipo, fonte_id, documento_id, snapshot_anterior, snapshot_novo, detectado_em, resumo, anomalia)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        evento.tipo,
        evento.fonteId,
        documentoId,
        evento.snapshotAnterior,
        evento.snapshotNovo,
        new Date(evento.detectadoEm),
        evento.resumo,
        evento.anomalia,
      ],
    );
    const linha = r.rows[0];
    if (linha === undefined) throw new ErroArquivo('INSERT sem retorno');
    return { id: linha.id, ...evento };
  }

  async listarEventos(desde?: Date): Promise<EventoMudanca[]> {
    const r = await this.pool.query<LinhaEvento>(
      `${SELECAO_EVENTO}
        WHERE $1::timestamptz IS NULL OR e.detectado_em >= $1
        ORDER BY e.detectado_em, e.id`,
      [desde ?? null],
    );
    return r.rows.map(paraEvento);
  }

  async ultimoEvento(url: string): Promise<EventoMudanca | undefined> {
    const r = await this.pool.query<LinhaEvento>(
      `${SELECAO_EVENTO} WHERE d.url = $1 AND e.tipo NOT IN ('fato-aprovado', 'fato-corrigido') ORDER BY e.detectado_em DESC, e.id DESC LIMIT 1`,
      [url],
    );
    const linha = r.rows[0];
    return linha === undefined ? undefined : paraEvento(linha);
  }
}
