import { linhaPublicada, type LinhaAliquotaIss } from '@lastro/parsers';
import type pg from 'pg';

export interface TabelaAliquotasVigente {
  readonly extracaoId: string;
  readonly snapshotId: string;
  readonly documentoId: string;
  readonly fonteId: string;
  /** Data de extração declarada no nome do pacote oficial (AAAA-MM-DD). */
  readonly dataReferencia: string | null;
  readonly linhas: number;
  readonly recusadas: number;
  readonly arquivos: readonly string[];
  readonly url: string;
  readonly sha256: string;
  readonly coletadoEm: string;
  /** Última coleta que confirmou que este pacote ainda era o publicado. */
  readonly confirmadoEm: string;
}

export interface MunicipioTabela {
  readonly codigoIbge: string;
  readonly uf: string;
  readonly nome: string;
}

export interface AliquotaEncontrada {
  readonly codigoIbge: string;
  readonly codigoServico: string;
  readonly incidencia: string;
  /** Como publicado (vírgula decimal); null quando a célula está vazia. */
  readonly aliquota: string | null;
  readonly inicio: string;
  readonly fim: string | null;
  readonly arquivo: string;
  readonly linha: number;
  /** A linha exatamente como está no CSV oficial (texto citado). */
  readonly textoPublicado: string;
}

export interface FiltroMunicipios {
  readonly nome?: string | undefined;
  readonly uf?: string | undefined;
  readonly codigoIbge?: string | undefined;
  readonly limite: number;
}

/** Leitura da tabela oficial de alíquotas de ISSQN (papel `lastro_api`); só enxerga o pacote vigente. */
export interface ConsultasIss {
  tabelaVigente(): Promise<TabelaAliquotasVigente | undefined>;
  /** Todos os municípios do pacote, para identificar o município citado numa pergunta. */
  municipios(extracaoId: string): Promise<MunicipioTabela[]>;
  buscarMunicipios(extracaoId: string, filtro: FiltroMunicipios): Promise<MunicipioTabela[]>;
  /** `prefixosServico` null traz todos os códigos do município. */
  aliquotas(extracaoId: string, codigoIbge: string, prefixosServico: readonly string[] | null, limite: number): Promise<AliquotaEncontrada[]>;
}

const iso = (d: Date): string => d.toISOString();
const dia = (d: Date | string | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
// why: prefixo vem de normalizarCodigoServico (só dígitos e pontos), mas o escape impede que um chamador futuro use % ou _ como curinga.
const escaparLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class IssPostgres implements ConsultasIss {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async tabelaVigente(): Promise<TabelaAliquotasVigente | undefined> {
    // hazard: o driver converte `date` para Date no fuso local; to_char devolve o dia como está no banco.
    const r = await this.pool.query<{
      extracao_id: string;
      snapshot_id: string;
      documento_id: string;
      fonte_id: string;
      data_referencia: string | null;
      linhas: number;
      recusadas: number;
      arquivos: string[];
      url: string;
      sha256: string;
      coletado_em: Date;
      verificado_em: Date | null;
    }>(
      `SELECT extracao_id, snapshot_id, documento_id, fonte_id, to_char(data_referencia, 'YYYY-MM-DD') AS data_referencia,
              linhas, recusadas, arquivos, url, sha256, coletado_em, verificado_em
         FROM tabela_aliquota_iss_vigente`,
    );
    const l = r.rows[0];
    if (l === undefined) return undefined;
    const confirmado = l.verificado_em !== null && l.verificado_em > l.coletado_em ? l.verificado_em : l.coletado_em;
    return {
      extracaoId: l.extracao_id,
      snapshotId: l.snapshot_id,
      documentoId: l.documento_id,
      fonteId: l.fonte_id,
      dataReferencia: l.data_referencia,
      linhas: l.linhas,
      recusadas: l.recusadas,
      arquivos: l.arquivos,
      url: l.url,
      sha256: l.sha256,
      coletadoEm: iso(l.coletado_em),
      confirmadoEm: iso(confirmado),
    };
  }

  async municipios(extracaoId: string): Promise<MunicipioTabela[]> {
    const r = await this.pool.query<{ codigo_ibge: string; uf: string; nome: string }>(
      'SELECT codigo_ibge, uf, nome FROM municipio_iss WHERE extracao_id = $1 ORDER BY codigo_ibge',
      [extracaoId],
    );
    return r.rows.map((l) => ({ codigoIbge: l.codigo_ibge, uf: l.uf, nome: l.nome }));
  }

  async buscarMunicipios(extracaoId: string, filtro: FiltroMunicipios): Promise<MunicipioTabela[]> {
    const nome = filtro.nome === undefined ? null : `${escaparLike(filtro.nome.trim())}%`;
    const r = await this.pool.query<{ codigo_ibge: string; uf: string; nome: string }>(
      `SELECT codigo_ibge, uf, nome FROM municipio_iss
        WHERE extracao_id = $1
          AND ($2::text IS NULL OR unaccent(lower(nome)) LIKE unaccent(lower($2)))
          AND ($3::text IS NULL OR uf = $3)
          AND ($4::text IS NULL OR codigo_ibge = $4)
        ORDER BY nome, uf
        LIMIT $5`,
      [extracaoId, nome, filtro.uf ?? null, filtro.codigoIbge ?? null, filtro.limite],
    );
    return r.rows.map((l) => ({ codigoIbge: l.codigo_ibge, uf: l.uf, nome: l.nome }));
  }

  async aliquotas(extracaoId: string, codigoIbge: string, prefixosServico: readonly string[] | null, limite: number): Promise<AliquotaEncontrada[]> {
    const padroes = prefixosServico === null ? null : prefixosServico.map((p) => `${escaparLike(p)}%`);
    const r = await this.pool.query<{
      codigo_ibge: string;
      codigo_servico: string;
      incidencia: string;
      aliquota: string | null;
      inicio: string;
      fim: string | null;
      arquivo: string;
      linha: number;
      uf: string;
      nome: string;
    }>(
      `SELECT a.codigo_ibge, a.codigo_servico, a.incidencia, a.aliquota, to_char(a.inicio, 'YYYY-MM-DD') AS inicio,
              to_char(a.fim, 'YYYY-MM-DD') AS fim, a.arquivo, a.linha, m.uf, m.nome
         FROM aliquota_iss a
         JOIN municipio_iss m ON m.extracao_id = a.extracao_id AND m.codigo_ibge = a.codigo_ibge
        WHERE a.extracao_id = $1 AND a.codigo_ibge = $2
          AND ($3::text[] IS NULL OR a.codigo_servico LIKE ANY ($3))
        ORDER BY a.codigo_servico, a.inicio, a.linha
        LIMIT $4`,
      [extracaoId, codigoIbge, padroes, limite],
    );
    return r.rows.map((l) => {
      const linha: LinhaAliquotaIss = {
        codigoIbge: l.codigo_ibge,
        codigoServico: l.codigo_servico,
        incidencia: l.incidencia,
        aliquota: l.aliquota,
        inicio: dia(l.inicio) ?? '',
        fim: dia(l.fim),
        arquivo: l.arquivo,
        linha: l.linha,
      };
      return { ...linha, textoPublicado: linhaPublicada(linha, { codigoIbge: l.codigo_ibge, uf: l.uf, nome: l.nome }) };
    });
  }
}
