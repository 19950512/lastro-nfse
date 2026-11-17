import type { TipoRelacao } from '@lastro/normas';
import type pg from 'pg';
import type { TipoFato } from './normativo.ts';

/** Trecho oficial que sustenta um fato ou uma relação, com a origem verificável. */
export interface EvidenciaArquivada {
  readonly trechoId: string;
  readonly texto: string;
  readonly secao: string | null;
  readonly paginaIni: number | null;
  readonly paginaFim: number | null;
  readonly documentoId: string;
  readonly snapshotId: string;
  readonly url: string;
  readonly fonteId: string;
  readonly sha256: string;
  readonly coletadoEm: string;
}

export type SituacaoPublica = 'aprovado' | 'superado' | 'revogado';

export interface FatoPublico {
  readonly id: string;
  readonly tipo: TipoFato;
  readonly tema: string;
  readonly enunciado: string;
  readonly publico: string | null;
  readonly dataEfeito: string | null;
  readonly situacao: SituacaoPublica;
  readonly aprovadoEm: string | null;
  /** false quando o documento mudou depois da aprovação: o trecho citado não está mais na versão vigente. */
  readonly evidenciaAtual: boolean;
  readonly evidenciaTexto: string;
  readonly substitui: string | null;
  readonly evidencia: EvidenciaArquivada;
}

export interface RelacaoPublica {
  readonly id: string;
  readonly tipo: TipoRelacao;
  readonly situacao: 'aprovado' | 'revogado';
  readonly origemDocumentoId: string;
  readonly origemUrl: string;
  readonly origemTitulo: string | null;
  readonly destinoChave: string | null;
  readonly destinoDescricao: string;
  readonly destinoDocumentoId: string | null;
  readonly dispositivo: string | null;
  readonly efeitoEm: string | null;
  readonly aprovadaEm: string | null;
  readonly evidenciaAtual: boolean;
  readonly evidenciaTexto: string;
  readonly evidencia: EvidenciaArquivada;
}

export interface FiltroFatos {
  readonly tema?: string | undefined;
  readonly consulta?: string | undefined;
  /** Inclui superados e revogados (recall); por padrão só os aprovados vigentes. */
  readonly incluirInativos?: boolean | undefined;
  readonly limite: number;
}

/** Leitura do que passou pela curadoria (papel `lastro_api`; views `fato_publico` e `relacao_publica`). */
export interface ConsultasFatos {
  listarFatos(filtro: FiltroFatos): Promise<FatoPublico[]>;
  obterFatos(ids: readonly string[]): Promise<FatoPublico[]>;
  listarTemas(): Promise<{ tema: string; fatos: number }[]>;
  /** Relações aprovadas em que algum destes documentos é origem ou destino. */
  relacoesDosDocumentos(documentoIds: readonly string[]): Promise<RelacaoPublica[]>;
  obterRelacoes(ids: readonly string[]): Promise<RelacaoPublica[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const data = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const EVIDENCIA_SQL = `t.texto AS ev_texto, t.secao AS ev_secao, t.pagina_ini AS ev_pagina_ini, t.pagina_fim AS ev_pagina_fim,
  t.documento_id AS ev_documento_id, t.snapshot_id AS ev_snapshot_id, d.url AS ev_url, t.fonte_id AS ev_fonte_id,
  s.sha256 AS ev_sha256, s.coletado_em AS ev_coletado_em`;

interface LinhaEvidencia {
  evidencia_trecho_id: string;
  ev_texto: string;
  ev_secao: string | null;
  ev_pagina_ini: number | null;
  ev_pagina_fim: number | null;
  ev_documento_id: string;
  ev_snapshot_id: string;
  ev_url: string;
  ev_fonte_id: string;
  ev_sha256: string;
  ev_coletado_em: Date;
}

const paraEvidencia = (l: LinhaEvidencia): EvidenciaArquivada => ({
  trechoId: l.evidencia_trecho_id,
  texto: l.ev_texto,
  secao: l.ev_secao,
  paginaIni: l.ev_pagina_ini,
  paginaFim: l.ev_pagina_fim,
  documentoId: l.ev_documento_id,
  snapshotId: l.ev_snapshot_id,
  url: l.ev_url,
  fonteId: l.ev_fonte_id,
  sha256: l.ev_sha256,
  coletadoEm: l.ev_coletado_em.toISOString(),
});

interface LinhaFato extends LinhaEvidencia {
  id: string;
  tipo: TipoFato;
  tema: string;
  enunciado: string;
  publico: string | null;
  data_efeito: Date | null;
  situacao: SituacaoPublica;
  aprovado_em: Date | null;
  evidencia_atual: boolean;
  evidencia_texto: string;
  substitui: string | null;
}

const SELECAO_FATO = `
  SELECT f.id, f.tipo, f.tema, f.enunciado, f.publico, f.data_efeito, f.situacao, f.aprovado_em, f.evidencia_atual,
         f.evidencia_texto, f.substitui, f.evidencia_trecho_id, ${EVIDENCIA_SQL}
    FROM fato_publico f
    JOIN trecho t ON t.id = f.evidencia_trecho_id
    JOIN snapshot s ON s.id = t.snapshot_id
    JOIN documento d ON d.id = t.documento_id`;

const paraFato = (l: LinhaFato): FatoPublico => ({
  id: l.id,
  tipo: l.tipo,
  tema: l.tema,
  enunciado: l.enunciado,
  publico: l.publico,
  dataEfeito: data(l.data_efeito),
  situacao: l.situacao,
  aprovadoEm: iso(l.aprovado_em),
  evidenciaAtual: l.evidencia_atual,
  evidenciaTexto: l.evidencia_texto,
  substitui: l.substitui,
  evidencia: paraEvidencia(l),
});

interface LinhaRelacao extends LinhaEvidencia {
  id: string;
  tipo: TipoRelacao;
  situacao: 'aprovado' | 'revogado';
  origem_documento_id: string;
  origem_url: string;
  origem_titulo: string | null;
  destino_chave: string | null;
  destino_descricao: string;
  destino_resolvido: string | null;
  dispositivo: string | null;
  efeito_em: Date | null;
  aprovada_em: Date | null;
  evidencia_atual: boolean;
  evidencia_texto: string;
}

const SELECAO_RELACAO = `
  SELECT r.id, r.tipo, r.situacao, r.origem_documento_id, o.url AS origem_url, a.titulo AS origem_titulo, r.destino_chave,
         r.destino_descricao, r.destino_resolvido, r.dispositivo, r.efeito_em, r.aprovada_em, r.evidencia_atual, r.evidencia_texto,
         r.evidencia_trecho_id, ${EVIDENCIA_SQL}
    FROM relacao_publica r
    JOIN documento o ON o.id = r.origem_documento_id
    LEFT JOIN ato_vigente a ON a.documento_id = r.origem_documento_id
    JOIN trecho t ON t.id = r.evidencia_trecho_id
    JOIN snapshot s ON s.id = t.snapshot_id
    JOIN documento d ON d.id = t.documento_id`;

const paraRelacao = (l: LinhaRelacao): RelacaoPublica => ({
  id: l.id,
  tipo: l.tipo,
  situacao: l.situacao,
  origemDocumentoId: l.origem_documento_id,
  origemUrl: l.origem_url,
  origemTitulo: l.origem_titulo,
  destinoChave: l.destino_chave,
  destinoDescricao: l.destino_descricao,
  destinoDocumentoId: l.destino_resolvido,
  dispositivo: l.dispositivo,
  efeitoEm: data(l.efeito_em),
  aprovadaEm: iso(l.aprovada_em),
  evidenciaAtual: l.evidencia_atual,
  evidenciaTexto: l.evidencia_texto,
  evidencia: paraEvidencia(l),
});

const ids = (lista: readonly string[]): string[] => [...new Set(lista.filter((i) => UUID.test(i)))];

export class FatosPostgres implements ConsultasFatos {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async listarFatos(filtro: FiltroFatos): Promise<FatoPublico[]> {
    const consulta = filtro.consulta?.trim() === '' ? undefined : filtro.consulta;
    // why: OU entre os radicais da consulta (como na busca de trechos); exigir todos os termos quase nunca casa.
    const r = await this.pool.query<LinhaFato>(
      `WITH q AS (
         SELECT (SELECT string_agg(quote_literal(l), ' | ') FROM unnest(tsvector_to_array(to_tsvector('lastro_pt', $2))) l) AS termos
       )
       ${SELECAO_FATO}, q
        WHERE ($1::text IS NULL OR f.tema = $1)
          AND ($3 OR f.situacao = 'aprovado')
          AND ($2::text IS NULL OR (q.termos IS NOT NULL AND
               to_tsvector('lastro_pt', f.tema || ' ' || f.enunciado || ' ' || coalesce(f.publico, '')) @@ q.termos::tsquery))
        ORDER BY CASE WHEN $2::text IS NULL OR q.termos IS NULL THEN 0
                      ELSE ts_rank(to_tsvector('lastro_pt', f.tema || ' ' || f.enunciado || ' ' || coalesce(f.publico, '')), q.termos::tsquery) END DESC,
                 f.data_efeito NULLS LAST, f.id
        LIMIT $4`,
      [filtro.tema ?? null, consulta ?? null, filtro.incluirInativos === true, filtro.limite],
    );
    return r.rows.map(paraFato);
  }

  async obterFatos(lista: readonly string[]): Promise<FatoPublico[]> {
    const validos = ids(lista);
    if (validos.length === 0) return [];
    const r = await this.pool.query<LinhaFato>(`${SELECAO_FATO} WHERE f.id = ANY ($1::uuid[])`, [validos]);
    return r.rows.map(paraFato);
  }

  async listarTemas(): Promise<{ tema: string; fatos: number }[]> {
    const r = await this.pool.query<{ tema: string; fatos: number }>(
      `SELECT tema, count(*)::int AS fatos FROM fato_publico WHERE situacao = 'aprovado' GROUP BY tema ORDER BY tema`,
    );
    return r.rows;
  }

  async relacoesDosDocumentos(documentoIds: readonly string[]): Promise<RelacaoPublica[]> {
    const validos = ids(documentoIds);
    if (validos.length === 0) return [];
    const r = await this.pool.query<LinhaRelacao>(
      `${SELECAO_RELACAO} WHERE r.situacao = 'aprovado' AND (r.destino_resolvido = ANY ($1::uuid[]) OR r.origem_documento_id = ANY ($1::uuid[]))
        ORDER BY r.aprovada_em, r.id`,
      [validos],
    );
    return r.rows.map(paraRelacao);
  }

  async obterRelacoes(lista: readonly string[]): Promise<RelacaoPublica[]> {
    const validos = ids(lista);
    if (validos.length === 0) return [];
    const r = await this.pool.query<LinhaRelacao>(`${SELECAO_RELACAO} WHERE r.id = ANY ($1::uuid[])`, [validos]);
    return r.rows.map(paraRelacao);
  }
}
