import { normalizarCodigo } from '@lastro/parsers';
import type pg from 'pg';

export interface TrechoEncontrado {
  readonly id: string;
  readonly texto: string;
  readonly secao: string | null;
  readonly paginaIni: number | null;
  readonly paginaFim: number | null;
  readonly snapshotId: string;
  readonly sha256: string;
  readonly mime: string;
  readonly coletadoEm: string;
  /** Última vez em que a coleta confirmou que este conteúdo ainda era o publicado. */
  readonly confirmadoEm: string;
  readonly documentoId: string;
  readonly url: string;
  readonly fonteId: string;
  readonly documentoIndisponivel: boolean;
  readonly pontuacao: number;
}

export interface FiltroBusca {
  readonly consulta: string;
  readonly fontes?: readonly string[] | undefined;
  readonly limite: number;
}

export interface TabelaDisponivel {
  readonly slug: string;
  readonly titulo: string;
  readonly planilha: string;
  readonly colunas: readonly string[];
  readonly linhas: number;
  readonly documentoId: string;
  readonly url: string;
  readonly snapshotId: string;
  readonly sha256: string;
  readonly coletadoEm: string;
  readonly fonteId: string;
}

export interface LinhaEncontrada {
  readonly tabela: TabelaDisponivel;
  readonly ordem: number;
  readonly dados: Readonly<Record<string, string>>;
}

export interface CampoEncontrado {
  readonly nome: string;
  readonly caminho: string;
  readonly tipo: string | null;
  readonly minOcorrencias: number;
  readonly maxOcorrencias: string;
  readonly descricao: string | null;
  readonly arquivo: string;
  /** Versão do leiaute (pasta ou sufixo do XSD no pacote oficial), quando declarada. */
  readonly versao: string | null;
  readonly documentoId: string;
  readonly url: string;
  readonly snapshotId: string;
  readonly sha256: string;
  readonly coletadoEm: string;
  readonly fonteId: string;
}

/** Leitura do conhecimento extraído (papel `lastro_api`). Só enxerga a extração vigente de cada documento. */
export interface ConsultasConhecimento {
  buscarTrechos(filtro: FiltroBusca): Promise<TrechoEncontrado[]>;
  listarTabelas(): Promise<TabelaDisponivel[]>;
  /** `slug` null procura o código em todas as tabelas vigentes. */
  consultarReferencia(slug: string | null, codigo: string, limite: number): Promise<LinhaEncontrada[]>;
  buscarCampos(nome: string, limite: number): Promise<CampoEncontrado[]>;
}

// why: constante usual do Reciprocal Rank Fusion; amortece a diferença entre o 1º e o 5º lugar de cada lista.
const K_RRF = 60;
const CANDIDATOS_POR_LISTA = 50;
const MAX_IDENTIFICADORES = 8;

/**
 * why: identificadores ("NT 009", "cClassTrib", "indFinal", "1.05", "IBS/CBS") vão para a busca por
 * substring (trigramas), porque o dicionário português quebraria ou descartaria parte deles.
 */
export function extrairIdentificadores(consulta: string): string[] {
  const vistos = new Set<string>();
  for (const m of consulta.matchAll(/[\p{L}\d][\p{L}\d.\-/]*/gu)) {
    const termo = m[0].replace(/[.\-/]+$/, '');
    if (termo.length < 3 || termo.length > 60) continue;
    if (!/\d/.test(termo) && !/\p{Ll}\p{Lu}/u.test(termo) && !/\p{Lu}{2,}/u.test(termo)) continue;
    vistos.add(termo);
    if (vistos.size >= MAX_IDENTIFICADORES) break;
  }
  return [...vistos];
}

function escaparLike(termo: string): string {
  return termo.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function fundirRrf(listas: readonly (readonly string[])[], limite: number): { id: string; pontuacao: number }[] {
  const pontos = new Map<string, number>();
  for (const lista of listas) {
    lista.forEach((id, posicao) => pontos.set(id, (pontos.get(id) ?? 0) + 1 / (K_RRF + posicao + 1)));
  }
  return [...pontos.entries()]
    .map(([id, pontuacao]) => ({ id, pontuacao }))
    .sort((a, b) => b.pontuacao - a.pontuacao || a.id.localeCompare(b.id))
    .slice(0, limite);
}

const iso = (d: Date): string => d.toISOString();

const SELECAO_TABELA = `
  SELECT t.id, t.slug, t.titulo, t.planilha, t.colunas, t.documento_id, d.url, t.snapshot_id, s.sha256, s.coletado_em, t.fonte_id,
         (SELECT count(*)::int FROM linha_referencia l WHERE l.tabela_id = t.id) AS linhas
    FROM tabela_referencia t
    JOIN extracao_vigente x ON x.id = t.extracao_id
    JOIN snapshot s ON s.id = t.snapshot_id
    JOIN documento d ON d.id = t.documento_id`;

interface LinhaTabela {
  id: string;
  slug: string;
  titulo: string;
  planilha: string;
  colunas: string[];
  documento_id: string;
  url: string;
  snapshot_id: string;
  sha256: string;
  coletado_em: Date;
  fonte_id: string;
  linhas: number;
}

const paraTabela = (l: LinhaTabela): TabelaDisponivel => ({
  slug: l.slug,
  titulo: l.titulo,
  planilha: l.planilha,
  colunas: l.colunas,
  linhas: l.linhas,
  documentoId: l.documento_id,
  url: l.url,
  snapshotId: l.snapshot_id,
  sha256: l.sha256,
  coletadoEm: iso(l.coletado_em),
  fonteId: l.fonte_id,
});

export class ConhecimentoPostgres implements ConsultasConhecimento {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  private async listaLexica(consulta: string, fontes: readonly string[] | null): Promise<string[]> {
    // why: OU entre os radicais da pergunta, cada um pesando pelo IDF. websearch_to_tsquery exigiria todos os
    // termos no mesmo trecho (pergunta em linguagem natural quase nunca casa), e ts_rank_cd sozinho não pondera
    // raridade: "NFS-e", presente em quase todo trecho, dominava o ranking. Medido na base real (16/11/2026).
    const r = await this.pool.query<{ id: string }>(
      `WITH vigentes AS (
         SELECT t.id, t.busca FROM trecho t JOIN extracao_vigente x ON x.id = t.extracao_id
          WHERE $2::text[] IS NULL OR t.fonte_id = ANY($2)
       ), total AS (SELECT greatest(count(*), 1)::float AS n FROM vigentes),
       termos AS (
         SELECT DISTINCT quote_literal(l)::tsquery AS q FROM unnest(tsvector_to_array(to_tsvector('lastro_pt', $1))) l
       ),
       pesos AS (
         SELECT termos.q, ln(total.n / (1 + (SELECT count(*) FROM vigentes v WHERE v.busca @@ termos.q))) AS idf
           FROM termos, total
       )
       SELECT v.id
         FROM vigentes v JOIN pesos p ON v.busca @@ p.q
        GROUP BY v.id, v.busca
        ORDER BY sum(greatest(p.idf, 0)) DESC,
                 ts_rank_cd(v.busca, (SELECT string_agg(q::text, ' | ') FROM pesos)::tsquery, 32) DESC, v.id
        LIMIT $3`,
      [consulta, fontes, CANDIDATOS_POR_LISTA],
    );
    return r.rows.map((l) => l.id);
  }

  private async listaIdentificadores(termos: readonly string[], fontes: readonly string[] | null): Promise<string[]> {
    if (termos.length === 0) return [];
    const padroes = termos.map((t) => `%${escaparLike(t)}%`);
    // why: sigla presente em quase todo trecho ("NFS-e") não distingue nada; acima de 10% dos trechos (contados pelo índice de trigramas, tabela inteira) o peso é zero.
    const contagens = await this.pool.query<{ p: string; df: number; n: number }>(
      `SELECT p, (SELECT count(*)::int FROM trecho WHERE texto ILIKE p) AS df, (SELECT count(*)::int FROM trecho) AS n
         FROM unnest($1::text[]) p`,
      [padroes],
    );
    const pesos = contagens.rows
      .map((c) => ({ p: c.p, peso: Math.log(Math.max(c.n, 1) / (1 + c.df)) - Math.log(10) }))
      .filter((c) => c.peso > 0);
    if (pesos.length === 0) return [];
    const r = await this.pool.query<{ id: string }>(
      `SELECT t.id
         FROM trecho t
         JOIN extracao_vigente x ON x.id = t.extracao_id
         JOIN unnest($1::text[], $2::float8[]) AS w(p, peso) ON t.texto ILIKE w.p
        WHERE $3::text[] IS NULL OR t.fonte_id = ANY($3)
        GROUP BY t.id
        ORDER BY sum(w.peso) DESC, t.id
        LIMIT $4`,
      [pesos.map((c) => c.p), pesos.map((c) => c.peso), fontes, CANDIDATOS_POR_LISTA],
    );
    return r.rows.map((l) => l.id);
  }

  async buscarTrechos(filtro: FiltroBusca): Promise<TrechoEncontrado[]> {
    const fontes = filtro.fontes === undefined || filtro.fontes.length === 0 ? null : [...filtro.fontes];
    const [lexica, identificadores] = await Promise.all([
      this.listaLexica(filtro.consulta, fontes),
      this.listaIdentificadores(extrairIdentificadores(filtro.consulta), fontes),
    ]);
    const fundidos = fundirRrf([lexica, identificadores], filtro.limite);
    if (fundidos.length === 0) return [];
    const r = await this.pool.query<{
      id: string;
      texto: string;
      secao: string | null;
      pagina_ini: number | null;
      pagina_fim: number | null;
      snapshot_id: string;
      sha256: string;
      mime: string;
      coletado_em: Date;
      verificado_em: Date | null;
      documento_id: string;
      url: string;
      fonte_id: string;
      ultimo_evento: string | null;
    }>(
      `SELECT t.id, t.texto, t.secao, t.pagina_ini, t.pagina_fim, t.snapshot_id, s.sha256, s.mime, s.coletado_em,
              (SELECT max(v.verificado_em) FROM verificacao_coleta v WHERE v.documento_id = t.documento_id AND v.sha256 = s.sha256) AS verificado_em,
              t.documento_id, d.url, t.fonte_id,
              (SELECT e.tipo FROM evento_mudanca e WHERE e.documento_id = t.documento_id AND e.tipo NOT IN ('fato-aprovado', 'fato-corrigido') ORDER BY e.detectado_em DESC, e.id DESC LIMIT 1) AS ultimo_evento
         FROM trecho t JOIN snapshot s ON s.id = t.snapshot_id JOIN documento d ON d.id = t.documento_id
        WHERE t.id = ANY($1::uuid[])`,
      [fundidos.map((f) => f.id)],
    );
    const porId = new Map(r.rows.map((l) => [l.id, l]));
    return fundidos.flatMap(({ id, pontuacao }) => {
      const l = porId.get(id);
      if (l === undefined) return [];
      const confirmado = l.verificado_em !== null && l.verificado_em > l.coletado_em ? l.verificado_em : l.coletado_em;
      return [
        {
          id: l.id,
          texto: l.texto,
          secao: l.secao,
          paginaIni: l.pagina_ini,
          paginaFim: l.pagina_fim,
          snapshotId: l.snapshot_id,
          sha256: l.sha256,
          mime: l.mime,
          coletadoEm: iso(l.coletado_em),
          confirmadoEm: iso(confirmado),
          documentoId: l.documento_id,
          url: l.url,
          fonteId: l.fonte_id,
          documentoIndisponivel: l.ultimo_evento === 'documento-indisponivel',
          pontuacao,
        },
      ];
    });
  }

  async listarTabelas(): Promise<TabelaDisponivel[]> {
    const r = await this.pool.query<LinhaTabela>(`${SELECAO_TABELA} ORDER BY t.slug, s.coletado_em DESC`);
    return r.rows.map(paraTabela);
  }

  async consultarReferencia(slug: string | null, codigo: string, limite: number): Promise<LinhaEncontrada[]> {
    const formas = [...new Set([normalizarCodigo(codigo), normalizarCodigo(codigo).replace(/[^\p{L}\d]/gu, '')])].filter((f) => f !== '');
    if (formas.length === 0) return [];
    const r = await this.pool.query<LinhaTabela & { ordem: number; dados: Record<string, string> }>(
      `SELECT x.*, l.ordem, l.dados
         FROM (${SELECAO_TABELA} WHERE $1::text IS NULL OR t.slug = $1) x
         JOIN linha_referencia l ON l.tabela_id = x.id
        WHERE l.codigos && $2::text[]
        ORDER BY x.coletado_em DESC, l.ordem
        LIMIT $3`,
      [slug, formas, limite],
    );
    return r.rows.map((l) => ({ tabela: paraTabela(l), ordem: l.ordem, dados: l.dados }));
  }

  async buscarCampos(nome: string, limite: number): Promise<CampoEncontrado[]> {
    const r = await this.pool.query<{
      nome: string;
      caminho: string;
      tipo: string | null;
      min_ocorrencias: number;
      max_ocorrencias: string;
      descricao: string | null;
      arquivo: string;
      versao: string | null;
      documento_id: string;
      url: string;
      snapshot_id: string;
      sha256: string;
      coletado_em: Date;
      fonte_id: string;
    }>(
      `SELECT c.nome, c.caminho, c.tipo, c.min_ocorrencias, c.max_ocorrencias, c.descricao, c.arquivo, c.versao,
              c.documento_id, d.url, c.snapshot_id, s.sha256, s.coletado_em, c.fonte_id
         FROM campo_leiaute c
         JOIN extracao_vigente x ON x.id = c.extracao_id
         JOIN snapshot s ON s.id = c.snapshot_id
         JOIN documento d ON d.id = c.documento_id
        WHERE lower(c.nome) = lower($1)
        ORDER BY s.coletado_em DESC, d.url DESC, c.versao DESC NULLS LAST, c.caminho
        LIMIT $2`,
      [nome, limite],
    );
    return r.rows.map((l) => ({
      nome: l.nome,
      caminho: l.caminho,
      tipo: l.tipo,
      minOcorrencias: l.min_ocorrencias,
      maxOcorrencias: l.max_ocorrencias,
      descricao: l.descricao,
      arquivo: l.arquivo,
      versao: l.versao,
      documentoId: l.documento_id,
      url: l.url,
      snapshotId: l.snapshot_id,
      sha256: l.sha256,
      coletadoEm: iso(l.coletado_em),
      fonteId: l.fonte_id,
    }));
  }
}
