import { createHash } from 'node:crypto';
import type { Fonte } from '@lastro/core';
import { ErroCuradoria, type Curador, type PropostaDetalhe, type RepositorioCuradoria, type SessaoCurador, type TrechoCuradoria } from '@lastro/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { construirAdmin } from './app.ts';
import { ErroOidc, type ProvedorOidc } from './oidc.ts';

const ORIGEM = 'https://curadoria.lastro.example';
const EMISSOR = 'https://idp.lastro.example';
const XSS = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
const ID_FATO = '11111111-1111-4111-8111-111111111111';
const ID_TRECHO = '22222222-2222-4222-8222-222222222222';

const FONTES: Fonte[] = [
  { id: 'cgibs', nome: 'CGIBS', orgao: 'CGIBS', nivel: 'N1', sementes: [], formatos: ['pdf'], colherDocumentos: true, frequenciaHoras: 6, slaHoras: 24, validadaNoCatalogo: true },
];

const curadores: Record<string, Curador> = {
  'sub-ana': { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nome: 'Ana', papel: 'curador' },
  'sub-sup': { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nome: 'Sofia', papel: 'supervisor' },
};

const trecho: TrechoCuradoria = {
  id: ID_TRECHO,
  texto: `Art. 1º A obrigatoriedade passa a valer em 01/01/2027. ${XSS}`,
  secao: 'Art. 1',
  paginaIni: 1,
  documentoId: '33333333-3333-4333-8333-333333333333',
  snapshotId: '44444444-4444-4444-8444-444444444444',
  url: 'https://www.cgibs.gov.br/ato-4.pdf',
  fonteId: 'cgibs',
  sha256: 'a'.repeat(64),
  coletadoEm: '2026-11-16T10:00:00.000Z',
  vigente: true,
};

interface Estado {
  logins: Map<string, { nonce: string; verificador: string }>;
  sessoes: Map<string, SessaoCurador>;
  decisoes: { curadorId: string; tipo: string; id: string; decisao: string; motivo: string | null }[];
  recalls: { curadorId: string; fatoId: string; motivo: string }[];
  fatosPropostos: { curadorId: string; evidenciaTexto: string }[];
  situacao: PropostaDetalhe['situacao'];
  erroDecidir: ErroCuradoria | null;
}

let estado: Estado;

function proposta(curadorId: string): PropostaDetalhe {
  return {
    tipo: 'fato',
    id: ID_FATO,
    situacao: estado.situacao,
    titulo: `Obrigatoriedade ${XSS}`,
    extrator: 'claude-opus-5-5',
    propostoEm: '2026-11-16T10:00:00.000Z',
    propostoPor: null,
    souProponente: false,
    aprovacoes: 0,
    jaDecidi: estado.decisoes.some((d) => d.curadorId === curadorId),
    url: trecho.url,
    fonteId: 'cgibs',
    evidenciaTexto: 'A obrigatoriedade passa a valer em 01/01/2027.',
    evidenciaAtual: true,
    trecho,
    decisoes: [],
    fato: { tipo: 'prazo', tema: 'ibs-cbs', enunciado: `Obrigatório em 2027 ${XSS}`, publico: null, dataEfeito: '2027-01-01', substitui: null },
    relacao: null,
  };
}

const repo: RepositorioCuradoria = {
  curadorPorIdentidade: (emissor, sujeito) => Promise.resolve(emissor === EMISSOR ? curadores[sujeito] : undefined),
  iniciarLogin: (l) => {
    estado.logins.set(l.hashEstado, { nonce: l.nonce, verificador: l.verificador });
    return Promise.resolve();
  },
  consumirLogin: (h) => {
    const l = estado.logins.get(h);
    estado.logins.delete(h);
    return Promise.resolve(l);
  },
  criarSessao: (s) => {
    const curador = Object.values(curadores).find((c) => c.id === s.curadorId);
    if (curador !== undefined) estado.sessoes.set(s.hash, { curador, amr: s.amr, expiraEm: s.expiraEm.toISOString() });
    return Promise.resolve();
  },
  obterSessao: (h) => Promise.resolve(estado.sessoes.get(h)),
  encerrarSessao: (h) => {
    estado.sessoes.delete(h);
    return Promise.resolve();
  },
  listarPropostas: (curadorId) => Promise.resolve([proposta(curadorId)]),
  obterProposta: (curadorId, _tipo, id) => Promise.resolve(id === ID_FATO ? proposta(curadorId) : undefined),
  decidir: (curadorId, tipo, id, decisao, motivo) => {
    if (estado.erroDecidir !== null) return Promise.reject(estado.erroDecidir);
    estado.decisoes.push({ curadorId, tipo, id, decisao, motivo });
    return Promise.resolve();
  },
  obterTrecho: (id) => Promise.resolve(id === ID_TRECHO ? trecho : undefined),
  proporFato: (curadorId, f) => {
    estado.fatosPropostos.push({ curadorId, evidenciaTexto: f.evidenciaTexto });
    return Promise.resolve(ID_FATO);
  },
  recall: (curadorId, fatoId, motivo) => {
    estado.recalls.push({ curadorId, fatoId, motivo });
    return Promise.resolve({ verificacoes: 3, consultas: 7 });
  },
  usoDoFato: () => Promise.resolve({ verificacoes: 3, consultas: 7 }),
};

const oidc: ProvedorOidc = {
  urlAutorizacao: ({ estado: e }) => Promise.resolve(`${EMISSOR}/autorizar?state=${e}`),
  trocarCodigo: ({ codigo }) => {
    if (codigo === 'sem-mfa') return Promise.reject(new ErroOidc('segundo fator exigido'));
    return Promise.resolve({ emissor: EMISSOR, sujeito: codigo === 'supervisor' ? 'sub-sup' : codigo === 'estranho' ? 'sub-x' : 'sub-ana', amr: ['hwk'] });
  },
};

let app: FastifyInstance;

beforeEach(() => {
  estado = { logins: new Map(), sessoes: new Map(), decisoes: [], recalls: [], fatosPropostos: [], situacao: 'proposto', erroDecidir: null };
  app = construirAdmin({ curadoria: repo, oidc, fontes: FONTES, origem: ORIGEM });
});

const setCookies = (r: LightMyRequestResponse): string[] => {
  const h = r.headers['set-cookie'];
  return h === undefined ? [] : Array.isArray(h) ? h : [h];
};
const valorCookie = (r: LightMyRequestResponse, nome: string): string | undefined =>
  setCookies(r)
    .find((c) => c.startsWith(`${nome}=`))
    ?.split(';')[0]
    ?.slice(nome.length + 1);

async function iniciar(): Promise<string> {
  const r = await app.inject('/login');
  expect(r.statusCode).toBe(303);
  const estadoLogin = valorCookie(r, '__Host-lastro_login');
  expect(new URL(r.headers.location ?? '').searchParams.get('state')).toBe(estadoLogin);
  return estadoLogin ?? '';
}

async function entrar(codigo = 'bom'): Promise<{ cookie: string; csrf: string }> {
  const e = await iniciar();
  const r = await app.inject({ url: `/oidc/retorno?code=${codigo}&state=${e}`, headers: { cookie: `__Host-lastro_login=${e}` } });
  expect(r.statusCode).toBe(303);
  const token = valorCookie(r, '__Host-lastro_sessao') ?? '';
  return { cookie: `__Host-lastro_sessao=${token}`, csrf: createHash('sha256').update(`csrf\0${token}`).digest('hex') };
}

function postar(url: string, s: { cookie: string; csrf?: string }, campos: Record<string, string>, origem: string | null = ORIGEM) {
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded', ...(origem === null ? {} : { origin: origem }) },
    payload: new URLSearchParams({ ...(s.csrf === undefined ? {} : { csrf: s.csrf }), ...campos }).toString(),
  });
}

describe('login OIDC', () => {
  it('cookie de sessão com __Host-, HttpOnly, Secure e SameSite=Strict; login cookie limpo', async () => {
    const e = await iniciar();
    const r = await app.inject({ url: `/oidc/retorno?code=bom&state=${e}`, headers: { cookie: `__Host-lastro_login=${e}` } });
    expect(r.headers.location).toBe('/fila');
    const sessao = setCookies(r).find((c) => c.startsWith('__Host-lastro_sessao='));
    expect(sessao).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=7200$/);
    expect(setCookies(r).find((c) => c.startsWith('__Host-lastro_login='))).toContain('Max-Age=0');
  });

  it('recusa state ausente, diferente do cookie ou reutilizado', async () => {
    const e = await iniciar();
    expect((await app.inject({ url: `/oidc/retorno?code=bom&state=${e}` })).statusCode).toBe(403);
    const outro = 'x'.repeat(43);
    expect((await app.inject({ url: `/oidc/retorno?code=bom&state=${outro}`, headers: { cookie: `__Host-lastro_login=${e}` } })).statusCode).toBe(403);
    const ok = await app.inject({ url: `/oidc/retorno?code=bom&state=${e}`, headers: { cookie: `__Host-lastro_login=${e}` } });
    expect(ok.statusCode).toBe(303);
    const reuso = await app.inject({ url: `/oidc/retorno?code=bom&state=${e}`, headers: { cookie: `__Host-lastro_login=${e}` } });
    expect(reuso.statusCode).toBe(403);
    expect(setCookies(reuso).some((c) => c.startsWith('__Host-lastro_sessao='))).toBe(false);
  });

  it('identidade sem curador e login sem segundo fator são recusados', async () => {
    for (const codigo of ['estranho', 'sem-mfa']) {
      const e = await iniciar();
      const r = await app.inject({ url: `/oidc/retorno?code=${codigo}&state=${e}`, headers: { cookie: `__Host-lastro_login=${e}` } });
      expect(r.statusCode, codigo).toBe(403);
      expect(estado.sessoes.size).toBe(0);
    }
  });

  it('sem sessão: GET vai para o login, POST recebe 401', async () => {
    expect((await app.inject('/fila')).headers.location).toBe('/login');
    expect((await postar(`/propostas/fato/${ID_FATO}/decisao`, { cookie: '__Host-lastro_sessao=invalida' }, { decisao: 'aprovar' })).statusCode).toBe(401);
  });

  it('sair encerra a sessão', async () => {
    const s = await entrar();
    expect((await postar('/sair', s, {})).statusCode).toBe(303);
    expect(estado.sessoes.size).toBe(0);
    expect((await app.inject({ url: '/fila', headers: { cookie: s.cookie } })).statusCode).toBe(303);
  });
});

describe('CSRF e cabeçalhos', () => {
  it('POST sem token, com token errado ou de outra origem é recusado', async () => {
    const s = await entrar();
    const url = `/propostas/fato/${ID_FATO}/decisao`;
    expect((await postar(url, { cookie: s.cookie }, { decisao: 'aprovar' })).statusCode).toBe(403);
    expect((await postar(url, { cookie: s.cookie, csrf: '0'.repeat(64) }, { decisao: 'aprovar' })).statusCode).toBe(403);
    expect((await postar(url, s, { decisao: 'aprovar' }, 'https://atacante.example')).statusCode).toBe(403);
    expect((await postar(url, s, { decisao: 'aprovar' }, null)).statusCode).toBe(403);
    expect(estado.decisoes).toEqual([]);
  });

  it('POST sem Origin mas com Sec-Fetch-Site same-origin passa; JSON não é aceito', async () => {
    const s = await entrar();
    const r = await app.inject({
      method: 'POST',
      url: `/propostas/fato/${ID_FATO}/decisao`,
      headers: { cookie: s.cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf: s.csrf, decisao: 'aprovar' }).toString(),
    });
    expect(r.statusCode).toBe(303);
    const json = await app.inject({ method: 'POST', url: `/propostas/fato/${ID_FATO}/decisao`, headers: { cookie: s.cookie, origin: ORIGEM }, payload: { csrf: s.csrf, decisao: 'aprovar' } });
    expect(json.statusCode).toBe(415);
  });

  it('Origin null (Referrer-Policy no-referrer) passa só com Sec-Fetch-Site same-origin', async () => {
    const s = await entrar();
    const enviar = (site: string | undefined) =>
      app.inject({
        method: 'POST',
        url: `/propostas/fato/${ID_FATO}/decisao`,
        headers: { cookie: s.cookie, origin: 'null', 'content-type': 'application/x-www-form-urlencoded', ...(site === undefined ? {} : { 'sec-fetch-site': site }) },
        payload: new URLSearchParams({ csrf: s.csrf, decisao: 'aprovar' }).toString(),
      });
    expect((await enviar('cross-site')).statusCode).toBe(403);
    expect((await enviar(undefined)).statusCode).toBe(403);
    expect(estado.decisoes).toEqual([]);
    expect((await enviar('same-origin')).statusCode).toBe(303);
  });

  it('CSP sem script e cabeçalhos de segurança em toda página', async () => {
    const s = await entrar();
    const r = await app.inject({ url: '/fila', headers: { cookie: s.cookie } });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).not.toContain('<script');
  });
});

describe('decisões e RBAC', () => {
  it('aprovar usa o curador da sessão; curador_id no formulário é recusado', async () => {
    const s = await entrar();
    expect((await postar(`/propostas/fato/${ID_FATO}/decisao`, s, { decisao: 'aprovar', curador_id: curadores['sub-sup']?.id ?? '' })).statusCode).toBe(400);
    expect(estado.decisoes).toEqual([]);
    const r = await postar(`/propostas/fato/${ID_FATO}/decisao`, s, { decisao: 'aprovar', motivo: '' });
    expect(r.statusCode).toBe(303);
    expect(estado.decisoes).toEqual([{ curadorId: curadores['sub-ana']?.id, tipo: 'fato', id: ID_FATO, decisao: 'aprovar', motivo: null }]);
  });

  it('rejeitar exige motivo', async () => {
    const s = await entrar();
    expect((await postar(`/propostas/fato/${ID_FATO}/decisao`, s, { decisao: 'rejeitar' })).statusCode).toBe(400);
    expect((await postar(`/propostas/fato/${ID_FATO}/decisao`, s, { decisao: 'rejeitar', motivo: 'ab' })).statusCode).toBe(400);
    expect((await postar(`/propostas/fato/${ID_FATO}/decisao`, s, { decisao: 'rejeitar', motivo: 'data errada' })).statusCode).toBe(303);
    expect(estado.decisoes[0]).toMatchObject({ decisao: 'rejeitar', motivo: 'data errada' });
  });

  it('regra recusada pelo banco vira 403/409 com a mensagem escapada', async () => {
    const s = await entrar();
    estado.erroDecidir = new ErroCuradoria('nao-permitido', `quem propôs não aprova ${XSS}`);
    const r = await postar(`/propostas/fato/${ID_FATO}/decisao`, s, { decisao: 'aprovar' });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain('<script>');
    expect(r.body).toContain('&lt;script&gt;');
    estado.erroDecidir = new ErroCuradoria('conflito', 'proposta já decidida');
    expect((await postar(`/propostas/fato/${ID_FATO}/decisao`, s, { decisao: 'aprovar' })).statusCode).toBe(409);
  });

  it('recall só por supervisor', async () => {
    estado.situacao = 'aprovado';
    const ana = await entrar();
    expect((await postar(`/fatos/${ID_FATO}/recall`, ana, { motivo: 'prazo foi prorrogado' })).statusCode).toBe(403);
    expect((await app.inject({ url: `/propostas/fato/${ID_FATO}`, headers: { cookie: ana.cookie } })).body).not.toContain('/recall');
    const sofia = await entrar('supervisor');
    const pagina = await app.inject({ url: `/propostas/fato/${ID_FATO}`, headers: { cookie: sofia.cookie } });
    expect(pagina.body).toContain(`/fatos/${ID_FATO}/recall`);
    const r = await postar(`/fatos/${ID_FATO}/recall`, sofia, { motivo: 'prazo foi prorrogado' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('3 verificações e 7 respostas');
    expect(estado.recalls).toEqual([{ curadorId: curadores['sub-sup']?.id, fatoId: ID_FATO, motivo: 'prazo foi prorrogado' }]);
  });

  it('fato manual: evidência precisa ser cópia literal do trecho', async () => {
    const s = await entrar();
    const base = { trecho: ID_TRECHO, tipo: 'prazo', tema: 'ibs-cbs', enunciado: 'A obrigatoriedade vale a partir de 01/01/2027.' };
    expect((await postar('/fatos', s, { ...base, evidencia_texto: 'vale em 01/01/2028' })).statusCode).toBe(400);
    expect((await postar('/fatos', s, { ...base, tema: 'Tema Inválido', evidencia_texto: 'passa a valer em 01/01/2027' })).statusCode).toBe(400);
    const ok = await postar('/fatos', s, { ...base, evidencia_texto: 'passa a valer em 01/01/2027', publico: '', data_efeito: '2027-01-01' });
    expect(ok.statusCode).toBe(303);
    expect(estado.fatosPropostos).toEqual([{ curadorId: curadores['sub-ana']?.id, evidenciaTexto: 'passa a valer em 01/01/2027' }]);
  });
});

describe('XSS', () => {
  it('título, enunciado e trecho oficial saem escapados na fila, na proposta e no formulário', async () => {
    const s = await entrar();
    for (const url of ['/fila', `/propostas/fato/${ID_FATO}`, `/fatos/novo?trecho=${ID_TRECHO}`]) {
      const r = await app.inject({ url, headers: { cookie: s.cookie } });
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).not.toContain('<script>alert');
      expect(r.body, url).not.toContain('<img src=x');
      expect(r.body, url).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
    const detalhe = await app.inject({ url: `/propostas/fato/${ID_FATO}`, headers: { cookie: s.cookie } });
    expect(detalhe.body).toContain('<mark>A obrigatoriedade passa a valer em 01/01/2027.</mark>');
  });
});

describe('provedor de identidade fora do ar', () => {
  it('login responde 503 com retry-after, sem detalhe interno', async () => {
    const fora = construirAdmin({ curadoria: repo, oidc: { ...oidc, urlAutorizacao: () => Promise.reject(new ErroOidc('provedor de identidade inalcançável')) }, fontes: FONTES, origem: ORIGEM });
    const r = await fora.inject('/login');
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('60');
    expect(r.body).toContain('Login indisponível');
    expect(r.body).not.toContain('inalcançável');
  });
});
