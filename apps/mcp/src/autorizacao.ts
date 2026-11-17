import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface TokenValido {
  readonly sujeito: string;
  readonly clienteId: string | null;
  readonly escopos: readonly string[];
  readonly expiraEm: number;
}

export interface ConfigOAuth {
  /** Identificador deste servidor como recurso (RFC 8707/9728); é a audiência exigida no token. */
  readonly recurso: string;
  readonly emissor: string;
  readonly chaves: JWTVerifyGetKey;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALGORITMOS = ['RS256', 'PS256', 'ES256', 'EdDSA'];

/**
 * Valida o token de acesso como servidor de recurso OAuth 2.1 (especificação de autorização do MCP).
 *
 * invariant: só aceita token emitido para este recurso (`aud`), pelo emissor configurado, assinado com
 * chave do JWKS dele e dentro da validade. Token de outro serviço é recusado, então não há repasse
 * de token (SEGURANCA.md §10). Algoritmos fixos: `none` e HS* nunca passam.
 */
export function criarVerificador(config: ConfigOAuth): (token: string) => Promise<TokenValido | undefined> {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, config.chaves, {
        issuer: config.emissor,
        audience: config.recurso,
        algorithms: ALGORITMOS,
        requiredClaims: ['exp', 'sub'],
        clockTolerance: 30,
      });
      const escopoTexto = typeof payload.scope === 'string' ? payload.scope : '';
      const scp = Array.isArray(payload.scp) ? payload.scp.filter((s): s is string => typeof s === 'string') : [];
      const cliente = payload.lastro_cliente_id;
      return {
        sujeito: payload.sub ?? '',
        clienteId: typeof cliente === 'string' && UUID.test(cliente) ? cliente : null,
        escopos: [...new Set([...escopoTexto.split(' ').filter((s) => s !== ''), ...scp])],
        expiraEm: payload.exp ?? 0,
      };
    } catch (erro) {
      if (erro instanceof errors.JOSEError) return undefined;
      throw erro;
    }
  };
}

/** Metadados do recurso protegido (RFC 9728), que o cliente MCP usa para descobrir o servidor de autorização. */
export function metadadosRecurso(config: Pick<ConfigOAuth, 'recurso' | 'emissor'>, escopos: readonly string[]): object {
  return {
    resource: config.recurso,
    authorization_servers: [config.emissor],
    scopes_supported: [...escopos],
    bearer_methods_supported: ['header'],
    resource_name: 'Lastro — NFS-e com fonte oficial',
  };
}
