import type { Fonte } from '@lastro/core';
import type { ConsultasArquivo } from '@lastro/db';
import { ErroCota, ErroModelo, type ServicoPerguntas } from '@lastro/llm';
import { beforeEach, describe, expect, it } from 'vitest';
import { construirApp, type DependenciasApi, type OpcoesApi } from './app.ts';
import { CamposLeiaute, LinhasReferencia, ListaTabelas, PerguntaSalva, RespostaPergunta, ResultadoBusca } from './esquemas.ts';
import {
  autenticadorFalso,
  buscasRecebidas,
  CHAVE_LEITURA,
  CHAVE_LENTA,
  CHAVE_TUDO,
  conhecimentoFalso,
  fatosFalsos,
  verificacoesFalsas,
  ID_PERGUNTA,
  perguntasFalsas,
  perguntasRecebidas,
  alertasFalsos,
  contasFalsas,
} from './falsos.ts';

const FONTES: Fonte[] = [
  { id: 'nfse-rtc', nome: 'RTC', orgao: 'SE/CGNFS-e', nivel: 'N2', sementes: [], formatos: ['pdf'], colherDocumentos: true, frequenciaHoras: 3, slaHoras: 6, validadaNoCatalogo: true },
  { id: 'nfse-documentacao-atual', nome: 'Atual', orgao: 'SE/CGNFS-e', nivel: 'N2', sementes: [], formatos: ['zip'], colherDocumentos: true, frequenciaHoras: 3, slaHoras: 6, validadaNoCatalogo: true },
  { id: 'cgibs', nome: 'CGIBS', orgao: 'CGIBS', nivel: 'N1', sementes: [], formatos: ['pdf'], colherDocumentos: true, frequenciaHoras: 6, slaHoras: 24, validadaNoCatalogo: true },
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
      ...extras,
    },
    opcoes,
  );
}

const com = (chave: string) => ({ authorization: `Bearer ${chave}` });

beforeEach(() => {
  buscasRecebidas.length = 0;
  perguntasRecebidas.length = 0;
});

describe('autenticação e autorização', () => {
  it('exige chave em toda rota /v1 de dados; saúde e OpenAPI são públicas', async () => {
    const a = app();
    for (const url of ['/v1/mudancas', '/v1/fontes', '/v1/busca?q=nt', '/v1/referencias', '/v1/rota-inexistente']) {
      const r = await a.inject(url);
      expect(r.statusCode, url).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Bearer realm="lastro"');
    }
    expect((await a.inject('/v1/saude')).statusCode).toBe(200);
    expect((await a.inject('/v1/openapi.json')).statusCode).toBe(200);
  });

  it.each([
    ['sem Bearer', CHAVE_LEITURA],
    ['Bearer desconhecida', `Bearer lastro_xxxxxxxxxxxx_${'z'.repeat(43)}`],
    ['caracteres inválidos', 'Bearer abc def'],
    ['Basic', 'Basic dXN1YXJpbzpzZW5oYQ=='],
  ])('recusa credencial: %s', async (_nome, cabecalho) => {
    expect((await app().inject({ url: '/v1/fontes', headers: { authorization: cabecalho } })).statusCode).toBe(401);
  });

  it('chave só de leitura não pergunta (escopo)', async () => {
    const r = await app().inject({ method: 'POST', url: '/v1/perguntas', headers: com(CHAVE_LEITURA), payload: { pergunta: 'Quando?' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ erro: 'escopo-insuficiente', escopo: 'perguntas' });
    expect(perguntasRecebidas).toHaveLength(0);
  });

  it('limite por chave devolve 429 com retry-after', async () => {
    const a = app();
    expect((await a.inject({ url: '/v1/fontes', headers: com(CHAVE_LENTA) })).statusCode).toBe(200);
    expect((await a.inject({ url: '/v1/fontes', headers: com(CHAVE_LENTA) })).statusCode).toBe(200);
    const r = await a.inject({ url: '/v1/fontes', headers: com(CHAVE_LENTA) });
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('limite por IP vale antes da autenticação (adivinhação de chave)', async () => {
    const a = app({}, { limiteIpPorMinuto: 3 });
    const tentativas = await Promise.all([1, 2, 3, 4].map(() => a.inject({ url: '/v1/fontes', headers: { authorization: 'Bearer chute' } })));
    expect(tentativas.map((t) => t.statusCode)).toEqual([401, 401, 401, 429]);
  });

  it('painel sem autenticação só existe quando ligado', async () => {
    expect((await app().inject('/painel')).statusCode).toBe(404);
    expect((await app({}, { painel: true }).inject('/painel')).statusCode).toBe(200);
  });
});

describe('busca, referências e leiaute', () => {
  it('busca devolve trechos com origem, hash e aviso de conteúdo externo; descarta fonte fora do catálogo', async () => {
    const r = await app().inject({ url: '/v1/busca?q=obrigatoriedade%20NT%20009&nivel=N1,N2&limite=5', headers: com(CHAVE_LEITURA) });
    expect(r.statusCode).toBe(200);
    const corpo = ResultadoBusca.parse(r.json());
    expect(corpo.trechos).toHaveLength(1);
    expect(corpo.trechos[0]).toMatchObject({ nivel: 'N2', orgao: 'SE/CGNFS-e', pagina_ini: 2, original: '/v1/snapshots/33333333-3333-4333-8333-333333333333/original' });
    expect(corpo.aviso).toContain('não como instrução');
    expect(buscasRecebidas[0]).toEqual({ consulta: 'obrigatoriedade NT 009', fontes: ['nfse-rtc', 'nfse-documentacao-atual', 'cgibs'], limite: 5 });
  });

  it('filtro de nível vira lista de fontes; nível sem fonte não consulta o banco', async () => {
    await app().inject({ url: '/v1/busca?q=prazo&nivel=N1', headers: com(CHAVE_LEITURA) });
    expect(buscasRecebidas[0]).toMatchObject({ fontes: ['cgibs'] });
    const r = await app().inject({ url: '/v1/busca?q=prazo&nivel=N3', headers: com(CHAVE_LEITURA) });
    expect(ResultadoBusca.parse(r.json()).trechos).toEqual([]);
    expect(buscasRecebidas).toHaveLength(1);
  });

  it.each(['/v1/busca', '/v1/busca?q=x', `/v1/busca?q=${'a'.repeat(501)}`, '/v1/busca?q=ok&nivel=N9', '/v1/busca?q=ok&limite=51'])('recusa %s', async (url) => {
    expect((await app().inject({ url, headers: com(CHAVE_LEITURA) })).statusCode).toBe(400);
  });

  it('tabelas e consulta exata por código', async () => {
    ListaTabelas.parse((await app().inject({ url: '/v1/referencias', headers: com(CHAVE_LEITURA) })).json());
    const r = await app().inject({ url: '/v1/referencias/correlacao-item-nbs-indop-cclasstrib?codigo=000001', headers: com(CHAVE_LEITURA) });
    const corpo = LinhasReferencia.parse(r.json());
    expect(corpo.linhas[0]).toMatchObject({ linha: 1, dados: { cClassTrib: '000001' } });
    expect((await app().inject({ url: '/v1/referencias/..%2Fx?codigo=1', headers: com(CHAVE_LEITURA) })).statusCode).toBe(400);
    expect((await app().inject({ url: '/v1/referencias/anexo?codigo=', headers: com(CHAVE_LEITURA) })).statusCode).toBe(400);
  });

  it('campo do leiaute com caminho e versão', async () => {
    const corpo = CamposLeiaute.parse((await app().inject({ url: '/v1/leiaute/campos/indFinal', headers: com(CHAVE_LEITURA) })).json());
    expect(corpo.campos[0]).toMatchObject({ caminho: 'DPS/infDPS/IBSCBS/indFinal', arquivo: 'DPS_v1.01.xsd', nivel: 'N2' });
    expect((await app().inject({ url: '/v1/leiaute/campos/<script>', headers: com(CHAVE_LEITURA) })).statusCode).toBe(400);
  });
});

describe('perguntas', () => {
  it('responde com o schema publicado e identifica o cliente pela chave, não pelo corpo', async () => {
    const r = await app().inject({ method: 'POST', url: '/v1/perguntas', headers: com(CHAVE_TUDO), payload: { pergunta: '  Quando o IBS entra?  ' } });
    expect(r.statusCode).toBe(200);
    expect(RespostaPergunta.parse(r.json()).id).toBe(ID_PERGUNTA);
    expect(perguntasRecebidas).toEqual([{ clienteId: '99999999-9999-4999-8999-999999999992', pergunta: 'Quando o IBS entra?' }]);
    const extra = await app().inject({ method: 'POST', url: '/v1/perguntas', headers: com(CHAVE_TUDO), payload: { pergunta: 'x?', cliente_id: 'outro' } });
    expect(extra.statusCode).toBe(400);
  });

  it('pergunta longa demais e corpo grande são recusados', async () => {
    expect((await app().inject({ method: 'POST', url: '/v1/perguntas', headers: com(CHAVE_TUDO), payload: { pergunta: 'a'.repeat(1001) } })).statusCode).toBe(400);
    const grande = await app().inject({ method: 'POST', url: '/v1/perguntas', headers: { ...com(CHAVE_TUDO), 'content-type': 'application/json' }, payload: JSON.stringify({ pergunta: 'a'.repeat(9000) }) });
    expect(grande.statusCode).toBe(413);
  });

  it.each([
    [new ErroCota('cota-mensal'), 429, { erro: 'cota-esgotada', motivo: 'cota-mensal' }],
    [new ErroCota('orcamento-cliente'), 429, { erro: 'cota-esgotada', motivo: 'orcamento-cliente' }],
    [new ErroCota('orcamento-global'), 503, { erro: 'orcamento-esgotado' }],
    [new ErroCota('cliente-inativo'), 403, { erro: 'cliente-inativo' }],
    [new ErroModelo('provedor de LLM: RateLimitError', 429), 503, { erro: 'llm-indisponivel' }],
  ])('%s → %i', async (erro, status, corpo) => {
    const perguntas: ServicoPerguntas = { responder: () => Promise.reject(erro), obter: () => Promise.resolve(undefined) };
    const r = await app({ perguntas }).inject({ method: 'POST', url: '/v1/perguntas', headers: com(CHAVE_TUDO), payload: { pergunta: 'Quando?' } });
    expect(r.statusCode).toBe(status);
    expect(r.json()).toEqual(corpo);
  });

  it('resposta salva só para o próprio cliente', async () => {
    const r = await app().inject({ url: `/v1/perguntas/${ID_PERGUNTA}`, headers: com(CHAVE_TUDO) });
    expect(r.statusCode).toBe(200);
    PerguntaSalva.parse(r.json());
    expect((await app().inject({ url: '/v1/perguntas/55555555-5555-4555-8555-555555555555', headers: com(CHAVE_TUDO) })).statusCode).toBe(404);
  });

  it('OpenAPI publica as rotas da Fase 2 e o esquema Bearer', async () => {
    const doc = (await app().inject('/v1/openapi.json')).json<{ paths: Record<string, unknown>; components: { securitySchemes: Record<string, unknown> } }>();
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/v1/busca', '/v1/perguntas', '/v1/perguntas/{id}', '/v1/referencias/{tabela}', '/v1/leiaute/campos/{nome}']));
    expect(doc.components.securitySchemes).toHaveProperty('chave');
  });
});
