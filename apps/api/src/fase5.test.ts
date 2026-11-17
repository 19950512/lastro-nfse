import { FONTES } from '@lastro/core';
import type { AliquotaEncontrada, ConsultasArquivo, ConsultasIss, TabelaAliquotasVigente } from '@lastro/db';
import type { RespostaPergunta, ServicoPerguntas } from '@lastro/llm';
import { describe, expect, it } from 'vitest';
import { construirApp, type DependenciasApi } from './app.ts';
import { AliquotasIss, ListaMunicipiosIss, RespostaPergunta as EsquemaResposta } from './esquemas.ts';
import { alertasFalsos, autenticadorFalso, CHAVE_LEITURA, CHAVE_TUDO, conhecimentoFalso, contasFalsas, fatosFalsos, perguntasFalsas, verificacoesFalsas } from './falsos.ts';

const consultasVazias: ConsultasArquivo = {
  listarMudancas: () => Promise.resolve({ itens: [], proximo: null }),
  listarDocumentos: () => Promise.resolve({ itens: [], proximo: null }),
  obterDocumento: () => Promise.resolve(undefined),
  obterSnapshot: () => Promise.resolve(undefined),
  resumoFontes: () => Promise.resolve([]),
};

const TABELA: TabelaAliquotasVigente = {
  extracaoId: '44444444-4444-4444-8444-444444444444',
  snapshotId: '33333333-3333-4333-8333-333333333334',
  documentoId: '11111111-1111-4111-8111-111111111112',
  fonteId: 'nfse-aliquotas-iss',
  dataReferencia: '2026-09-03',
  linhas: 4,
  recusadas: 0,
  arquivos: ['SP.csv'],
  url: 'https://www.gov.br/nfse/pt-br/biblioteca/aliquotas/aliquotas-municipios-20260903-extr1.zip',
  sha256: 'e'.repeat(64),
  coletadoEm: '2026-11-17T10:00:00.000Z',
  confirmadoEm: '2026-11-17T11:00:00.000Z',
};

const ADAMANTINA = { codigoIbge: '3500105', uf: 'SP', nome: 'Adamantina' };

function linha(codigo: string, aliquota: string | null, inicio: string, fim: string | null, n: number): AliquotaEncontrada {
  return {
    codigoIbge: '3500105',
    codigoServico: codigo,
    incidencia: codigo,
    aliquota,
    inicio,
    fim,
    arquivo: 'SP.csv',
    linha: n,
    textoPublicado: `3500105;SP;Adamantina;${codigo};${codigo};${aliquota ?? ''};${inicio}T00:00:00;${fim === null ? '' : `${fim}T00:00:00`}`,
  };
}

const LINHAS = [
  linha('07.02.01.000', '2,5', '2025-08-01', '2026-06-23', 30),
  linha('07.02.01.000', '3', '2026-06-24', null, 31),
  linha('07.02.02.000', '5', '2026-01-01', null, 32),
  linha('07.02.02.000', '4', '2026-01-01', null, 33),
  linha('07.02.03.000', '5', '2026-02-13', '2026-01-08', 34),
];

const pedidos: { codigoIbge: string; prefixos: readonly string[] | null }[] = [];
const issFalso: ConsultasIss = {
  tabelaVigente: () => Promise.resolve(TABELA),
  municipios: () => Promise.resolve([ADAMANTINA]),
  buscarMunicipios: (_e, f) =>
    Promise.resolve(
      [ADAMANTINA].filter(
        (m) => (f.codigoIbge === undefined || m.codigoIbge === f.codigoIbge) && (f.nome === undefined || m.nome.toLowerCase().startsWith(f.nome.toLowerCase())) && (f.uf === undefined || m.uf === f.uf),
      ),
    ),
  aliquotas: (_e, codigoIbge, prefixos) => {
    pedidos.push({ codigoIbge, prefixos });
    return Promise.resolve(LINHAS.filter((l) => prefixos === null || prefixos.some((p) => l.codigoServico.startsWith(p))));
  },
};

function app(extras: Partial<DependenciasApi> = {}, comIss = true) {
  return construirApp({
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
    ...(comIss ? { iss: issFalso } : {}),
    agora: () => new Date('2026-11-17T15:00:00.000Z'),
    ...extras,
  });
}

const com = (chave: string) => ({ authorization: `Bearer ${chave}` });

describe('GET /v1/iss/aliquotas', () => {
  it('exige chave', async () => {
    expect((await app().inject('/v1/iss/aliquotas?municipio=3500105')).statusCode).toBe(401);
  });

  it('devolve as linhas publicadas, vigência na data, cancelados e divergências', async () => {
    pedidos.length = 0;
    const r = await app().inject({ url: '/v1/iss/aliquotas?municipio=3500105&servico=7.02&data=2026-11-17', headers: com(CHAVE_LEITURA) });
    expect(r.statusCode).toBe(200);
    const corpo = AliquotasIss.parse(r.json());
    expect(pedidos).toEqual([{ codigoIbge: '3500105', prefixos: ['07.02.'] }]);
    expect(corpo.tabela).toMatchObject({ fonte_id: 'nfse-aliquotas-iss', nivel: 'N2', sha256: 'e'.repeat(64), data_referencia: '2026-09-03', confirmado_em: TABELA.confirmadoEm });
    expect(corpo.municipio).toEqual({ codigo_ibge: '3500105', uf: 'SP', nome: 'Adamantina' });
    expect(corpo.aliquotas.map((a) => [a.codigo_servico, a.aliquota, a.vigente_na_data, a.cancelado])).toEqual([
      ['07.02.01.000', '2,5', false, false],
      ['07.02.01.000', '3', true, false],
      ['07.02.02.000', '5', true, false],
      ['07.02.02.000', '4', true, false],
      ['07.02.03.000', '5', false, true],
    ]);
    expect(corpo.aliquotas[1]?.linha_publicada).toBe('3500105;SP;Adamantina;07.02.01.000;07.02.01.000;3;2026-06-24T00:00:00;');
    expect(corpo.divergencias).toEqual(['07.02.02.000']);
  });

  it('usa hoje em Brasília quando a data não vem', async () => {
    const r = await app({ agora: () => new Date('2026-11-18T01:00:00.000Z') }).inject({ url: '/v1/iss/aliquotas?municipio=3500105', headers: com(CHAVE_LEITURA) });
    expect(AliquotasIss.parse(r.json()).data).toBe('2026-11-17');
  });

  it.each(['municipio=350010', 'municipio=3500105&servico=2026', 'municipio=3500105&servico=01.05%25', 'municipio=3500105&data=17/11/2026', 'municipio=3500105&extra=1'])(
    'recusa parâmetro inválido: %s',
    async (q) => {
      expect((await app().inject({ url: `/v1/iss/aliquotas?${q}`, headers: com(CHAVE_LEITURA) })).statusCode).toBe(400);
    },
  );

  it('município fora da tabela: 404 com a legislação municipal coletada, se houver', async () => {
    const r = await app().inject({ url: '/v1/iss/aliquotas?municipio=3550308', headers: com(CHAVE_LEITURA) });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ erro: 'municipio-sem-aliquotas', legislacao: { fonte_id: 'municipio-3550308-legislacao', nivel: 'N1' } });
  });

  it('sem tabela coletada: 404 tabela-indisponivel', async () => {
    const semTabela = app({ iss: { ...issFalso, tabelaVigente: () => Promise.resolve(undefined) } });
    expect((await semTabela.inject({ url: '/v1/iss/aliquotas?municipio=3500105', headers: com(CHAVE_LEITURA) })).json()).toEqual({ erro: 'tabela-indisponivel' });
    expect((await app({}, false).inject({ url: '/v1/iss/aliquotas?municipio=3500105', headers: com(CHAVE_LEITURA) })).json()).toEqual({ erro: 'tabela-indisponivel' });
  });
});

describe('GET /v1/iss/municipios', () => {
  it('junta a tabela oficial e a legislação municipal coletada', async () => {
    const r = await app().inject({ url: '/v1/iss/municipios?uf=SP', headers: com(CHAVE_LEITURA) });
    const corpo = ListaMunicipiosIss.parse(r.json());
    expect(corpo.tabela_aliquotas?.url).toBe(TABELA.url);
    expect(corpo.municipios).toEqual([
      { codigo_ibge: '3500105', uf: 'SP', nome: 'Adamantina', aliquotas_na_tabela: true, legislacao: null },
      {
        codigo_ibge: '3550308',
        uf: 'SP',
        nome: 'São Paulo',
        aliquotas_na_tabela: false,
        legislacao: expect.objectContaining({ fonte_id: 'municipio-3550308-legislacao', orgao: 'Prefeitura do Município de São Paulo' }) as unknown,
      },
    ]);
  });

  it('filtra por nome sem acento e por código', async () => {
    const porNome = ListaMunicipiosIss.parse((await app().inject({ url: '/v1/iss/municipios?nome=sao%20pa', headers: com(CHAVE_LEITURA) })).json());
    expect(porNome.municipios.map((m) => m.codigo_ibge)).toEqual(['3550308']);
    const porCodigo = ListaMunicipiosIss.parse((await app().inject({ url: '/v1/iss/municipios?codigo_ibge=3500105', headers: com(CHAVE_LEITURA) })).json());
    expect(porCodigo.municipios.map((m) => m.codigo_ibge)).toEqual(['3500105']);
  });

  it('sem tabela: só os municípios com legislação coletada', async () => {
    const r = await app({ iss: { ...issFalso, tabelaVigente: () => Promise.resolve(undefined) } }).inject({ url: '/v1/iss/municipios', headers: com(CHAVE_LEITURA) });
    const corpo = ListaMunicipiosIss.parse(r.json());
    expect(corpo.tabela_aliquotas).toBeNull();
    expect(corpo.municipios.map((m) => [m.codigo_ibge, m.aliquotas_na_tabela])).toEqual([['3550308', false]]);
  });
});

describe('perguntas de ISS na API', () => {
  it('resposta da rota iss-aliquota passa pelo esquema de saída (sem 500)', async () => {
    const resposta: RespostaPergunta = {
      situacao: 'respondida',
      rota: 'iss-aliquota',
      resposta: 'código 01.05.01.000: 2% [1]',
      posicao_em: '2026-11-17',
      fontes: [],
      avisos: [],
      limites: [],
      aviso: 'x',
      checagem: { citacoes_invalidas: 0, frases_sem_citacao_removidas: 0, conteudo_removido: 0 },
    };
    const perguntas: ServicoPerguntas = { ...perguntasFalsas, responder: () => Promise.resolve({ id: '66666666-6666-4666-8666-666666666666', resposta }) };
    const r = await app({ perguntas }).inject({ method: 'POST', url: '/v1/perguntas', headers: com(CHAVE_TUDO), payload: { pergunta: 'Alíquota do ISS em Adamantina?' } });
    expect(r.statusCode).toBe(200);
    expect(EsquemaResposta.parse(r.json()).rota).toBe('iss-aliquota');
  });

  it('OpenAPI documenta as rotas de ISS', async () => {
    const doc = (await app().inject('/v1/openapi.json')).json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/v1/iss/municipios', '/v1/iss/aliquotas']));
  });
});
