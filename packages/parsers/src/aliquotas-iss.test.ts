import { describe, expect, it } from 'vitest';
import { CABECALHO_ALIQUOTAS_ISS, lerAliquotasIss, linhaPublicada, type LinhaAliquotaIss } from './aliquotas-iss.ts';
import { ErroParser } from './erro.ts';
import { extrairDocumento } from './extrair.ts';
import { criarZip } from './zip-para-teste.ts';

const URL_PACOTE = 'https://www.gov.br/nfse/pt-br/biblioteca/aliquotas/aliquotas-municipios-20260903-extr1.zip';

const BOM = String.fromCodePoint(0xfeff);
const csv = (linhas: readonly string[]): Buffer => Buffer.from(`${BOM}${[CABECALHO_ALIQUOTAS_ISS, ...linhas].join('\r\n')}\r\n`, 'utf8');

const SP = [
  '3509502;SP;Campinas;01.05.01.000;01.05.01.000;2;2025-08-01T00:00:00;',
  '3509502;SP;Campinas;07.02.01.000;07.02.01.000;2,5;2025-08-01T00:00:00;2026-06-23T00:00:00',
  '3509502;SP;Campinas;07.02.01.000;07.02.01.000;;2026-06-24T00:00:00;',
  "3500105;SP;Santa Bárbara d'Oeste;01.01.01.000;01.01.01.000;4,99;2026-01-01T00:00:00;",
];
const AC = ['1200013;AC;Acrelândia;15.03.07.000;15.03.07.000;5;2026-01-19T00:00:00;2026-01-19T00:00:00'];

function todas(entradas: Parameters<typeof lerAliquotasIss>[0]): LinhaAliquotaIss[] {
  return [...lerAliquotasIss(entradas, [URL_PACOTE]).lotes(2)].flat();
}

describe('lerAliquotasIss', () => {
  it('lê os CSV por UF com os valores exatamente como publicados', () => {
    const tabela = lerAliquotasIss(
      [
        { nome: 'SP.csv', conteudo: csv(SP) },
        { nome: 'AC.csv', conteudo: csv(AC) },
      ],
      [URL_PACOTE],
    );
    expect(tabela.dataReferencia).toBe('2026-09-03');
    expect(tabela.total).toBe(5);
    expect(tabela.recusadas).toBe(0);
    expect(tabela.arquivos).toEqual([
      { nome: 'AC.csv', linhas: 1, recusadas: 0 },
      { nome: 'SP.csv', linhas: 4, recusadas: 0 },
    ]);
    expect(tabela.municipios.map((m) => `${m.codigoIbge} ${m.nome}/${m.uf}`)).toEqual([
      '1200013 Acrelândia/AC',
      '3509502 Campinas/SP',
      "3500105 Santa Bárbara d'Oeste/SP",
    ]);
    const linhas = [...tabela.lotes(2)].flat();
    expect(linhas).toHaveLength(5);
    expect(linhas[2]).toEqual({
      codigoIbge: '3509502',
      codigoServico: '07.02.01.000',
      incidencia: '07.02.01.000',
      aliquota: '2,5',
      inicio: '2025-08-01',
      fim: '2026-06-23',
      arquivo: 'SP.csv',
      linha: 3,
    });
    expect(linhas[3]?.aliquota).toBeNull();
  });

  it('reconstrói byte a byte a linha publicada (texto citado nas respostas)', () => {
    const tabela = lerAliquotasIss([{ nome: 'SP.csv', conteudo: csv(SP) }], [URL_PACOTE]);
    const municipios = new Map(tabela.municipios.map((m) => [m.codigoIbge, m]));
    const reconstruidas = [...tabela.lotes(10)].flat().map((l) => {
      const m = municipios.get(l.codigoIbge);
      if (m === undefined) throw new Error('município ausente');
      return linhaPublicada(l, m);
    });
    expect(reconstruidas).toEqual(SP);
  });

  it('recusa e conta linhas inconsistentes sem derrubar a tabela', () => {
    const ruins = [
      '3304557;SP;Rio de Janeiro;01.01.01.000;01.01.01.000;5;2026-01-01T00:00:00;',
      '3509502;RJ;Campinas;01.01.01.000;01.01.01.000;5;2026-01-01T00:00:00;',
      '3509502;SP;Campinas;01.01.01.000;01.01.01.000;5;2026-02-30T00:00:00;',
      '3509502;SP;Campinas;01.01.01.000;01.01.01.000;150;2026-01-01T00:00:00;',
      '3509502;SP;Campinas;1.01;1.01;5;2026-01-01T00:00:00;',
      '3509502;SP;Campinas;01.01.01.000;01.01.01.000;5;2026-01-01 00:00:00;',
      '3509502;SP;Campinas;01.01.01.000;01.01.01.000;5,0,1;2026-01-01T00:00:00;',
      '3509502;SP;Campinas;01.01.01.000;01.01.01.000;5;2026-01-01T00:00:00;;extra',
      '3509502;SP;Outro Nome;01.01.01.000;01.01.01.000;5;2026-01-01T00:00:00;',
      '3509502;SP;Campinas‮;01.01.01.000;01.01.01.000;5;2026-01-01T00:00:00;',
      '',
    ];
    const tabela = lerAliquotasIss([{ nome: 'SP.csv', conteudo: csv([...SP, ...ruins]) }]);
    expect(tabela.total).toBe(SP.length);
    expect(tabela.recusadas).toBe(ruins.length);
    expect(tabela.dataReferencia).toBeNull();
  });

  it('falha fechada com cabeçalho diferente ou recusa em massa (mudança de leiaute)', () => {
    const outroCabecalho = Buffer.from(`codigo_ibge;uf;nome;servico;aliquota\n${SP[0] ?? ''}\n`, 'utf8');
    expect(() => lerAliquotasIss([{ nome: 'SP.csv', conteudo: outroCabecalho }])).toThrow(/cabeçalho inesperado/);
    const quebradas = Array.from({ length: 60 }, () => '3509502;SP;Campinas;01.01;01.01;5;2026-01-01;');
    expect(() => lerAliquotasIss([{ nome: 'SP.csv', conteudo: csv([...SP, ...quebradas]) }])).toThrow(/fora do formato/);
    expect(() => lerAliquotasIss([{ nome: 'SP.csv', conteudo: Buffer.from([0xff, 0xfe, 0x00]) }])).toThrow(ErroParser);
    expect(() => lerAliquotasIss([{ nome: 'leia-me.txt', conteudo: csv(SP) }])).toThrow(/sem CSV por UF/);
  });

  it('só aceita CSV com nome de UF válida', () => {
    const tabela = lerAliquotasIss([
      { nome: 'SP.csv', conteudo: csv(SP) },
      { nome: 'XX.csv', conteudo: csv(['9999999;XX;Lugar;01.01.01.000;01.01.01.000;5;2026-01-01T00:00:00;']) },
    ]);
    expect(tabela.arquivos.map((a) => a.nome)).toEqual(['SP.csv']);
  });

  it('lotes cobrem todas as linhas em ordem', () => {
    expect(todas([{ nome: 'SP.csv', conteudo: csv(SP) }]).map((l) => l.linha)).toEqual([2, 3, 4, 5]);
  });
});

describe('extrairDocumento com o pacote de alíquotas', () => {
  it('extrai a tabela dos CSV e ignora o TXT consolidado (sem descompactá-lo)', async () => {
    const zip = criarZip([
      { nome: 'SP.csv', conteudo: csv(SP) },
      { nome: 'AC.csv', conteudo: csv(AC) },
      { nome: 'aliquotas-municipios-20260903.txt', conteudo: Buffer.alloc(1024), tamanhoDeclarado: 0xfffffff0 },
    ]);
    const extracao = await extrairDocumento(zip, 'application/zip', URL_PACOTE);
    expect(extracao.tipo).toBe('aliquotas');
    if (extracao.tipo !== 'aliquotas') return;
    expect(extracao.aliquotas.total).toBe(5);
    expect(extracao.aliquotas.dataReferencia).toBe('2026-09-03');
    expect(extracao.trechos[0]?.texto).toContain('3 municípios, 5 registros');
    expect(extracao.trechos.map((t) => t.secao)).toEqual(['alíquotas de ISSQN', 'AC.csv', 'SP.csv']);
  });

  it('ZIP com XSD continua indo para o leiaute', async () => {
    const zip = criarZip([{ nome: 'a.xsd', conteudo: '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="A" type="xs:string"/></xs:schema>' }]);
    expect((await extrairDocumento(zip, 'application/zip', 'https://www.gov.br/nfse/x.zip')).tipo).toBe('leiaute');
  });
});
