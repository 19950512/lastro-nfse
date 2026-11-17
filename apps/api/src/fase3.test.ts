import type { Fonte } from '@lastro/core';
import type { ConsultasArquivo } from '@lastro/db';
import { ErroCota, type ServicoVerificacoes } from '@lastro/llm';
import { beforeEach, describe, expect, it } from 'vitest';
import { construirApp, type DependenciasApi, type OpcoesApi } from './app.ts';
import { Compartilhamento, ListaFatos, ListaTemas, RespostaVerificacao, VerificacaoPublica, VerificacaoSalva } from './esquemas.ts';
import {
  autenticadorFalso,
  CHAVE_LEITURA,
  CHAVE_TUDO,
  CHAVE_VERIFICACOES,
  conhecimentoFalso,
  fatoFalso,
  fatosFalsos,
  filtrosFatos,
  ID_VERIFICACAO,
  perguntasFalsas,
  TOKEN_COMPARTILHADO,
  TOKEN_RECALL,
  verificacoesFalsas,
  verificacoesRecebidas,
  alertasFalsos,
  contasFalsas,
} from './falsos.ts';

const FONTES: Fonte[] = [
  { id: 'nfse-rtc', nome: 'RTC', orgao: 'SE/CGNFS-e', nivel: 'N2', sementes: [], formatos: ['pdf'], colherDocumentos: true, frequenciaHoras: 3, slaHoras: 6, validadaNoCatalogo: true },
];

const consultasVazias: ConsultasArquivo = {
  listarMudancas: () => Promise.resolve({ itens: [], proximo: null }),
  listarDocumentos: () => Promise.resolve({ itens: [], proximo: null }),
  obterDocumento: () => Promise.resolve(undefined),
  obterSnapshot: () => Promise.resolve(undefined),
  resumoFontes: () => Promise.resolve([]),
};

function app(extras: Partial<DependenciasApi> = {}, opcoes: OpcoesApi = {}) {
  return construirApp(
    {
      consultas: consultasVazias,
      lerOriginal: () => Promise.resolve(Buffer.alloc(0)),
      fontes: FONTES,
      autenticacao: autenticadorFalso,
      conhecimento: conhecimentoFalso,
      perguntas: perguntasFalsas,
      fatos: fatosFalsos,
      verificacoes: verificacoesFalsas,
      contas: contasFalsas,
      alertas: alertasFalsos,
      urlPublica: 'https://api.lastro.example///',
      ...extras,
    },
    opcoes,
  );
}

const com = (chave: string) => ({ authorization: `Bearer ${chave}` });
const OUTRA = '15151515-1515-4515-8515-151515151515';

beforeEach(() => {
  filtrosFatos.length = 0;
  verificacoesRecebidas.length = 0;
});

describe('fatos aprovados', () => {
  it('exige chave; devolve fatos com evidência de origem oficial e descarta fonte fora do catálogo', async () => {
    expect((await app().inject('/v1/fatos')).statusCode).toBe(401);
    const r = await app().inject({ url: '/v1/fatos?tema=ibs-cbs-nfse&q=obrigatoriedade%20IBS&incluir_inativos=true&limite=5', headers: com(CHAVE_LEITURA) });
    expect(r.statusCode).toBe(200);
    const corpo = ListaFatos.parse(r.json());
    expect(corpo.fatos).toHaveLength(1);
    expect(corpo.fatos[0]).toMatchObject({ id: fatoFalso.id, situacao: 'aprovado', evidencia: { nivel: 'N2', orgao: 'SE/CGNFS-e', trecho_id: fatoFalso.evidencia.trechoId } });
    expect(filtrosFatos[0]).toEqual({ tema: 'ibs-cbs-nfse', consulta: 'obrigatoriedade IBS', incluirInativos: true, limite: 5 });
  });

  it.each(['/v1/fatos?tema=Tema%20Ruim', '/v1/fatos?limite=101', '/v1/fatos?extra=1', '/v1/fatos/nao-uuid'])('recusa %s', async (url) => {
    expect((await app().inject({ url, headers: com(CHAVE_LEITURA) })).statusCode).toBe(400);
  });

  it('temas e fato por id', async () => {
    expect(ListaTemas.parse((await app().inject({ url: '/v1/fatos/temas', headers: com(CHAVE_LEITURA) })).json()).temas).toEqual([{ tema: 'ibs-cbs-nfse', fatos: 1 }]);
    expect((await app().inject({ url: `/v1/fatos/${fatoFalso.id}`, headers: com(CHAVE_LEITURA) })).statusCode).toBe(200);
    expect((await app().inject({ url: `/v1/fatos/${OUTRA}`, headers: com(CHAVE_LEITURA) })).statusCode).toBe(404);
  });
});

describe('verificações', () => {
  const pedido = { texto: 'Desde setembro todo o Simples é obrigado a usar o emissor nacional.', data_conteudo: '2026-08-20' };

  it('exige o escopo verificacoes; o cliente vem da chave, não do corpo', async () => {
    const semEscopo = await app().inject({ method: 'POST', url: '/v1/verificacoes', headers: com(CHAVE_LEITURA), payload: pedido });
    expect(semEscopo.statusCode).toBe(403);
    expect(semEscopo.json()).toEqual({ erro: 'escopo-insuficiente', escopo: 'verificacoes' });
    const r = await app().inject({ method: 'POST', url: '/v1/verificacoes', headers: com(CHAVE_VERIFICACOES), payload: pedido });
    expect(r.statusCode).toBe(200);
    expect(RespostaVerificacao.parse(r.json()).id).toBe(ID_VERIFICACAO);
    expect(verificacoesRecebidas).toEqual([{ clienteId: '99999999-9999-4999-8999-999999999994', texto: pedido.texto, dataConteudo: '2026-08-20' }]);
    const contrabando = await app().inject({ method: 'POST', url: '/v1/verificacoes', headers: com(CHAVE_VERIFICACOES), payload: { ...pedido, cliente_id: OUTRA } });
    expect(contrabando.statusCode).toBe(400);
  });

  it('limites de tamanho do texto e do corpo', async () => {
    const curto = await app().inject({ method: 'POST', url: '/v1/verificacoes', headers: com(CHAVE_TUDO), payload: { texto: 'curto' } });
    expect(curto.statusCode).toBe(400);
    expect((await app().inject({ method: 'POST', url: '/v1/verificacoes', headers: com(CHAVE_TUDO), payload: { texto: 'a'.repeat(5001) } })).statusCode).toBe(400);
    const enorme = await app().inject({
      method: 'POST',
      url: '/v1/verificacoes',
      headers: { ...com(CHAVE_TUDO), 'content-type': 'application/json' },
      payload: JSON.stringify({ texto: 'a'.repeat(17_000) }),
    });
    expect(enorme.statusCode).toBe(413);
  });

  it('cota esgotada vira 429 sem chamar nada', async () => {
    const verificacoes: ServicoVerificacoes = { ...verificacoesFalsas, verificar: () => Promise.reject(new ErroCota('cota-mensal')) };
    const r = await app({ verificacoes }).inject({ method: 'POST', url: '/v1/verificacoes', headers: com(CHAVE_TUDO), payload: pedido });
    expect(r.statusCode).toBe(429);
  });

  it('verificação salva só para o próprio cliente', async () => {
    const r = await app().inject({ url: `/v1/verificacoes/${ID_VERIFICACAO}`, headers: com(CHAVE_TUDO) });
    expect(r.statusCode).toBe(200);
    expect(VerificacaoSalva.parse(r.json()).compartilhada).toBe(false);
    expect((await app().inject({ url: `/v1/verificacoes/${ID_VERIFICACAO}`, headers: com(CHAVE_VERIFICACOES) })).statusCode).toBe(404);
  });

  it('compartilhamento: link com a origem pública, só pelo dono, revogável', async () => {
    const r = await app().inject({ method: 'POST', url: `/v1/verificacoes/${ID_VERIFICACAO}/compartilhamento`, headers: com(CHAVE_TUDO) });
    expect(r.statusCode).toBe(200);
    expect(Compartilhamento.parse(r.json())).toEqual({ link: `https://api.lastro.example/verificacoes/${TOKEN_COMPARTILHADO}`, api: `/v1/publico/verificacoes/${TOKEN_COMPARTILHADO}` });
    expect((await app().inject({ method: 'POST', url: `/v1/verificacoes/${ID_VERIFICACAO}/compartilhamento`, headers: com(CHAVE_VERIFICACOES) })).statusCode).toBe(404);
    expect((await app().inject({ method: 'DELETE', url: `/v1/verificacoes/${ID_VERIFICACAO}/compartilhamento`, headers: com(CHAVE_TUDO) })).statusCode).toBe(204);
    expect((await app().inject({ method: 'DELETE', url: `/v1/verificacoes/${OUTRA}/compartilhamento`, headers: com(CHAVE_TUDO) })).statusCode).toBe(404);
  });
});

describe('link compartilhável (público)', () => {
  it('JSON público sem chave; token inválido ou desconhecido não revela nada', async () => {
    const r = await app().inject(`/v1/publico/verificacoes/${TOKEN_COMPARTILHADO}`);
    expect(r.statusCode).toBe(200);
    const corpo = VerificacaoPublica.parse(r.json());
    expect(corpo).not.toHaveProperty('entrada');
    expect((await app().inject('/v1/publico/verificacoes/curto')).statusCode).toBe(400);
    expect((await app().inject(`/v1/publico/verificacoes/${'x'.repeat(43)}`)).statusCode).toBe(404);
  });

  it('[XSS] página sem script: CSP restrita, todo texto escapado, link javascript: neutralizado', async () => {
    const r = await app().inject(`/verificacoes/${TOKEN_COMPARTILHADO}`);
    expect(r.statusCode).toBe(200);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers['x-robots-tag']).toBe('noindex');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body).not.toMatch(/<script/i);
    expect(r.body).not.toMatch(/<img/i);
    expect(r.body).not.toContain('javascript:');
    expect(r.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.body).toContain('href="#"');
    expect(r.body).toContain('CONFIRMADO');
    expect(r.body).not.toContain('Correção:');
  });

  it('[recall] verificação que usou fato revogado mostra aviso de correção, escapado', async () => {
    const r = await app().inject(`/verificacoes/${TOKEN_RECALL}`);
    expect(r.body).toContain('Correção:');
    expect(r.body).toContain('Fato errado');
    expect(r.body).not.toMatch(/<script/i);
    expect(VerificacaoPublica.parse((await app().inject(`/v1/publico/verificacoes/${TOKEN_RECALL}`)).json()).correcoes).toHaveLength(1);
  });

  it('token desconhecido: 404 em texto, ainda com CSP; limite por IP vale nas rotas públicas', async () => {
    const r = await app().inject('/verificacoes/qualquer-coisa');
    expect(r.statusCode).toBe(404);
    expect(String(r.headers['content-type'])).toContain('text/plain');
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
    const a = app({}, { limiteIpPorMinuto: 2 });
    const status = [];
    for (let i = 0; i < 3; i++) status.push((await a.inject(`/verificacoes/${TOKEN_COMPARTILHADO}`)).statusCode);
    expect(status).toEqual([200, 200, 429]);
  });

  it('OpenAPI publica as rotas da Fase 3', async () => {
    const doc = (await app().inject('/v1/openapi.json')).json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/fatos', '/v1/fatos/{id}', '/v1/verificacoes', '/v1/verificacoes/{id}', '/v1/verificacoes/{id}/compartilhamento', '/v1/publico/verificacoes/{token}']),
    );
  });
});
