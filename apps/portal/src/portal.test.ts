import { ErroCota, type RespostaPergunta, type ServicoPerguntas, type ServicoVerificacoes, type Solicitante } from '@lastro/llm';
import { beforeEach, describe, expect, it } from 'vitest';
import { construirPortal, SCRIPT_PORTAL, type DependenciasPortal, type OpcoesPortal } from './app.ts';
import { criarCaptcha, ErroConfigCaptcha, type Captcha } from './captcha.ts';

const ORIGEM = 'https://lastro.example';
const CLIENTE = '99999999-9999-4999-8999-99999999999a';
const XSS = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
const TOKEN = 'k'.repeat(43);

const resposta: RespostaPergunta = {
  situacao: 'respondida',
  rota: 'prazo',
  resposta: `Vale em 01/01/2027 [1]. Texto ${XSS} [9]`,
  posicao_em: '2026-11-17',
  fontes: [
    {
      id: 1,
      titulo: `nt-009.pdf ${XSS}`,
      orgao: 'SE/CGNFS-e',
      nivel: 'N2',
      url: 'javascript:alert(3)',
      secao: 'Art. 1º',
      pagina: 2,
      trecho: `passa a valer ${XSS}`,
      coletado_em: '2026-11-16T10:00:00.000Z',
      confirmado_em: '2026-11-16T12:00:00.000Z',
      sha256: 'c'.repeat(64),
      snapshot_id: '33333333-3333-4333-8333-333333333333',
      documento_id: '11111111-1111-4111-8111-111111111111',
      original: '/v1/snapshots/33333333-3333-4333-8333-333333333333/original',
    },
  ],
  avisos: [],
  limites: ['Não cobre ISS.'],
  aviso: 'Não substitui orientação profissional.',
  checagem: { citacoes_invalidas: 0, frases_sem_citacao_removidas: 0, conteudo_removido: 0 },
};

const chamadas: { tipo: string; solicitante: Solicitante; texto: string; data?: string | undefined }[] = [];

const perguntas: ServicoPerguntas = {
  responder: (solicitante, pergunta) => {
    chamadas.push({ tipo: 'pergunta', solicitante, texto: pergunta });
    return Promise.resolve({ id: '66666666-6666-4666-8666-666666666666', resposta });
  },
  obter: () => Promise.resolve(undefined),
};

const verificacoes: ServicoVerificacoes = {
  verificar: (solicitante, texto, opcoes) => {
    chamadas.push({ tipo: 'verificacao', solicitante, texto, data: opcoes?.dataConteudo });
    return Promise.resolve({ id: '14141414-1414-4414-8414-141414141414', criadaEm: '', expiraEm: '', resultado: {} as never });
  },
  obter: () => Promise.resolve(undefined),
  compartilhar: (clienteId, id) => Promise.resolve(clienteId === CLIENTE && id === '14141414-1414-4414-8414-141414141414' ? TOKEN : undefined),
  revogarCompartilhamento: () => Promise.resolve(false),
  obterCompartilhada: () => Promise.resolve(undefined),
};

const desligado = criarCaptcha({ provedor: 'desligado', hostEsperado: 'lastro.example' });

function portal(extras: Partial<DependenciasPortal> = {}, opcoes: OpcoesPortal = {}) {
  return construirPortal(
    { perguntas, verificacoes, clienteId: CLIENTE, captcha: desligado, origem: ORIGEM, urlPublicaApi: 'https://api.lastro.example/', agora: () => new Date('2026-11-17T12:00:00Z'), ...extras },
    opcoes,
  );
}

const form = (campos: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGEM },
  payload: new URLSearchParams(campos).toString(),
});

beforeEach(() => {
  chamadas.length = 0;
});

describe('páginas e cabeçalhos', () => {
  it('home sem script de terceiros quando o CAPTCHA está desligado; CSP e cabeçalhos de segurança', async () => {
    const r = await portal().inject('/');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('action="/perguntar"');
    expect(r.body).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });

  it('com Turnstile, a página carrega o widget e a CSP libera só o provedor', async () => {
    const captcha = criarCaptcha({ provedor: 'turnstile', chaveSite: '0x4AAAAAAAteste', segredo: 's'.repeat(32), hostEsperado: 'lastro.example' });
    const r = await portal({ captcha }).inject('/verificar');
    expect(r.body).toContain('<div class="cf-turnstile" data-sitekey="0x4AAAAAAAteste"></div>');
    expect(r.body).toContain('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>');
    expect(r.headers['content-security-policy']).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(r.headers['content-security-policy']).toContain('frame-src https://challenges.cloudflare.com');
  });

  it('script próprio só lê o fragmento e é servido como JavaScript', async () => {
    const r = await portal().inject('/portal.js');
    expect(r.headers['content-type']).toContain('text/javascript');
    expect(r.body).toBe(SCRIPT_PORTAL);
    expect(SCRIPT_PORTAL).not.toMatch(/fetch|XMLHttpRequest|innerHTML|eval/);
  });

  it('security.txt só com configuração', async () => {
    expect((await portal().inject('/.well-known/security.txt')).statusCode).toBe(404);
    const r = await portal({}, { securityTxt: { contato: 'https://lastro.example/seguranca', expira: '2027-01-01' } }).inject('/.well-known/security.txt');
    expect(r.body).toContain('Contact: https://lastro.example/seguranca\nExpires: 2027-01-01T00:00:00.000Z');
  });
});

describe('perguntar', () => {
  it('chama o modelo em nome do cliente do portal e escapa tudo o que vem da resposta', async () => {
    const r = await portal().inject({ method: 'POST', url: '/perguntar', ...form({ pergunta: `Quando vale? ${XSS}` }) });
    expect(r.statusCode).toBe(200);
    expect(chamadas).toEqual([{ tipo: 'pergunta', solicitante: { clienteId: CLIENTE, chaveId: null, canal: 'portal' }, texto: `Quando vale? ${XSS}` }]);
    expect(r.body).not.toContain('<script>alert');
    expect(r.body).not.toContain('<img src=x');
    expect(r.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.body).toContain('<a href="#fonte-1">[1]</a>');
    expect(r.body).toContain('[9]');
    expect(r.body).not.toContain('href="#fonte-9"');
    expect(r.body).not.toContain('javascript:');
  });

  it.each([
    ['sem Origin nem Sec-Fetch-Site', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['Origin de outro site', { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://atacante.example' }],
  ])('recusa POST %s', async (_nome, headers) => {
    const r = await portal().inject({ method: 'POST', url: '/perguntar', headers, payload: 'pergunta=Quando+vale%3F' });
    expect(r.statusCode).toBe(403);
    expect(chamadas).toHaveLength(0);
  });

  it.each([
    ['cross-site', 403],
    [undefined, 403],
    ['same-origin', 200],
  ])('Origin null (efeito do Referrer-Policy no-referrer) com Sec-Fetch-Site %s → %s', async (site, status) => {
    const r = await portal().inject({
      method: 'POST',
      url: '/perguntar',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', ...(site === undefined ? {} : { 'sec-fetch-site': site }) },
      payload: 'pergunta=Quando+vale%3F',
    });
    expect(r.statusCode).toBe(status);
    expect(chamadas).toHaveLength(status === 200 ? 1 : 0);
  });

  it('aceita navegador sem Origin quando Sec-Fetch-Site é same-origin', async () => {
    const r = await portal().inject({
      method: 'POST',
      url: '/perguntar',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      payload: 'pergunta=Quando+vale%3F',
    });
    expect(r.statusCode).toBe(200);
  });

  it('recusa corpo JSON, pergunta curta ou longa', async () => {
    const json = await portal().inject({ method: 'POST', url: '/perguntar', headers: { 'content-type': 'application/json', origin: ORIGEM }, payload: '{"pergunta":"Quando vale?"}' });
    expect(json.statusCode).toBe(415);
    expect((await portal().inject({ method: 'POST', url: '/perguntar', ...form({ pergunta: 'a' }) })).statusCode).toBe(400);
    expect((await portal().inject({ method: 'POST', url: '/perguntar', ...form({ pergunta: 'a'.repeat(1001) }) })).statusCode).toBe(400);
    expect(chamadas).toHaveLength(0);
  });

  it('cota ou orçamento esgotado vira 503 com retry-after', async () => {
    const semCota: ServicoPerguntas = { ...perguntas, responder: () => Promise.reject(new ErroCota('orcamento-global')) };
    const r = await portal({ perguntas: semCota }).inject({ method: 'POST', url: '/perguntar', ...form({ pergunta: 'Quando vale?' }) });
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('3600');
  });
});

describe('CAPTCHA no servidor', () => {
  function turnstile(respostas: unknown[] | Error) {
    const enviados: { url: string; corpo: string }[] = [];
    const captcha: Captcha = criarCaptcha(
      { provedor: 'turnstile', chaveSite: '0x4AAAAAAAteste', segredo: 'segredo-'.repeat(4), hostEsperado: 'lastro.example' },
      (url, init) => {
        enviados.push({ url, corpo: typeof init.body === 'string' ? init.body : '' });
        if (respostas instanceof Error) return Promise.reject(respostas);
        return Promise.resolve(new Response(JSON.stringify(respostas.shift())));
      },
    );
    return { captcha, enviados };
  }

  it('confere o token no provedor com segredo e IP; só sucesso para o próprio host passa', async () => {
    const { captcha, enviados } = turnstile([{ success: false }, { success: true, hostname: 'outro.example' }, { success: true, hostname: 'lastro.example' }]);
    const a = portal({ captcha });
    for (const status of [400, 400, 200]) {
      const r = await a.inject({ method: 'POST', url: '/perguntar', remoteAddress: '203.0.113.9', ...form({ pergunta: 'Quando vale?', 'cf-turnstile-response': 'token.valido-1' }) });
      expect(r.statusCode).toBe(status);
    }
    expect(chamadas).toHaveLength(1);
    expect(enviados[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(Object.fromEntries(new URLSearchParams(enviados[0]?.corpo))).toEqual({ secret: 'segredo-'.repeat(4), response: 'token.valido-1', remoteip: '203.0.113.9' });
  });

  it('sem token ou com provedor fora do ar, falha fechado sem chamar o modelo', async () => {
    const { captcha, enviados } = turnstile(new Error('timeout'));
    const a = portal({ captcha });
    expect((await a.inject({ method: 'POST', url: '/perguntar', ...form({ pergunta: 'Quando vale?' }) })).statusCode).toBe(400);
    expect(enviados).toHaveLength(0);
    expect((await a.inject({ method: 'POST', url: '/perguntar', ...form({ pergunta: 'Quando vale?', 'cf-turnstile-response': 'tok' }) })).statusCode).toBe(400);
    expect(enviados).toHaveLength(1);
    expect(chamadas).toHaveLength(0);
  });

  it('configuração incompleta não sobe', () => {
    expect(() => criarCaptcha({ provedor: 'hcaptcha', chaveSite: 'abc', segredo: 'x'.repeat(32), hostEsperado: 'h' })).toThrow(ErroConfigCaptcha);
    expect(() => criarCaptcha({ provedor: 'hcaptcha', chaveSite: '10000000-ffff', segredo: '', hostEsperado: 'h' })).toThrow(ErroConfigCaptcha);
  });
});

describe('limites por IP', () => {
  it('consultas ao modelo por hora; pedido barrado no CAPTCHA não gasta o limite', async () => {
    const a = portal({}, { limiteLlmPorHoraIp: 2 });
    const pedir = (ip: string) => a.inject({ method: 'POST', url: '/perguntar', remoteAddress: ip, ...form({ pergunta: 'Quando vale?' }) });
    expect((await pedir('198.51.100.1')).statusCode).toBe(200);
    expect((await pedir('198.51.100.1')).statusCode).toBe(200);
    expect((await pedir('198.51.100.1')).statusCode).toBe(429);
    expect((await pedir('198.51.100.2')).statusCode).toBe(200);

    const { captcha } = { captcha: criarCaptcha({ provedor: 'turnstile', chaveSite: '0x4AAAAAAAteste', segredo: 's'.repeat(32), hostEsperado: 'lastro.example' }, () => Promise.resolve(new Response('{"success":false}'))) };
    const b = portal({ captcha }, { limiteLlmPorHoraIp: 1 });
    for (let i = 0; i < 3; i++) {
      const r = await b.inject({ method: 'POST', url: '/perguntar', remoteAddress: '198.51.100.3', ...form({ pergunta: 'Quando vale?', 'cf-turnstile-response': 'tok' }) });
      expect(r.statusCode).toBe(400);
    }
  });

  it('requisições por minuto em qualquer página', async () => {
    const a = portal({}, { limitePorMinutoIp: 2 });
    expect((await a.inject('/')).statusCode).toBe(200);
    expect((await a.inject('/verificar')).statusCode).toBe(200);
    const r = await a.inject('/');
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('IP do cliente vem do X-Forwarded-For só quando o proxy é confiável', async () => {
    const a = portal({}, { limiteLlmPorHoraIp: 1, proxyConfiavel: ['127.0.0.1'] });
    const pedir = (ip: string) =>
      a.inject({ method: 'POST', url: '/perguntar', remoteAddress: '127.0.0.1', ...form({ pergunta: 'Quando vale?' }), headers: { ...form({}).headers, 'x-forwarded-for': ip } });
    expect((await pedir('198.51.100.7')).statusCode).toBe(200);
    expect((await pedir('198.51.100.8')).statusCode).toBe(200);
    expect((await pedir('198.51.100.7')).statusCode).toBe(429);

    const semProxy = portal({}, { limiteLlmPorHoraIp: 1 });
    const falsificado = (ip: string) =>
      semProxy.inject({ method: 'POST', url: '/perguntar', remoteAddress: '203.0.113.50', ...form({ pergunta: 'Quando vale?' }), headers: { ...form({}).headers, 'x-forwarded-for': ip } });
    expect((await falsificado('198.51.100.20')).statusCode).toBe(200);
    expect((await falsificado('198.51.100.21')).statusCode).toBe(429);
  });
});

describe('verificar', () => {
  it('verifica em nome do portal e redireciona para a página canônica do link compartilhado', async () => {
    const r = await portal().inject({ method: 'POST', url: '/verificar', ...form({ texto: 'Todo MEI precisa emitir NFS-e nacional desde setembro.', data_conteudo: '2026-09-02' }) });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`https://api.lastro.example/verificacoes/${TOKEN}`);
    expect(chamadas).toEqual([
      { tipo: 'verificacao', solicitante: { clienteId: CLIENTE, chaveId: null, canal: 'portal' }, texto: 'Todo MEI precisa emitir NFS-e nacional desde setembro.', data: '2026-09-02' },
    ]);
  });

  it('data vazia é opcional; texto curto e data inválida são recusados', async () => {
    expect((await portal().inject({ method: 'POST', url: '/verificar', ...form({ texto: 'Todo MEI precisa emitir NFS-e.', data_conteudo: '' }) })).statusCode).toBe(303);
    expect((await portal().inject({ method: 'POST', url: '/verificar', ...form({ texto: 'curto' }) })).statusCode).toBe(400);
    expect((await portal().inject({ method: 'POST', url: '/verificar', ...form({ texto: 'Todo MEI precisa emitir NFS-e.', data_conteudo: '02/09/2026' }) })).statusCode).toBe(400);
  });
});
