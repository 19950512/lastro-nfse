import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { criarProvedorOidc, desafioPkce, ErroOidc, type ConfigOidc } from './oidc.ts';

const EMISSOR = 'https://idp.lastro.example';
const CLIENTE = 'painel-curadoria';
const NONCE = 'n'.repeat(43);

let chave: CryptoKey;
let outra: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  const par = await generateKeyPair('ES256');
  chave = par.privateKey;
  outra = (await generateKeyPair('ES256')).privateKey;
  jwk = { ...(await exportJWK(par.publicKey)), kid: 'k1', alg: 'ES256' };
});

function token(claims: Record<string, unknown> = {}, o: { aud?: string; iss?: string; exp?: string; chave?: CryptoKey } = {}): Promise<string> {
  return new SignJWT({ nonce: NONCE, amr: ['hwk', 'user'], ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setSubject('sub-ana')
    .setIssuer(o.iss ?? EMISSOR)
    .setAudience(o.aud ?? CLIENTE)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '5m')
    .sign(o.chave ?? chave);
}

interface Chamada {
  url: string;
  init: RequestInit | undefined;
}

function provedor(idToken: string | Promise<string>, extras: Partial<ConfigOidc> & { descoberta?: Record<string, unknown> } = {}) {
  const chamadas: Chamada[] = [];
  const fetchFalso = async (entrada: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = entrada instanceof Request ? entrada.url : entrada.toString();
    chamadas.push({ url, init });
    if (url === `${EMISSOR}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: EMISSOR,
        authorization_endpoint: `${EMISSOR}/autorizar`,
        token_endpoint: `${EMISSOR}/token`,
        jwks_uri: `${EMISSOR}/jwks`,
        ...extras.descoberta,
      });
    }
    if (url === `${EMISSOR}/token`) return Response.json({ id_token: await idToken, access_token: 'x', token_type: 'Bearer' });
    return new Response('nao', { status: 404 });
  };
  const p = criarProvedorOidc({
    emissor: EMISSOR,
    clienteId: CLIENTE,
    clienteSegredo: 's3gr3do:com/simbolos',
    urlRetorno: 'https://curadoria.lastro.example/oidc/retorno',
    amrAceitos: ['hwk'],
    fetch: fetchFalso,
    chaves: () => createLocalJWKSet({ keys: [jwk] }),
    ...extras,
  });
  return { p, chamadas };
}

const trocar = (p: ReturnType<typeof provedor>['p']) => p.trocarCodigo({ codigo: 'abc', verificador: 'v'.repeat(43), nonce: NONCE });

describe('OIDC', () => {
  it('URL de autorização com code + PKCE S256 + state + nonce', async () => {
    const { p } = provedor(token());
    const url = new URL(await p.urlAutorizacao({ estado: 'e'.repeat(43), nonce: NONCE, desafio: desafioPkce('v'.repeat(43)) }));
    expect(url.origin + url.pathname).toBe(`${EMISSOR}/autorizar`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CLIENTE,
      scope: 'openid',
      state: 'e'.repeat(43),
      nonce: NONCE,
      code_challenge_method: 'S256',
      code_challenge: desafioPkce('v'.repeat(43)),
    });
  });

  it('aceita token válido com segundo fator; troca o código com client_secret_basic e code_verifier', async () => {
    const { p, chamadas } = provedor(token());
    expect(await trocar(p)).toEqual({ emissor: EMISSOR, sujeito: 'sub-ana', amr: ['hwk', 'user'] });
    const troca = chamadas.find((c) => c.url.endsWith('/token'));
    const cab = troca?.init?.headers as Record<string, string>;
    expect(Buffer.from((cab.authorization ?? '').replace('Basic ', ''), 'base64').toString()).toBe(`${CLIENTE}:s3gr3do%3Acom%2Fsimbolos`);
    expect(new URLSearchParams(troca?.init?.body as string).get('code_verifier')).toBe('v'.repeat(43));
    expect(chamadas.filter((c) => c.url.includes('openid-configuration'))).toHaveLength(1);
  });

  it.each([
    ['audiência de outro cliente', () => token({}, { aud: 'outro-cliente' })],
    ['outro emissor', () => token({}, { iss: 'https://outro.example' })],
    ['nonce de outra tentativa', () => token({ nonce: 'x'.repeat(43) })],
    ['expirado', () => token({}, { exp: '-10m' })],
    ['assinado por outra chave', () => token({}, { chave: outra })],
    ['sem segundo fator aceito', () => token({ amr: ['pwd', 'otp'] })],
    ['sem amr', () => token({ amr: undefined })],
    [
      'alg none',
      () => {
        const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const agora = Math.floor(Date.now() / 1000);
        return Promise.resolve(`${b({ alg: 'none' })}.${b({ iss: EMISSOR, aud: CLIENTE, sub: 'sub-ana', nonce: NONCE, amr: ['hwk'], iat: agora, exp: agora + 300 })}.`);
      },
    ],
  ])('recusa token: %s', async (_nome, gerar) => {
    await expect(trocar(provedor(gerar()).p)).rejects.toBeInstanceOf(ErroOidc);
  });

  it('recusa descoberta com issuer diferente ou endpoint sem https', async () => {
    await expect(trocar(provedor(token(), { descoberta: { issuer: 'https://atacante.example' } }).p)).rejects.toThrow(/issuer/);
    await expect(trocar(provedor(token(), { descoberta: { token_endpoint: 'http://idp.lastro.example/token' } }).p)).rejects.toThrow(/https/);
  });

  it('recusa emissor sem https na configuração', () => {
    expect(() => provedor(token(), { emissor: 'http://idp.lastro.example' })).toThrow(ErroOidc);
  });
});

describe('rede', () => {
  it('falha de rede com o provedor vira ErroOidc (indisponibilidade), não erro genérico', async () => {
    const p = criarProvedorOidc({
      emissor: EMISSOR,
      clienteId: CLIENTE,
      clienteSegredo: 's',
      urlRetorno: 'https://curadoria.lastro.example/oidc/retorno',
      amrAceitos: ['hwk'],
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(p.urlAutorizacao({ estado: 'e', nonce: NONCE, desafio: desafioPkce('v'.repeat(43)) })).rejects.toBeInstanceOf(ErroOidc);
  });
});
