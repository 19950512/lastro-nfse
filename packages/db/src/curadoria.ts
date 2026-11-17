import type { TipoRelacao } from '@lastro/normas';
import pg from 'pg';
import type { FatoParaGravar, TipoFato } from './normativo.ts';

export type PapelCurador = 'curador' | 'supervisor';
export type TipoProposta = 'fato' | 'relacao';
export type SituacaoCuradoria = 'proposto' | 'aprovado' | 'rejeitado' | 'revogado' | 'superado';
export const SITUACOES_CURADORIA: readonly SituacaoCuradoria[] = ['proposto', 'aprovado', 'rejeitado', 'revogado', 'superado'];

export interface Curador {
  readonly id: string;
  readonly nome: string;
  readonly papel: PapelCurador;
}

export interface SessaoCurador {
  readonly curador: Curador;
  readonly amr: readonly string[];
  readonly expiraEm: string;
}

export interface TrechoCuradoria {
  readonly id: string;
  readonly texto: string;
  readonly secao: string | null;
  readonly paginaIni: number | null;
  readonly documentoId: string;
  readonly snapshotId: string;
  readonly url: string;
  readonly fonteId: string;
  readonly sha256: string;
  readonly coletadoEm: string;
  /** false quando o documento já tem versão mais nova: o trecho não está mais no índice. */
  readonly vigente: boolean;
}

export interface PropostaResumo {
  readonly tipo: TipoProposta;
  readonly id: string;
  readonly situacao: SituacaoCuradoria;
  readonly titulo: string;
  readonly extrator: string;
  readonly propostoEm: string;
  readonly propostoPor: string | null;
  readonly souProponente: boolean;
  readonly aprovacoes: number;
  readonly jaDecidi: boolean;
  readonly url: string;
  readonly fonteId: string;
  readonly evidenciaTexto: string;
  readonly evidenciaAtual: boolean;
}

export interface DecisaoRegistrada {
  readonly curador: string;
  readonly decisao: 'aprovar' | 'rejeitar' | 'revogar';
  readonly motivo: string | null;
  readonly decididaEm: string;
}

export interface DetalheFato {
  readonly tipo: TipoFato;
  readonly tema: string;
  readonly enunciado: string;
  readonly publico: string | null;
  readonly dataEfeito: string | null;
  readonly substitui: string | null;
}

export interface DetalheRelacao {
  readonly tipo: TipoRelacao;
  readonly origemUrl: string;
  readonly origemTitulo: string | null;
  readonly destinoDescricao: string;
  readonly destinoChave: string | null;
  readonly destinoUrl: string | null;
  readonly dispositivo: string | null;
  readonly efeitoEm: string | null;
}

export interface PropostaDetalhe extends PropostaResumo {
  readonly trecho: TrechoCuradoria;
  readonly decisoes: readonly DecisaoRegistrada[];
  readonly fato: DetalheFato | null;
  readonly relacao: DetalheRelacao | null;
}

export type CodigoErroCuradoria = 'nao-permitido' | 'conflito' | 'invalido';

/** Regra de curadoria recusada pelo banco (segunda camada do RBAC); a mensagem é nossa, segura para mostrar. */
export class ErroCuradoria extends Error {
  readonly codigo: CodigoErroCuradoria;
  constructor(codigo: CodigoErroCuradoria, mensagem: string) {
    super(mensagem);
    this.name = 'ErroCuradoria';
    this.codigo = codigo;
  }
}

export interface RepositorioCuradoria {
  curadorPorIdentidade(emissor: string, sujeito: string): Promise<Curador | undefined>;
  iniciarLogin(login: { hashEstado: string; nonce: string; verificador: string; expiraEm: Date }): Promise<void>;
  /** Uso único: o registro some na leitura. */
  consumirLogin(hashEstado: string): Promise<{ nonce: string; verificador: string } | undefined>;
  criarSessao(sessao: { hash: string; curadorId: string; amr: readonly string[]; expiraEm: Date }): Promise<void>;
  obterSessao(hash: string): Promise<SessaoCurador | undefined>;
  encerrarSessao(hash: string): Promise<void>;
  listarPropostas(curadorId: string, filtro: { tipo: TipoProposta; situacao: SituacaoCuradoria; limite: number }): Promise<PropostaResumo[]>;
  obterProposta(curadorId: string, tipo: TipoProposta, id: string): Promise<PropostaDetalhe | undefined>;
  decidir(curadorId: string, tipo: TipoProposta, id: string, decisao: 'aprovar' | 'rejeitar', motivo: string | null): Promise<void>;
  obterTrecho(id: string): Promise<TrechoCuradoria | undefined>;
  proporFato(curadorId: string, fato: FatoParaGravar & { readonly substitui: string | null }): Promise<string>;
  recall(curadorId: string, fatoId: string, motivo: string): Promise<{ verificacoes: number; consultas: number }>;
  usoDoFato(fatoId: string): Promise<{ verificacoes: number; consultas: number }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const iso = (d: Date): string => d.toISOString();
const data = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

function traduzirErro(erro: unknown): never {
  if (erro instanceof pg.DatabaseError) {
    // why: as mensagens de RAISE das funções de curadoria são nossas e descrevem a regra; as do Postgres (nomes de
    // constraint, colunas) não saem para a tela.
    const nossa = erro.where?.includes('at RAISE') === true;
    if (erro.code === '42501') throw new ErroCuradoria('nao-permitido', nossa ? erro.message : 'operação não permitida');
    if (erro.code === '23505') throw new ErroCuradoria('conflito', 'decisão já registrada para este curador');
    if (erro.code === '23514') throw new ErroCuradoria(nossa ? 'conflito' : 'invalido', nossa ? erro.message : 'dados fora das regras');
    if (erro.code === '23503' || erro.code === '22P02' || erro.code === '22007' || erro.code === '22008') throw new ErroCuradoria('invalido', 'referência ou valor inválido');
  }
  throw erro;
}

async function comCurador<T>(pool: pg.Pool, curadorId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // invariant: o banco confere que a decisão/proposta é do curador desta transação (triggers checar_decisao e exigir_proponente).
    await c.query("SELECT set_config('lastro.curador_id', $1, true)", [curadorId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (erro) {
    await c.query('ROLLBACK').catch(() => undefined);
    return traduzirErro(erro);
  } finally {
    c.release();
  }
}

const SELECAO_TRECHO = `
  SELECT t.id, t.texto, t.secao, t.pagina_ini, t.documento_id, t.snapshot_id, d.url, t.fonte_id, s.sha256, s.coletado_em,
         EXISTS (SELECT 1 FROM extracao_vigente x WHERE x.id = t.extracao_id) AS vigente
    FROM trecho t JOIN documento d ON d.id = t.documento_id JOIN snapshot s ON s.id = t.snapshot_id`;

interface LinhaTrecho {
  id: string;
  texto: string;
  secao: string | null;
  pagina_ini: number | null;
  documento_id: string;
  snapshot_id: string;
  url: string;
  fonte_id: string;
  sha256: string;
  coletado_em: Date;
  vigente: boolean;
}

const paraTrecho = (l: LinhaTrecho): TrechoCuradoria => ({
  id: l.id,
  texto: l.texto,
  secao: l.secao,
  paginaIni: l.pagina_ini,
  documentoId: l.documento_id,
  snapshotId: l.snapshot_id,
  url: l.url,
  fonteId: l.fonte_id,
  sha256: l.sha256,
  coletadoEm: iso(l.coletado_em),
  vigente: l.vigente,
});

interface LinhaProposta {
  id: string;
  situacao: SituacaoCuradoria;
  titulo: string;
  extrator: string;
  proposto_em: Date;
  proposto_por: string | null;
  proposto_por_nome: string | null;
  aprovacoes: number;
  ja_decidi: boolean;
  url: string;
  fonte_id: string;
  evidencia_texto: string;
  evidencia_atual: boolean;
  evidencia_trecho_id: string;
}

function selecaoPropostas(tipo: TipoProposta): string {
  const [visao, coluna, titulo] =
    tipo === 'fato'
      ? ['fato_curadoria', 'fato_id', 'p.enunciado']
      : ['relacao_curadoria', 'relacao_id', "p.tipo || ': ' || p.destino_descricao || coalesce(' — ' || p.dispositivo, '')"];
  return `
    SELECT p.id, p.situacao, ${titulo} AS titulo, p.extrator, p.proposto_em, p.proposto_por, c.nome AS proposto_por_nome,
           (SELECT count(*)::int FROM decisao_curadoria d WHERE d.${coluna} = p.id AND d.decisao = 'aprovar') AS aprovacoes,
           EXISTS (SELECT 1 FROM decisao_curadoria d WHERE d.${coluna} = p.id AND d.curador_id = $1) AS ja_decidi,
           doc.url, t.fonte_id, p.evidencia_texto, p.evidencia_atual, p.evidencia_trecho_id
      FROM ${visao} p
      LEFT JOIN curador c ON c.id = p.proposto_por
      JOIN trecho t ON t.id = p.evidencia_trecho_id
      JOIN documento doc ON doc.id = t.documento_id`;
}

const paraResumo = (tipo: TipoProposta, curadorId: string, l: LinhaProposta): PropostaResumo => ({
  tipo,
  id: l.id,
  situacao: l.situacao,
  titulo: l.titulo,
  extrator: l.extrator,
  propostoEm: iso(l.proposto_em),
  propostoPor: l.proposto_por_nome,
  souProponente: l.proposto_por === curadorId,
  aprovacoes: l.aprovacoes,
  jaDecidi: l.ja_decidi,
  url: l.url,
  fonteId: l.fonte_id,
  evidenciaTexto: l.evidencia_texto,
  evidenciaAtual: l.evidencia_atual,
});

export class CuradoriaPostgres implements RepositorioCuradoria {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async curadorPorIdentidade(emissor: string, sujeito: string): Promise<Curador | undefined> {
    const r = await this.pool.query<Curador>('SELECT id, nome, papel FROM curador WHERE emissor = $1 AND sujeito = $2 AND ativo', [emissor, sujeito]);
    return r.rows[0];
  }

  async iniciarLogin(l: { hashEstado: string; nonce: string; verificador: string; expiraEm: Date }): Promise<void> {
    await this.pool.query('DELETE FROM login_oidc WHERE expira_em <= now()');
    await this.pool.query('INSERT INTO login_oidc (hash_estado, nonce, verificador, expira_em) VALUES ($1, $2, $3, $4)', [l.hashEstado, l.nonce, l.verificador, l.expiraEm]);
  }

  async consumirLogin(hashEstado: string): Promise<{ nonce: string; verificador: string } | undefined> {
    if (!HASH.test(hashEstado)) return undefined;
    const r = await this.pool.query<{ nonce: string; verificador: string }>(
      'DELETE FROM login_oidc WHERE hash_estado = $1 AND expira_em > now() RETURNING nonce, verificador',
      [hashEstado],
    );
    return r.rows[0];
  }

  async criarSessao(s: { hash: string; curadorId: string; amr: readonly string[]; expiraEm: Date }): Promise<void> {
    await this.pool.query('DELETE FROM sessao_curador WHERE expira_em <= now()');
    await this.pool.query('INSERT INTO sessao_curador (hash, curador_id, amr, expira_em) VALUES ($1, $2, $3, $4)', [s.hash, s.curadorId, [...s.amr], s.expiraEm]);
  }

  async obterSessao(hash: string): Promise<SessaoCurador | undefined> {
    if (!HASH.test(hash)) return undefined;
    const r = await this.pool.query<{ id: string; nome: string; papel: PapelCurador; amr: string[]; expira_em: Date }>(
      `SELECT c.id, c.nome, c.papel, s.amr, s.expira_em FROM sessao_curador s JOIN curador c ON c.id = s.curador_id
        WHERE s.hash = $1 AND s.expira_em > now() AND c.ativo`,
      [hash],
    );
    const l = r.rows[0];
    return l === undefined ? undefined : { curador: { id: l.id, nome: l.nome, papel: l.papel }, amr: l.amr, expiraEm: iso(l.expira_em) };
  }

  async encerrarSessao(hash: string): Promise<void> {
    if (HASH.test(hash)) await this.pool.query('DELETE FROM sessao_curador WHERE hash = $1', [hash]);
  }

  async listarPropostas(curadorId: string, f: { tipo: TipoProposta; situacao: SituacaoCuradoria; limite: number }): Promise<PropostaResumo[]> {
    const r = await this.pool.query<LinhaProposta>(`${selecaoPropostas(f.tipo)} WHERE p.situacao = $2 ORDER BY p.proposto_em, p.id LIMIT $3`, [
      curadorId,
      f.situacao,
      f.limite,
    ]);
    return r.rows.map((l) => paraResumo(f.tipo, curadorId, l));
  }

  async obterProposta(curadorId: string, tipo: TipoProposta, id: string): Promise<PropostaDetalhe | undefined> {
    if (!UUID.test(id)) return undefined;
    const r = await this.pool.query<LinhaProposta>(`${selecaoPropostas(tipo)} WHERE p.id = $2`, [curadorId, id]);
    const l = r.rows[0];
    if (l === undefined) return undefined;
    const trecho = await this.obterTrecho(l.evidencia_trecho_id);
    if (trecho === undefined) return undefined;
    const coluna = tipo === 'fato' ? 'fato_id' : 'relacao_id';
    const decisoes = await this.pool.query<{ nome: string; decisao: DecisaoRegistrada['decisao']; motivo: string | null; decidida_em: Date }>(
      `SELECT c.nome, d.decisao, d.motivo, d.decidida_em FROM decisao_curadoria d JOIN curador c ON c.id = d.curador_id
        WHERE d.${coluna} = $1 ORDER BY d.decidida_em`,
      [id],
    );
    let fato: DetalheFato | null = null;
    let relacao: DetalheRelacao | null = null;
    if (tipo === 'fato') {
      const f = await this.pool.query<{ tipo: TipoFato; tema: string; enunciado: string; publico: string | null; data_efeito: Date | null; substitui: string | null }>(
        'SELECT tipo, tema, enunciado, publico, data_efeito, substitui FROM fato WHERE id = $1',
        [id],
      );
      const x = f.rows[0];
      if (x !== undefined) fato = { tipo: x.tipo, tema: x.tema, enunciado: x.enunciado, publico: x.publico, dataEfeito: data(x.data_efeito), substitui: x.substitui };
    } else {
      const q = await this.pool.query<{
        tipo: TipoRelacao;
        origem_url: string;
        origem_titulo: string | null;
        destino_descricao: string;
        destino_chave: string | null;
        destino_url: string | null;
        dispositivo: string | null;
        efeito_em: Date | null;
      }>(
        `SELECT r.tipo, o.url AS origem_url, a.titulo AS origem_titulo, r.destino_descricao, r.destino_chave, dd.url AS destino_url, r.dispositivo, r.efeito_em
           FROM relacao_curadoria r JOIN documento o ON o.id = r.origem_documento_id
           LEFT JOIN ato_vigente a ON a.documento_id = r.origem_documento_id
           LEFT JOIN documento dd ON dd.id = r.destino_resolvido
          WHERE r.id = $1`,
        [id],
      );
      const x = q.rows[0];
      if (x !== undefined) {
        relacao = {
          tipo: x.tipo,
          origemUrl: x.origem_url,
          origemTitulo: x.origem_titulo,
          destinoDescricao: x.destino_descricao,
          destinoChave: x.destino_chave,
          destinoUrl: x.destino_url,
          dispositivo: x.dispositivo,
          efeitoEm: data(x.efeito_em),
        };
      }
    }
    return {
      ...paraResumo(tipo, curadorId, l),
      trecho,
      decisoes: decisoes.rows.map((d) => ({ curador: d.nome, decisao: d.decisao, motivo: d.motivo, decididaEm: iso(d.decidida_em) })),
      fato,
      relacao,
    };
  }

  async decidir(curadorId: string, tipo: TipoProposta, id: string, decisao: 'aprovar' | 'rejeitar', motivo: string | null): Promise<void> {
    if (!UUID.test(id)) throw new ErroCuradoria('invalido', 'proposta inválida');
    await comCurador(this.pool, curadorId, (c) =>
      c.query(`INSERT INTO decisao_curadoria (${tipo === 'fato' ? 'fato_id' : 'relacao_id'}, curador_id, decisao, motivo) VALUES ($1, $2, $3, $4)`, [
        id,
        curadorId,
        decisao,
        motivo,
      ]),
    );
  }

  async obterTrecho(id: string): Promise<TrechoCuradoria | undefined> {
    if (!UUID.test(id)) return undefined;
    const r = await this.pool.query<LinhaTrecho>(`${SELECAO_TRECHO} WHERE t.id = $1`, [id]);
    const l = r.rows[0];
    return l === undefined ? undefined : paraTrecho(l);
  }

  async proporFato(curadorId: string, f: FatoParaGravar & { readonly substitui: string | null }): Promise<string> {
    return comCurador(this.pool, curadorId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO fato (tipo, tema, enunciado, publico, data_efeito, evidencia_trecho_id, evidencia_texto, substitui, extrator, proposto_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'curador', $9) RETURNING id`,
        [f.tipo, f.tema, f.enunciado, f.publico, f.dataEfeito, f.evidenciaTrechoId, f.evidenciaTexto, f.substitui, curadorId],
      );
      const id = r.rows[0]?.id;
      if (id === undefined) throw new Error('INSERT de fato sem retorno');
      return id;
    });
  }

  async recall(curadorId: string, fatoId: string, motivo: string): Promise<{ verificacoes: number; consultas: number }> {
    if (!UUID.test(fatoId)) throw new ErroCuradoria('invalido', 'fato inválido');
    return comCurador(this.pool, curadorId, async (c) => {
      const r = await c.query<{ verificacoes: string; consultas: string }>('SELECT * FROM registrar_recall($1, $2, $3)', [fatoId, curadorId, motivo]);
      return { verificacoes: Number(r.rows[0]?.verificacoes ?? 0), consultas: Number(r.rows[0]?.consultas ?? 0) };
    });
  }

  async usoDoFato(fatoId: string): Promise<{ verificacoes: number; consultas: number }> {
    if (!UUID.test(fatoId)) return { verificacoes: 0, consultas: 0 };
    const r = await this.pool.query<{ verificacoes: string; consultas: string }>('SELECT * FROM uso_do_fato($1)', [fatoId]);
    return { verificacoes: Number(r.rows[0]?.verificacoes ?? 0), consultas: Number(r.rows[0]?.consultas ?? 0) };
  }
}

/** CLI (papel admin): cadastro de curadores a partir da identidade do SSO. */
export async function criarCurador(admin: pg.Pool, c: { emissor: string; sujeito: string; nome: string; papel: PapelCurador }): Promise<string> {
  const r = await admin.query<{ id: string }>('INSERT INTO curador (emissor, sujeito, nome, papel) VALUES ($1, $2, $3, $4) RETURNING id', [
    c.emissor,
    c.sujeito,
    c.nome,
    c.papel,
  ]);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('INSERT de curador sem retorno');
  return id;
}

export async function listarCuradores(admin: pg.Pool): Promise<{ id: string; nome: string; papel: PapelCurador; ativo: boolean; emissor: string; sujeito: string }[]> {
  const r = await admin.query<{ id: string; nome: string; papel: PapelCurador; ativo: boolean; emissor: string; sujeito: string }>(
    'SELECT id, nome, papel, ativo, emissor, sujeito FROM curador ORDER BY criado_em',
  );
  return r.rows;
}

/** Desativa o curador e derruba as sessões dele na hora. */
export async function desativarCurador(admin: pg.Pool, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const r = await admin.query('UPDATE curador SET ativo = false WHERE id = $1 AND ativo', [id]);
  await admin.query('DELETE FROM sessao_curador WHERE curador_id = $1', [id]);
  return r.rowCount === 1;
}
