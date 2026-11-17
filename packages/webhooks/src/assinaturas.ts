import { lookup } from 'node:dns/promises';
import { enderecoPublico, TIPOS_EVENTO, type TipoEvento } from '@lastro/ingest';
import type pg from 'pg';
import { gerarSegredo } from './assinatura.ts';
import type { FormatoWebhook } from './payload.ts';
import { validarUrlWebhook } from './url.ts';

export interface NovaAssinatura {
  readonly url: string;
  readonly formato: FormatoWebhook;
  readonly fontes?: readonly string[] | undefined;
  readonly tipos?: readonly string[] | undefined;
}

export interface AssinaturaResumo {
  readonly id: string;
  readonly url: string;
  readonly formato: FormatoWebhook;
  readonly fontes: readonly string[] | null;
  readonly tipos: readonly string[] | null;
  readonly ativa: boolean;
  readonly criadaEm: string;
  readonly falhasConsecutivas: number;
  readonly motivoDesativacao: string | null;
  readonly pendentes: number;
  readonly entregues: number;
}

export class ErroAssinatura extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroAssinatura';
  }
}

export type Resolvedor = (host: string) => Promise<string[]>;

const resolverPadrao: Resolvedor = async (host) => (await lookup(host, { all: true })).map((e) => e.address);

/**
 * Cadastra um assinante e devolve o segredo de assinatura, que só é mostrado nesta hora.
 *
 * hazard: o segredo fica no banco em texto (o despacho precisa dele para o HMAC); só os papéis admin e
 * notificador leem a tabela. Em produção, considerar cifrar a coluna com chave do gerenciador de segredos.
 */
export interface DestinoValidado {
  readonly url: string;
  readonly fontes: string[] | null;
  readonly tipos: TipoEvento[] | null;
}

/**
 * invariant: mesma validação para assinatura do operador e alerta do cliente: URL estática segura, fontes e tipos
 * conhecidos e host resolvendo só para endereço público no cadastro (o envio confere de novo a cada entrega).
 */
export async function validarDestino(nova: NovaAssinatura, idsFontes: ReadonlySet<string>, resolver: Resolvedor = resolverPadrao): Promise<DestinoValidado> {
  const validacao = validarUrlWebhook(nova.url);
  if (!validacao.valida) throw new ErroAssinatura(validacao.motivo);
  const desconhecidas = (nova.fontes ?? []).filter((f) => !idsFontes.has(f));
  if (desconhecidas.length > 0) throw new ErroAssinatura(`fontes desconhecidas: ${desconhecidas.join(', ')}`);
  const tiposInvalidos = (nova.tipos ?? []).filter((t) => !(TIPOS_EVENTO as readonly string[]).includes(t));
  if (tiposInvalidos.length > 0) throw new ErroAssinatura(`tipos desconhecidos: ${tiposInvalidos.join(', ')}`);

  let enderecos: string[];
  try {
    enderecos = await resolver(validacao.url.hostname);
  } catch {
    throw new ErroAssinatura(`não foi possível resolver ${validacao.url.hostname}`);
  }
  if (enderecos.length === 0 || !enderecos.every(enderecoPublico)) {
    throw new ErroAssinatura(`${validacao.url.hostname} resolve para endereço não público`);
  }
  return {
    url: validacao.url.toString(),
    fontes: nova.fontes === undefined || nova.fontes.length === 0 ? null : [...new Set(nova.fontes)],
    tipos: nova.tipos === undefined || nova.tipos.length === 0 ? null : [...new Set(nova.tipos as TipoEvento[])],
  };
}

export async function criarAssinatura(
  pool: pg.Pool,
  nova: NovaAssinatura,
  idsFontes: ReadonlySet<string>,
  resolver: Resolvedor = resolverPadrao,
): Promise<{ id: string; segredo: string }> {
  const destino = await validarDestino(nova, idsFontes, resolver);
  const segredo = gerarSegredo();
  const r = await pool.query<{ id: string }>(
    'INSERT INTO webhook_assinatura (url, formato, segredo, fontes, tipos) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [destino.url, nova.formato, segredo, destino.fontes, destino.tipos],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new ErroAssinatura('INSERT sem retorno');
  return { id, segredo };
}

export async function listarAssinaturas(pool: pg.Pool): Promise<AssinaturaResumo[]> {
  const r = await pool.query<{
    id: string;
    url: string;
    formato: FormatoWebhook;
    fontes: string[] | null;
    tipos: string[] | null;
    ativa: boolean;
    criada_em: Date;
    falhas_consecutivas: number;
    motivo_desativacao: string | null;
    pendentes: number;
    entregues: number;
  }>(
    `SELECT a.id, a.url, a.formato, a.fontes, a.tipos, a.ativa, a.criada_em, a.falhas_consecutivas, a.motivo_desativacao,
            count(*) FILTER (WHERE w.situacao = 'pendente')::int AS pendentes,
            count(*) FILTER (WHERE w.situacao = 'entregue')::int AS entregues
       FROM webhook_assinatura a LEFT JOIN webhook_entrega w ON w.assinatura_id = a.id
      GROUP BY a.id ORDER BY a.criada_em`,
  );
  return r.rows.map((l) => ({
    id: l.id,
    url: l.url,
    formato: l.formato,
    fontes: l.fontes,
    tipos: l.tipos,
    ativa: l.ativa,
    criadaEm: l.criada_em.toISOString(),
    falhasConsecutivas: l.falhas_consecutivas,
    motivoDesativacao: l.motivo_desativacao,
    pendentes: l.pendentes,
    entregues: l.entregues,
  }));
}

export async function desativarAssinatura(pool: pg.Pool, id: string, motivo: string): Promise<boolean> {
  const r = await pool.query(
    'UPDATE webhook_assinatura SET ativa = false, desativada_em = now(), motivo_desativacao = $2 WHERE id = $1 AND ativa',
    [id, motivo],
  );
  return r.rowCount === 1;
}
