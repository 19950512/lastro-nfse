import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { comCliente, type Canal } from './clientes.ts';

export interface NovaVerificacao {
  readonly canal: Canal;
  /** Texto já minimizado (CPF, CNPJ, e-mail e telefone mascarados). */
  readonly entrada: string;
  readonly resultado: unknown;
  readonly fatos: readonly string[];
  readonly relacoes: readonly string[];
  readonly trechos: readonly string[];
}

export interface VerificacaoSalva {
  readonly id: string;
  readonly criadaEm: string;
  readonly expiraEm: string;
  readonly entrada: string;
  readonly resultado: unknown;
  readonly fatos: readonly string[];
  readonly relacoes: readonly string[];
  readonly compartilhada: boolean;
}

export interface VerificacaoCompartilhada {
  readonly id: string;
  readonly criadaEm: string;
  readonly expiraEm: string;
  readonly resultado: unknown;
  readonly fatos: readonly string[];
  readonly relacoes: readonly string[];
}

/** Verificações por cliente (papel `lastro_api`, RLS em `verificacao`) e leitura pública por token. */
export interface RepositorioVerificacoes {
  registrar(clienteId: string, chaveId: string | null, nova: NovaVerificacao): Promise<{ id: string; criadaEm: string; expiraEm: string }>;
  obter(clienteId: string, id: string): Promise<VerificacaoSalva | undefined>;
  /** Gera um token novo (o anterior deixa de valer) e devolve o token, que não fica guardado. */
  compartilhar(clienteId: string, id: string): Promise<string | undefined>;
  revogarCompartilhamento(clienteId: string, id: string): Promise<boolean>;
  obterCompartilhada(token: string): Promise<VerificacaoCompartilhada | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const FORMATO_TOKEN_COMPARTILHAMENTO = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const uuids = (lista: readonly string[]): string[] => [...new Set(lista.filter((i) => UUID.test(i)))];

export class VerificacoesPostgres implements RepositorioVerificacoes {
  private readonly pool: pg.Pool;
  private readonly retencaoDias: number;

  constructor(pool: pg.Pool, retencaoDias = 30) {
    this.pool = pool;
    this.retencaoDias = retencaoDias;
  }

  registrar(clienteId: string, chaveId: string | null, nova: NovaVerificacao): Promise<{ id: string; criadaEm: string; expiraEm: string }> {
    return comCliente(this.pool, clienteId, async (c) => {
      const r = await c.query<{ id: string; criada_em: Date; expira_em: Date }>(
        `INSERT INTO verificacao (cliente_id, chave_id, canal, entrada, resultado, fatos, relacoes, trechos, expira_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9)) RETURNING id, criada_em, expira_em`,
        [clienteId, chaveId, nova.canal, nova.entrada, JSON.stringify(nova.resultado), uuids(nova.fatos), uuids(nova.relacoes), uuids(nova.trechos), this.retencaoDias],
      );
      const l = r.rows[0];
      if (l === undefined) throw new Error('INSERT de verificação sem retorno');
      return { id: l.id, criadaEm: l.criada_em.toISOString(), expiraEm: l.expira_em.toISOString() };
    });
  }

  async obter(clienteId: string, id: string): Promise<VerificacaoSalva | undefined> {
    if (!UUID.test(id)) return undefined;
    return comCliente(this.pool, clienteId, async (c) => {
      const r = await c.query<{
        id: string;
        criada_em: Date;
        expira_em: Date;
        entrada: string;
        resultado: unknown;
        fatos: string[];
        relacoes: string[];
        compartilhada: boolean;
      }>(
        `SELECT id, criada_em, expira_em, entrada, resultado, fatos, relacoes, compartilhamento IS NOT NULL AS compartilhada
           FROM verificacao WHERE id = $1 AND cliente_id = $2 AND expira_em > now()`,
        [id, clienteId],
      );
      const l = r.rows[0];
      return l === undefined
        ? undefined
        : {
            id: l.id,
            criadaEm: l.criada_em.toISOString(),
            expiraEm: l.expira_em.toISOString(),
            entrada: l.entrada,
            resultado: l.resultado,
            fatos: l.fatos,
            relacoes: l.relacoes,
            compartilhada: l.compartilhada,
          };
    });
  }

  async compartilhar(clienteId: string, id: string): Promise<string | undefined> {
    if (!UUID.test(id)) return undefined;
    const token = randomBytes(32).toString('base64url');
    const atualizadas = await comCliente(this.pool, clienteId, async (c) =>
      (
        await c.query(
          'UPDATE verificacao SET compartilhamento = $3, compartilhada_em = now() WHERE id = $1 AND cliente_id = $2 AND expira_em > now()',
          [id, clienteId, hashToken(token)],
        )
      ).rowCount,
    );
    return atualizadas === 1 ? token : undefined;
  }

  async revogarCompartilhamento(clienteId: string, id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    return comCliente(this.pool, clienteId, async (c) => {
      const r = await c.query(
        'UPDATE verificacao SET compartilhamento = NULL, compartilhada_em = NULL WHERE id = $1 AND cliente_id = $2 AND compartilhamento IS NOT NULL',
        [id, clienteId],
      );
      return r.rowCount === 1;
    });
  }

  async obterCompartilhada(token: string): Promise<VerificacaoCompartilhada | undefined> {
    if (!FORMATO_TOKEN_COMPARTILHAMENTO.test(token)) return undefined;
    const r = await this.pool.query<{ id: string; resultado: unknown; fatos: string[]; relacoes: string[]; criada_em: Date; expira_em: Date }>(
      'SELECT * FROM verificacao_compartilhada($1)',
      [hashToken(token)],
    );
    const l = r.rows[0];
    return l === undefined
      ? undefined
      : { id: l.id, criadaEm: l.criada_em.toISOString(), expiraEm: l.expira_em.toISOString(), resultado: l.resultado, fatos: l.fatos, relacoes: l.relacoes };
  }
}

/** Apaga verificações vencidas (LGPD); o link compartilhado deixa de existir junto. Papel admin. */
export async function expurgarVerificacoes(admin: pg.Pool, agora: Date = new Date()): Promise<number> {
  const r = await admin.query('DELETE FROM verificacao WHERE expira_em <= $1', [agora]);
  return r.rowCount ?? 0;
}
