import type { Fonte } from '@lastro/core';
import type { ConsultasArquivo } from '@lastro/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { construirApp, type DependenciasApi, type OpcoesApi } from './app.ts';
import { AlertaCriado, ListaAlertas, RespostaUso } from './esquemas.ts';
import {
  alertasCriados,
  alertasFalsos,
  autenticadorFalso,
  CHAVE_ALERTAS,
  CHAVE_LEITURA,
  CHAVE_VERIFICACOES,
  conhecimentoFalso,
  contagensGravadas,
  contasFalsas,
  fatosFalsos,
  ID_ALERTA,
  perguntasFalsas,
  verificacoesFalsas,
  XSS_ALERTA,
} from './falsos.ts';
import { MedidorUso } from './medidor.ts';

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

const AGORA = new Date('2026-11-17T15:00:00.000Z');

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
      agora: () => AGORA,
      ...extras,
    },
    opcoes,
  );
}

const com = (chave: string) => ({ authorization: `Bearer ${chave}` });
const CLIENTE_ALERTAS = '99999999-9999-4999-8999-999999999995';

beforeEach(() => {
  alertasCriados.length = 0;
  contagensGravadas.length = 0;
});

describe('uso e plano (GET /v1/uso)', () => {
  it('vale para chave de qualquer escopo e soma as métricas por dia', async () => {
    const r = await app().inject({ url: '/v1/uso', headers: com(CHAVE_VERIFICACOES) });
    expect(r.statusCode).toBe(200);
    const corpo = RespostaUso.parse(r.json());
    expect(corpo.plano).toEqual({ id: 'padrao', nome: 'Padrão' });
    expect(corpo.limites).toMatchObject({ perguntas_por_mes: 1000, verificacoes_por_mes: 500, alertas_ativos: 2 });
    expect(corpo.mes_corrente).toEqual({ inicio: '2026-11-01', perguntas: 3, verificacoes: 1, gasto_usd: 0.42 });
    expect(corpo.dias).toEqual([
      { dia: '2026-11-15', requisicoes: 40, perguntas: 2, perguntas_fora_do_escopo: 0, verificacoes: 0, custo_usd: 0.3 },
      { dia: '2026-11-16', requisicoes: 0, perguntas: 0, perguntas_fora_do_escopo: 1, verificacoes: 1, custo_usd: 0.12 },
    ]);
  });

  it('filtra o intervalo e recusa intervalo invertido ou longo demais', async () => {
    const r = await app().inject({ url: '/v1/uso?desde=2026-11-16&ate=2026-11-16', headers: com(CHAVE_LEITURA) });
    expect(RespostaUso.parse(r.json()).dias.map((d) => d.dia)).toEqual(['2026-11-16']);
    expect((await app().inject({ url: '/v1/uso?desde=2026-11-17&ate=2026-11-01', headers: com(CHAVE_LEITURA) })).statusCode).toBe(400);
    expect((await app().inject({ url: '/v1/uso?desde=2026-01-01&ate=2026-11-01', headers: com(CHAVE_LEITURA) })).statusCode).toBe(400);
    expect((await app().inject({ url: '/v1/uso?cliente=outro', headers: com(CHAVE_LEITURA) })).statusCode).toBe(400);
  });

  it('exige chave', async () => {
    expect((await app().inject('/v1/uso')).statusCode).toBe(401);
  });
});

describe('medição de requisições', () => {
  it('conta só requisições autenticadas, por cliente e dia, e grava ao encerrar', async () => {
    const a = app();
    await a.inject({ url: '/v1/fontes', headers: com(CHAVE_LEITURA) });
    await a.inject({ url: '/v1/fontes', headers: com(CHAVE_LEITURA) });
    await a.inject({ url: '/v1/uso', headers: com(CHAVE_VERIFICACOES) });
    await a.inject({ url: '/v1/fontes', headers: com('lastro_invalida0000_x') });
    await a.inject('/v1/saude');
    await a.close();
    expect(contagensGravadas).toEqual(
      expect.arrayContaining([
        { clienteId: '99999999-9999-4999-8999-999999999991', dia: '2026-11-17', quantidade: 2 },
        { clienteId: '99999999-9999-4999-8999-999999999994', dia: '2026-11-17', quantidade: 1 },
      ]),
    );
    expect(contagensGravadas).toHaveLength(2);
  });

  it('lote que falha volta para a fila e soma com o próximo', async () => {
    let falhar = true;
    const gravados: { clienteId: string; quantidade: number }[] = [];
    const m = new MedidorUso(
      (c) => {
        if (falhar) return Promise.reject(new Error('banco fora'));
        gravados.push(...c.map(({ clienteId, quantidade }) => ({ clienteId, quantidade })));
        return Promise.resolve();
      },
      () => AGORA,
    );
    m.contar('c1');
    m.contar('c1');
    await expect(m.descarregar()).rejects.toThrow('banco fora');
    falhar = false;
    m.contar('c1');
    await m.descarregar();
    expect(gravados).toEqual([{ clienteId: 'c1', quantidade: 3 }]);
    await m.descarregar();
    expect(gravados).toHaveLength(1);
  });
});

describe('alertas por tema (/v1/alertas)', () => {
  const pedido = {
    nome: 'Cronograma IBS/CBS',
    url: 'https://hooks.cliente.example/lastro',
    termos: ['cronograma IBS/CBS', 'prazo'],
    temas: ['cronograma-ibs-cbs'],
    tipos: ['nova-versao', 'fato-aprovado'],
  };

  it('exige o escopo alertas; o cliente e o limite vêm da chave e do plano', async () => {
    const semEscopo = await app().inject({ method: 'POST', url: '/v1/alertas', headers: com(CHAVE_LEITURA), payload: pedido });
    expect(semEscopo.statusCode).toBe(403);
    expect(semEscopo.json()).toEqual({ erro: 'escopo-insuficiente', escopo: 'alertas' });
    const r = await app().inject({ method: 'POST', url: '/v1/alertas', headers: com(CHAVE_ALERTAS), payload: pedido });
    expect(r.statusCode).toBe(201);
    expect(AlertaCriado.parse(r.json())).toEqual({ id: ID_ALERTA, segredo: 's'.repeat(64) });
    expect(alertasCriados).toEqual([{ clienteId: CLIENTE_ALERTAS, maxAlertas: 2, novo: { ...pedido, formato: 'lastro' } }]);
  });

  it.each([
    ['campo extra (cliente de outro)', { cliente_id: CLIENTE_ALERTAS }],
    ['tema fora do formato', { temas: ['Tema Ruim'] }],
    ['termo curto demais', { termos: ['x'] }],
    ['tipo de evento desconhecido', { tipos: ['qualquer'] }],
    ['formato desconhecido', { formato: 'email' }],
    ['termos demais', { termos: Array.from({ length: 21 }, (_, i) => `termo ${String(i)}`) }],
  ])('recusa %s', async (_nome, extra) => {
    const r = await app().inject({ method: 'POST', url: '/v1/alertas', headers: com(CHAVE_ALERTAS), payload: { ...pedido, ...extra } });
    expect(r.statusCode).toBe(400);
    expect(alertasCriados).toHaveLength(0);
  });

  it('destino inseguro vira 400 com o motivo; limite do plano vira 403', async () => {
    const inseguro = await app().inject({ method: 'POST', url: '/v1/alertas', headers: com(CHAVE_ALERTAS), payload: { ...pedido, url: 'https://10.0.0.1/x' } });
    expect(inseguro.statusCode).toBe(400);
    expect(inseguro.json()).toMatchObject({ erro: 'alerta-invalido' });
    const a = app();
    for (let i = 0; i < 2; i++) expect((await a.inject({ method: 'POST', url: '/v1/alertas', headers: com(CHAVE_ALERTAS), payload: pedido })).statusCode).toBe(201);
    const excedente = await a.inject({ method: 'POST', url: '/v1/alertas', headers: com(CHAVE_ALERTAS), payload: pedido });
    expect(excedente.statusCode).toBe(403);
    expect(excedente.json()).toMatchObject({ erro: 'limite-do-plano' });
  });

  it('lista só os do cliente e remove pelo id', async () => {
    const lista = ListaAlertas.parse((await app().inject({ url: '/v1/alertas', headers: com(CHAVE_ALERTAS) })).json());
    expect(lista.alertas).toHaveLength(1);
    expect(lista.alertas[0]).toMatchObject({ id: ID_ALERTA, nome: XSS_ALERTA, termos: ['cronograma IBS/CBS'], temas: ['cronograma-ibs-cbs'] });
    expect(JSON.stringify(lista)).not.toContain('segredo');
    expect((await app().inject({ method: 'DELETE', url: `/v1/alertas/${ID_ALERTA}`, headers: com(CHAVE_ALERTAS) })).statusCode).toBe(204);
    expect((await app().inject({ method: 'DELETE', url: '/v1/alertas/17171717-1717-4717-8717-171717171717', headers: com(CHAVE_ALERTAS) })).statusCode).toBe(404);
    expect((await app().inject({ method: 'DELETE', url: '/v1/alertas/nao-uuid', headers: com(CHAVE_ALERTAS) })).statusCode).toBe(400);
  });

  it('OpenAPI publica as rotas novas', async () => {
    const doc = (await app().inject('/v1/openapi.json')).json<{ paths: Record<string, Record<string, unknown>> }>();
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/v1/uso', '/v1/alertas', '/v1/alertas/{id}']));
    expect(Object.keys(doc.paths['/v1/alertas'] ?? {})).toEqual(['post', 'get']);
  });
});

describe('security.txt (RFC 9116)', () => {
  it('sem configuração, 404', async () => {
    expect((await app().inject('/.well-known/security.txt')).statusCode).toBe(404);
  });

  it('com configuração, texto com contato e validade; vencido some', async () => {
    const securityTxt = { contato: 'mailto:seguranca@lastro.example', expira: '2027-06-01', politica: 'https://lastro.example/seguranca' };
    const r = await app({}, { securityTxt }).inject('/.well-known/security.txt');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toBe('Contact: mailto:seguranca@lastro.example\nExpires: 2027-06-01T00:00:00.000Z\nPreferred-Languages: pt, en\nPolicy: https://lastro.example/seguranca\n');
    const vencido = await app({ agora: () => new Date('2027-06-02T00:00:00Z') }, { securityTxt }).inject('/.well-known/security.txt');
    expect(vencido.statusCode).toBe(404);
  });
});
