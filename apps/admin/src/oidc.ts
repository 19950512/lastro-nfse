import { createHash } from 'node:crypto';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface IdentidadeOidc {
  readonly emissor: string;
  readonly sujeito: string;
  readonly amr: readonly string[];
}

/** Fronteira com o provedor de identidade (SSO); os testes do painel usam uma implementação falsa. */
export interface ProvedorOidc {
  urlAutorizacao(p: { estado: string; nonce: string; desafio: string }): Promise<string>;
  trocarCodigo(p: { codigo: string; verificador: string; nonce: string }): Promise<IdentidadeOidc>;
}

/** Falha de login (provedor fora do ar, token inválido, MFA insuficiente); o detalhe fica só no log. */
export class ErroOidc extends Error {
  constructor(mensagem: string, opcoes?: ErrorOptions) {
    super(mensagem, opcoes);
    this.name = 'ErroOidc';
  }
}

export interface ConfigOidc {
  readonly emissor: string;
  readonly clienteId: string;
  readonly clienteSegredo: string;
  readonly urlRetorno: string;
  /** Valores de `amr` (RFC 8176) aceitos como segundo fator; basta um deles no token. */
  readonly amrAceitos: readonly string[];
  readonly fetch?: typeof fetch;
  readonly chaves?: (jwksUri: string) => JWTVerifyGetKey;
  readonly timeoutMs?: number;
}

interface Descoberta {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

const ALGORITMOS = ['RS256', 'PS256', 'ES256', 'EdDSA'];

export function desafioPkce(verificador: string): string {
  return createHash('sha256').update(verificador).digest('base64url');
}

function exigirHttps(valor: unknown, nome: string): string {
  if (typeof valor !== 'string') throw new ErroOidc(`descoberta sem ${nome}`);
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new ErroOidc(`${nome} inválido`);
  }
  if (url.protocol !== 'https:') throw new ErroOidc(`${nome} precisa ser https`);
  return valor;
}

/**
 * Relying party OIDC: authorization code + PKCE S256 + state + nonce (o state é conferido pelo painel).
 *
 * invariant: o ID token só é aceito se emitido pelo emissor configurado para este cliente (`aud`), com o
 * nonce desta tentativa, assinado por chave do JWKS dele com algoritmo assimétrico, e com um `amr` da lista
 * de segundo fator aceito (SEGURANCA.md A07: MFA resistente a phishing no painel).
 */
export function criarProvedorOidc(config: ConfigOidc): ProvedorOidc {
  exigirHttps(config.emissor, 'emissor');
  if (config.amrAceitos.length === 0) throw new ErroOidc('lista de amr aceitos vazia');
  const buscarBruto = config.fetch ?? fetch;
  // invariant: falha de rede ou tempo esgotado com o provedor vira ErroOidc (indisponibilidade), nunca erro interno genérico.
  const buscar = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await buscarBruto(url, init);
    } catch (erro) {
      throw new ErroOidc('provedor de identidade inalcançável', { cause: erro });
    }
  };
  const timeoutMs = config.timeoutMs ?? 10_000;
  const base = config.emissor.endsWith('/') ? config.emissor.slice(0, -1) : config.emissor;
  let descoberta: Promise<Descoberta> | undefined;
  let chaves: JWTVerifyGetKey | undefined;

  async function descobrir(): Promise<Descoberta> {
    const r = await buscar(`${base}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new ErroOidc(`descoberta respondeu ${String(r.status)}`);
    const doc = (await r.json()) as Record<string, unknown>;
    // hazard: emissor diferente do configurado indicaria descoberta adulterada (mix-up); recusa.
    if (doc.issuer !== config.emissor) throw new ErroOidc('issuer da descoberta diferente do configurado');
    return {
      authorization_endpoint: exigirHttps(doc.authorization_endpoint, 'authorization_endpoint'),
      token_endpoint: exigirHttps(doc.token_endpoint, 'token_endpoint'),
      jwks_uri: exigirHttps(doc.jwks_uri, 'jwks_uri'),
    };
  }

  function obterDescoberta(): Promise<Descoberta> {
    descoberta ??= descobrir().catch((erro: unknown) => {
      descoberta = undefined;
      throw erro;
    });
    return descoberta;
  }

  return {
    async urlAutorizacao({ estado, nonce, desafio }) {
      const d = await obterDescoberta();
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clienteId,
        redirect_uri: config.urlRetorno,
        scope: 'openid',
        state: estado,
        nonce,
        code_challenge: desafio,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },

    async trocarCodigo({ codigo, verificador, nonce }) {
      const d = await obterDescoberta();
      const credencial = Buffer.from(`${encodeURIComponent(config.clienteId)}:${encodeURIComponent(config.clienteSegredo)}`).toString('base64');
      const r = await buscar(d.token_endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Basic ${credencial}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: codigo, redirect_uri: config.urlRetorno, code_verifier: verificador }).toString(),
      });
      if (!r.ok) throw new ErroOidc(`token endpoint respondeu ${String(r.status)}`);
      const corpo = (await r.json()) as Record<string, unknown>;
      if (typeof corpo.id_token !== 'string') throw new ErroOidc('resposta sem id_token');

      chaves ??= config.chaves?.(d.jwks_uri) ?? createRemoteJWKSet(new URL(d.jwks_uri));
      let payload;
      try {
        ({ payload } = await jwtVerify(corpo.id_token, chaves, {
          issuer: config.emissor,
          audience: config.clienteId,
          algorithms: ALGORITMOS,
          requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
          clockTolerance: 30,
        }));
      } catch (erro) {
        if (erro instanceof errors.JOSEError) throw new ErroOidc(`id_token recusado: ${erro.code}`, { cause: erro });
        throw erro;
      }
      if (payload.nonce !== nonce) throw new ErroOidc('nonce não confere');
      if (typeof payload.sub !== 'string' || payload.sub === '') throw new ErroOidc('id_token sem sub');
      const amr = Array.isArray(payload.amr) ? payload.amr.filter((a): a is string => typeof a === 'string') : [];
      if (!amr.some((a) => config.amrAceitos.includes(a))) throw new ErroOidc(`segundo fator exigido (amr aceitos: ${config.amrAceitos.join(', ')})`);
      return { emissor: config.emissor, sujeito: payload.sub, amr };
    },
  };
}
