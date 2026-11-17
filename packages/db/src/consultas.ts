import type { TipoEvento } from '@lastro/ingest';
import type pg from 'pg';

export interface Mudanca {
  readonly id: string;
  readonly tipo: TipoEvento;
  readonly fonteId: string;
  readonly documentoId: string;
  readonly url: string;
  readonly snapshotAnterior: string | null;
  readonly snapshotNovo: string | null;
  readonly detectadoEm: string;
  readonly resumo: string;
  readonly anomalia: string | null;
}

export interface FiltroMudancas {
  readonly desde?: Date | undefined;
  readonly ate?: Date | undefined;
  readonly fonteId?: string | undefined;
  readonly tipos?: readonly TipoEvento[] | undefined;
  readonly anomalia?: boolean | undefined;
  readonly limite: number;
  readonly cursor?: string | undefined;
}

export interface Pagina<T> {
  readonly itens: readonly T[];
  readonly proximo: string | null;
}

export interface VersaoDocumento {
  readonly id: string;
  readonly coletadoEm: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mime: string;
  readonly urlFinal: string;
}

export interface ResumoDocumento {
  readonly id: string;
  readonly fonteId: string;
  readonly url: string;
  readonly versoes: number;
  readonly ultimaVersaoEm: string | null;
  readonly ultimaVerificacaoEm: string | null;
  readonly mime: string | null;
  readonly situacao: 'disponivel' | 'indisponivel';
}

export interface DetalheDocumento extends ResumoDocumento {
  readonly criadoEm: string;
  readonly historico: readonly VersaoDocumento[];
  readonly eventos: readonly Mudanca[];
}

export interface SnapshotParaDownload {
  readonly id: string;
  readonly documentoId: string;
  readonly url: string;
  readonly sha256: string;
  readonly mime: string;
  readonly bytes: number;
  readonly coletadoEm: string;
}

export interface ResumoFonte {
  readonly fonteId: string;
  readonly documentos: number;
  readonly ultimaVersaoEm: string | null;
  readonly ultimaVerificacaoEm: string | null;
}

/** Leitura do arquivo para a API e a tela (papel `lastro_leitor`, só SELECT). */
export interface ConsultasArquivo {
  listarMudancas(filtro: FiltroMudancas): Promise<Pagina<Mudanca>>;
  listarDocumentos(filtro: { fonteId?: string | undefined; limite: number; cursor?: string | undefined }): Promise<Pagina<ResumoDocumento>>;
  obterDocumento(id: string): Promise<DetalheDocumento | undefined>;
  obterSnapshot(id: string): Promise<SnapshotParaDownload | undefined>;
  resumoFontes(): Promise<ResumoFonte[]>;
}

export class ErroCursor extends Error {
  constructor() {
    super('cursor inválido');
    this.name = 'ErroCursor';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function codificarCursor(partes: readonly string[]): string {
  return Buffer.from(JSON.stringify(partes)).toString('base64url');
}

// hazard: o cursor vem do cliente; só strings, em quantidade fixa, e cada parte é validada antes do SQL.
export function decodificarCursor(cursor: string, tamanho: number): string[] {
  let partes: unknown;
  try {
    partes = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ErroCursor();
  }
  if (!Array.isArray(partes) || partes.length !== tamanho || !partes.every((p) => typeof p === 'string' && p.length <= 2048)) {
    throw new ErroCursor();
  }
  return partes as string[];
}

function cursorDeEvento(cursor: string): [Date, string] {
  const [instante, id] = decodificarCursor(cursor, 2) as [string, string];
  const data = new Date(instante);
  if (Number.isNaN(data.getTime()) || !UUID.test(id)) throw new ErroCursor();
  return [data, id];
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

interface LinhaMudanca {
  id: string;
  tipo: TipoEvento;
  fonte_id: string;
  documento_id: string;
  url: string;
  snapshot_anterior: string | null;
  snapshot_novo: string | null;
  detectado_em: Date;
  resumo: string;
  anomalia: string | null;
}

const paraMudanca = (l: LinhaMudanca): Mudanca => ({
  id: l.id,
  tipo: l.tipo,
  fonteId: l.fonte_id,
  documentoId: l.documento_id,
  url: l.url,
  snapshotAnterior: l.snapshot_anterior,
  snapshotNovo: l.snapshot_novo,
  detectadoEm: l.detectado_em.toISOString(),
  resumo: l.resumo,
  anomalia: l.anomalia,
});

const SELECAO_MUDANCA = `
  SELECT e.id, e.tipo, e.fonte_id, d.id AS documento_id, d.url, e.snapshot_anterior, e.snapshot_novo,
         e.detectado_em, e.resumo, e.anomalia
    FROM evento_mudanca e JOIN documento d ON d.id = e.documento_id`;

interface LinhaResumoDocumento {
  id: string;
  fonte_id: string;
  url: string;
  criado_em: Date;
  versoes: number;
  ultima_versao_em: Date | null;
  ultima_verificacao_em: Date | null;
  mime: string | null;
  ultimo_evento: TipoEvento | null;
}

const SELECAO_DOCUMENTO = `
  SELECT d.id, d.fonte_id, d.url, d.criado_em,
         s.versoes, s.ultima_versao_em, s.mime, v.ultima_verificacao_em, ev.tipo AS ultimo_evento
    FROM documento d
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS versoes, max(coletado_em) AS ultima_versao_em,
             (array_agg(mime ORDER BY coletado_em DESC))[1] AS mime
        FROM snapshot WHERE documento_id = d.id
    ) s ON true
    LEFT JOIN LATERAL (SELECT max(verificado_em) AS ultima_verificacao_em FROM verificacao_coleta WHERE documento_id = d.id) v ON true
    LEFT JOIN LATERAL (
      SELECT tipo FROM evento_mudanca WHERE documento_id = d.id ORDER BY detectado_em DESC, id DESC LIMIT 1
    ) ev ON true`;

const paraResumoDocumento = (l: LinhaResumoDocumento): ResumoDocumento => ({
  id: l.id,
  fonteId: l.fonte_id,
  url: l.url,
  versoes: l.versoes,
  ultimaVersaoEm: iso(l.ultima_versao_em),
  ultimaVerificacaoEm: iso(l.ultima_verificacao_em),
  mime: l.mime,
  situacao: l.ultimo_evento === 'documento-indisponivel' ? 'indisponivel' : 'disponivel',
});

export class ConsultasPostgres implements ConsultasArquivo {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async listarMudancas(filtro: FiltroMudancas): Promise<Pagina<Mudanca>> {
    const [cursorData, cursorId] = filtro.cursor === undefined ? [null, null] : cursorDeEvento(filtro.cursor);
    const r = await this.pool.query<LinhaMudanca>(
      `${SELECAO_MUDANCA}
        WHERE ($1::timestamptz IS NULL OR e.detectado_em >= $1)
          AND ($2::timestamptz IS NULL OR e.detectado_em < $2)
          AND ($3::text IS NULL OR e.fonte_id = $3)
          AND ($4::text[] IS NULL OR e.tipo = ANY($4))
          AND ($5::boolean IS NULL OR (e.anomalia IS NOT NULL) = $5)
          AND ($6::timestamptz IS NULL OR (e.detectado_em, e.id) > ($6, $7::uuid))
        ORDER BY e.detectado_em, e.id
        LIMIT $8`,
      [
        filtro.desde ?? null,
        filtro.ate ?? null,
        filtro.fonteId ?? null,
        filtro.tipos ?? null,
        filtro.anomalia ?? null,
        cursorData,
        cursorId,
        filtro.limite + 1,
      ],
    );
    const itens = r.rows.slice(0, filtro.limite).map(paraMudanca);
    const ultimo = itens.at(-1);
    return {
      itens,
      proximo: r.rows.length > filtro.limite && ultimo !== undefined ? codificarCursor([ultimo.detectadoEm, ultimo.id]) : null,
    };
  }

  async listarDocumentos(filtro: { fonteId?: string | undefined; limite: number; cursor?: string | undefined }): Promise<Pagina<ResumoDocumento>> {
    const [cursorUrl] = filtro.cursor === undefined ? [null] : decodificarCursor(filtro.cursor, 1);
    const r = await this.pool.query<LinhaResumoDocumento>(
      `${SELECAO_DOCUMENTO}
        WHERE ($1::text IS NULL OR d.fonte_id = $1)
          AND ($2::text IS NULL OR d.url > $2)
        ORDER BY d.url
        LIMIT $3`,
      [filtro.fonteId ?? null, cursorUrl ?? null, filtro.limite + 1],
    );
    const itens = r.rows.slice(0, filtro.limite).map(paraResumoDocumento);
    const ultimo = itens.at(-1);
    return { itens, proximo: r.rows.length > filtro.limite && ultimo !== undefined ? codificarCursor([ultimo.url]) : null };
  }

  async obterDocumento(id: string): Promise<DetalheDocumento | undefined> {
    if (!UUID.test(id)) return undefined;
    const r = await this.pool.query<LinhaResumoDocumento>(`${SELECAO_DOCUMENTO} WHERE d.id = $1`, [id]);
    const linha = r.rows[0];
    if (linha === undefined) return undefined;
    const [historico, eventos] = await Promise.all([
      this.pool.query<{ id: string; coletado_em: Date; sha256: string; bytes: string; mime: string; url_final: string }>(
        'SELECT id, coletado_em, sha256, bytes, mime, url_final FROM snapshot WHERE documento_id = $1 ORDER BY coletado_em DESC, id DESC',
        [id],
      ),
      this.pool.query<LinhaMudanca>(`${SELECAO_MUDANCA} WHERE d.id = $1 ORDER BY e.detectado_em DESC, e.id DESC LIMIT 100`, [id]),
    ]);
    return {
      ...paraResumoDocumento(linha),
      criadoEm: linha.criado_em.toISOString(),
      historico: historico.rows.map((s) => ({
        id: s.id,
        coletadoEm: s.coletado_em.toISOString(),
        sha256: s.sha256,
        bytes: Number(s.bytes),
        mime: s.mime,
        urlFinal: s.url_final,
      })),
      eventos: eventos.rows.map(paraMudanca),
    };
  }

  async obterSnapshot(id: string): Promise<SnapshotParaDownload | undefined> {
    if (!UUID.test(id)) return undefined;
    const r = await this.pool.query<{
      id: string;
      documento_id: string;
      url: string;
      sha256: string;
      mime: string;
      bytes: string;
      coletado_em: Date;
    }>(
      `SELECT s.id, s.documento_id, d.url, s.sha256, s.mime, s.bytes, s.coletado_em
         FROM snapshot s JOIN documento d ON d.id = s.documento_id WHERE s.id = $1`,
      [id],
    );
    const l = r.rows[0];
    if (l === undefined) return undefined;
    return {
      id: l.id,
      documentoId: l.documento_id,
      url: l.url,
      sha256: l.sha256,
      mime: l.mime,
      bytes: Number(l.bytes),
      coletadoEm: l.coletado_em.toISOString(),
    };
  }

  async resumoFontes(): Promise<ResumoFonte[]> {
    const r = await this.pool.query<{
      fonte_id: string;
      documentos: number;
      ultima_versao_em: Date | null;
      ultima_verificacao_em: Date | null;
    }>(
      `SELECT d.fonte_id, count(*)::int AS documentos, max(s.ultima) AS ultima_versao_em, max(v.ultima) AS ultima_verificacao_em
         FROM documento d
         LEFT JOIN LATERAL (SELECT max(coletado_em) AS ultima FROM snapshot WHERE documento_id = d.id) s ON true
         LEFT JOIN LATERAL (SELECT max(verificado_em) AS ultima FROM verificacao_coleta WHERE documento_id = d.id) v ON true
        GROUP BY d.fonte_id
        ORDER BY d.fonte_id`,
    );
    return r.rows.map((l) => ({
      fonteId: l.fonte_id,
      documentos: l.documentos,
      ultimaVersaoEm: iso(l.ultima_versao_em),
      ultimaVerificacaoEm: iso(l.ultima_verificacao_em),
    }));
  }
}
