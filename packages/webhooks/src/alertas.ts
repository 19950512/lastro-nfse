import { comCliente } from '@lastro/db';
import type pg from 'pg';
import { gerarSegredo } from './assinatura.ts';
import { ErroAssinatura, validarDestino, type Resolvedor } from './assinaturas.ts';
import type { FormatoWebhook } from './payload.ts';

export interface NovoAlerta {
  readonly nome: string;
  readonly url: string;
  readonly formato: FormatoWebhook;
  readonly fontes?: readonly string[] | undefined;
  readonly tipos?: readonly string[] | undefined;
  /** Palavras ou expressões procuradas no texto que mudou (busca em português, sem acento). */
  readonly termos?: readonly string[] | undefined;
  /** Temas de fatos curados (ex.: `cronograma-ibs-cbs`). */
  readonly temas?: readonly string[] | undefined;
}

export interface Alerta {
  readonly id: string;
  readonly nome: string;
  readonly url: string;
  readonly formato: FormatoWebhook;
  readonly fontes: readonly string[] | null;
  readonly tipos: readonly string[] | null;
  readonly termos: readonly string[] | null;
  readonly temas: readonly string[] | null;
  readonly ativo: boolean;
  readonly criadoEm: string;
  readonly falhasConsecutivas: number;
  readonly motivoDesativacao: string | null;
}

export class ErroLimiteAlertas extends Error {
  readonly maximo: number;
  constructor(maximo: number) {
    super(`limite de ${String(maximo)} alertas ativos do plano atingido`);
    this.name = 'ErroLimiteAlertas';
    this.maximo = maximo;
  }
}

/** Alertas por tema do próprio cliente (papel `lastro_api`, RLS em `webhook_assinatura`). */
export interface RepositorioAlertas {
  criar(clienteId: string, novo: NovoAlerta, maxAlertas: number): Promise<{ id: string; segredo: string }>;
  listar(clienteId: string): Promise<Alerta[]>;
  remover(clienteId: string, id: string): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEMA = /^[a-z0-9-]{2,80}$/;
export const MAX_TERMOS = 20;

function normalizarTermos(termos: readonly string[] | undefined): string[] | null {
  const limpos = [...new Set((termos ?? []).map((t) => t.trim().replace(/\s+/g, ' ')).filter((t) => t !== ''))];
  if (limpos.length > MAX_TERMOS) throw new ErroAssinatura(`no máximo ${String(MAX_TERMOS)} termos`);
  const ruim = limpos.find((t) => t.length < 2 || t.length > 100);
  if (ruim !== undefined) throw new ErroAssinatura('cada termo precisa ter de 2 a 100 caracteres');
  return limpos.length === 0 ? null : limpos;
}

function normalizarTemas(temas: readonly string[] | undefined): string[] | null {
  const limpos = [...new Set(temas ?? [])];
  if (limpos.length > MAX_TERMOS) throw new ErroAssinatura(`no máximo ${String(MAX_TERMOS)} temas`);
  if (limpos.some((t) => !TEMA.test(t))) throw new ErroAssinatura('tema: minúsculas, dígitos e hífen (2 a 80)');
  return limpos.length === 0 ? null : limpos;
}

interface LinhaAlerta {
  id: string;
  nome: string;
  url: string;
  formato: FormatoWebhook;
  fontes: string[] | null;
  tipos: string[] | null;
  termos: string[] | null;
  temas: string[] | null;
  ativa: boolean;
  criada_em: Date;
  falhas_consecutivas: number;
  motivo_desativacao: string | null;
}

export class AlertasPostgres implements RepositorioAlertas {
  private readonly pool: pg.Pool;
  private readonly idsFontes: ReadonlySet<string>;
  private readonly resolver: Resolvedor | undefined;

  constructor(pool: pg.Pool, idsFontes: ReadonlySet<string>, resolver?: Resolvedor) {
    this.pool = pool;
    this.idsFontes = idsFontes;
    this.resolver = resolver;
  }

  async criar(clienteId: string, novo: NovoAlerta, maxAlertas: number): Promise<{ id: string; segredo: string }> {
    const nome = novo.nome.trim();
    if (nome.length < 1 || nome.length > 120) throw new ErroAssinatura('nome do alerta: 1 a 120 caracteres');
    const termos = normalizarTermos(novo.termos);
    const temas = normalizarTemas(novo.temas);
    const destino = await validarDestino(novo, this.idsFontes, this.resolver);
    const segredo = gerarSegredo();
    return comCliente(this.pool, clienteId, async (c) => {
      // invariant: a trava por cliente serializa cadastros simultâneos; sem ela, dois pedidos juntos passariam do limite do plano.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`alertas:${clienteId}`]);
      const ativos = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_assinatura WHERE cliente_id = $1 AND ativa', [clienteId]);
      if ((ativos.rows[0]?.n ?? 0) >= maxAlertas) throw new ErroLimiteAlertas(maxAlertas);
      const r = await c.query<{ id: string }>(
        `INSERT INTO webhook_assinatura (cliente_id, nome, url, formato, segredo, fontes, tipos, termos, temas)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [clienteId, nome, destino.url, novo.formato, segredo, destino.fontes, destino.tipos, termos, temas],
      );
      const id = r.rows[0]?.id;
      if (id === undefined) throw new ErroAssinatura('INSERT sem retorno');
      return { id, segredo };
    });
  }

  async listar(clienteId: string): Promise<Alerta[]> {
    if (!UUID.test(clienteId)) return [];
    return comCliente(this.pool, clienteId, async (c) => {
      const r = await c.query<LinhaAlerta>(
        `SELECT id, nome, url, formato, fontes, tipos, termos, temas, ativa, criada_em, falhas_consecutivas, motivo_desativacao
           FROM webhook_assinatura WHERE cliente_id = $1 ORDER BY ativa DESC, criada_em DESC LIMIT 200`,
        [clienteId],
      );
      return r.rows.map((l) => ({
        id: l.id,
        nome: l.nome,
        url: l.url,
        formato: l.formato,
        fontes: l.fontes,
        tipos: l.tipos,
        termos: l.termos,
        temas: l.temas,
        ativo: l.ativa,
        criadoEm: l.criada_em.toISOString(),
        falhasConsecutivas: l.falhas_consecutivas,
        motivoDesativacao: l.motivo_desativacao,
      }));
    });
  }

  async remover(clienteId: string, id: string): Promise<boolean> {
    if (!UUID.test(clienteId) || !UUID.test(id)) return false;
    return comCliente(this.pool, clienteId, async (c) => {
      const r = await c.query(
        "UPDATE webhook_assinatura SET ativa = false, desativada_em = now(), motivo_desativacao = 'removido pelo cliente' WHERE id = $1 AND cliente_id = $2 AND ativa",
        [id, clienteId],
      );
      return r.rowCount === 1;
    });
  }
}
