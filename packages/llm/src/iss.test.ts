import { FONTES } from '@lastro/core';
import type { AliquotaEncontrada, ConsultasIss, TabelaAliquotasVigente } from '@lastro/db';
import { describe, expect, it } from 'vitest';
import {
  dataCitada,
  identificarMunicipio,
  municipiosConhecidos,
  respostaAliquotas,
  servicosCitados,
  vigenteEm,
  type MunicipioConhecido,
} from './iss.ts';
import type { ClienteModelo, PedidoModelo, RespostaJson, RespostaModelo } from './modelo.ts';
import { responderPergunta } from './pipeline.ts';
import type { Evidencia } from './tipos.ts';

const AGORA = new Date('2026-11-17T15:00:00.000Z');

const TABELA: TabelaAliquotasVigente = {
  extracaoId: '44444444-4444-4444-8444-444444444444',
  snapshotId: '33333333-3333-4333-8333-333333333334',
  documentoId: '11111111-1111-4111-8111-111111111112',
  fonteId: 'nfse-aliquotas-iss',
  dataReferencia: '2026-09-03',
  linhas: 6,
  recusadas: 0,
  arquivos: ['PI.csv', 'SP.csv'],
  url: 'https://www.gov.br/nfse/pt-br/biblioteca/aliquotas/aliquotas-municipios-20260903-extr1.zip',
  sha256: 'e'.repeat(64),
  coletadoEm: '2026-11-17T10:00:00.000Z',
  confirmadoEm: '2026-11-17T10:00:00.000Z',
};

const DA_TABELA = [
  { codigoIbge: '3500105', uf: 'SP', nome: 'Adamantina' },
  { codigoIbge: '3509502', uf: 'SP', nome: 'Campinas' },
  { codigoIbge: '3545803', uf: 'SP', nome: "Santa Bárbara d'Oeste" },
  { codigoIbge: '2201804', uf: 'PI', nome: 'Bom Jesus' },
  { codigoIbge: '4302709', uf: 'RS', nome: 'Bom Jesus' },
  { codigoIbge: '2903904', uf: 'BA', nome: 'Bom Jesus da Lapa' },
];
const MUNICIPIOS = municipiosConhecidos(DA_TABELA, FONTES);

function linha(codigo: string, aliquota: string | null, inicio: string, fim: string | null, n: number, ibge = '3500105'): AliquotaEncontrada {
  const nome = ibge === '3500105' ? 'Adamantina' : 'Campinas';
  return {
    codigoIbge: ibge,
    codigoServico: codigo,
    incidencia: codigo,
    aliquota,
    inicio,
    fim,
    arquivo: 'SP.csv',
    linha: n,
    textoPublicado: `${ibge};SP;${nome};${codigo};${codigo};${aliquota ?? ''};${inicio}T00:00:00;${fim === null ? '' : `${fim}T00:00:00`}`,
  };
}

const ADAMANTINA = [
  linha('01.05.01.000', '2', '2025-08-01', null, 7),
  linha('07.02.01.000', '2,5', '2025-08-01', '2026-06-23', 30),
  linha('07.02.01.000', '3', '2026-06-24', null, 31),
  linha('07.02.02.000', '5', '2026-01-01', null, 32),
  linha('07.02.02.000', '4', '2026-01-01', null, 33),
  linha('09.01.01.000', '5', '2026-02-13', '2026-01-08', 40),
];

const m = (codigo: string): MunicipioConhecido => {
  const achado = MUNICIPIOS.find((x) => x.codigoIbge === codigo);
  if (achado === undefined) throw new Error(codigo);
  return achado;
};

describe('identificarMunicipio', () => {
  it('junta tabela e catálogo: São Paulo vem do catálogo, sem estar na tabela', () => {
    expect(m('3550308')).toMatchObject({ nome: 'São Paulo', naTabela: false, fonteLegislacao: 'municipio-3550308-legislacao' });
    expect(m('3509502')).toMatchObject({ naTabela: true, fonteLegislacao: null });
  });

  it.each([
    ['Qual a alíquota do ISS em Campinas?', '3509502'],
    ['alíquota do ISS em CAMPINAS para o item 1.05', '3509502'],
    ["ISS em Santa Barbara d’Oeste", '3545803'],
    ['ISS no município 3500105', '3500105'],
    ['Alíquota de ISS em Bom Jesus/PI', '2201804'],
    ['Alíquota de ISS em Bom Jesus - RS', '4302709'],
    ['Alíquota de ISS em Bom Jesus da Lapa', '2903904'],
    ['Qual o prazo de recolhimento do ISS em São Paulo?', '3550308'],
  ])('%s → %s', (pergunta, codigo) => {
    expect(identificarMunicipio(pergunta, MUNICIPIOS)).toEqual({ tipo: 'unico', municipio: m(codigo) });
  });

  it('não escolhe quando o nome existe em mais de uma UF ou há dois municípios', () => {
    expect(identificarMunicipio('Alíquota de ISS em Bom Jesus', MUNICIPIOS)).toMatchObject({ tipo: 'ambiguo', candidatos: [m('2201804'), m('4302709')] });
    expect(identificarMunicipio('ISS de Campinas e de Adamantina', MUNICIPIOS).tipo).toBe('ambiguo');
    expect(identificarMunicipio('Qual a alíquota mínima do ISS?', MUNICIPIOS)).toEqual({ tipo: 'nenhum' });
    expect(identificarMunicipio('ISS em Campinasópolis', MUNICIPIOS)).toEqual({ tipo: 'nenhum' });
  });
});

describe('códigos, datas e vigência', () => {
  it('extrai só códigos de serviço da pergunta (não ano, IBGE nem alíquota)', () => {
    expect(servicosCitados('Item 1.05 e 7.02 em 2026, IBGE 3500105, alíquota 2,5 ou 4.5')).toEqual(['01.05.', '07.02.']);
    expect(servicosCitados('código 010501 e 01.05.01.000')).toEqual(['01.05.01.', '01.05.01.000']);
  });

  it('lê dd/mm/aaaa válida', () => {
    expect(dataCitada('vigente em 1/3/2026?')).toBe('2026-03-01');
    expect(dataCitada('em 31/02/2026')).toBeNull();
    expect(dataCitada('sem data')).toBeNull();
  });

  it('registro cancelado (fim antes do início) não vale em data nenhuma', () => {
    expect(vigenteEm({ inicio: '2026-01-01', fim: null }, '2026-01-01')).toBe(true);
    expect(vigenteEm({ inicio: '2026-01-01', fim: '2026-01-31' }, '2026-02-01')).toBe(false);
    expect(vigenteEm({ inicio: '2026-01-01', fim: '2026-01-01' }, '2026-01-01')).toBe(true);
    expect(vigenteEm({ inicio: '2026-02-13', fim: '2026-01-08' }, '2026-02-01')).toBe(false);
  });
});

describe('respostaAliquotas (sem modelo)', () => {
  const base = { municipio: m('3500105'), tabela: TABELA, data: '2026-11-17', agora: AGORA, fontes: FONTES, rota: 'iss-aliquota' as const };

  it('cita a linha exata do CSV oficial, com nível e órgão da fonte', () => {
    const r = respostaAliquotas({ ...base, linhas: [ADAMANTINA[0] as AliquotaEncontrada], prefixos: ['01.05.'] });
    expect(r.situacao).toBe('respondida');
    expect(r.resposta).toContain('Adamantina/SP (código IBGE 3500105)');
    expect(r.resposta).toContain('código 01.05.01.000: 2%, desde 01/08/2025 [1]');
    expect(r.resposta).toContain('extração de 03/09/2026');
    expect(r.fontes).toEqual([
      expect.objectContaining({
        id: 1,
        nivel: 'N2',
        orgao: 'SE/CGNFS-e',
        trecho: '3500105;SP;Adamantina;01.05.01.000;01.05.01.000;2;2025-08-01T00:00:00;',
        secao: 'SP.csv, linha 7',
        sha256: 'e'.repeat(64),
        original: `/v1/snapshots/${TABELA.snapshotId}/original`,
      }),
    ]);
    expect(r.avisos[0]).toContain('vale a lei municipal');
  });

  it('usa o registro vigente na data e mostra divergência sem escolher', () => {
    const r = respostaAliquotas({ ...base, linhas: ADAMANTINA.slice(1, 5), prefixos: ['07.02.'] });
    expect(r.resposta).toContain('código 07.02.01.000: 3%, desde 24/06/2026 [1]');
    expect(r.resposta).toContain('código 07.02.02.000: a tabela traz registros vigentes com alíquotas diferentes, 5% [2] e 4% [3]');
    expect(r.avisos).toContain('Há registros vigentes divergentes para o mesmo código; a plataforma não escolhe entre eles. Confirme com a prefeitura.');

    const antes = respostaAliquotas({ ...base, data: '2026-01-10', linhas: ADAMANTINA.slice(1, 3), prefixos: ['07.02.'] });
    expect(antes.resposta).toContain('código 07.02.01.000: 2,5%, desde 01/08/2025 até 23/06/2026 [1]');
  });

  it('sem registro vigente: mostra o último registro válido; só cancelado: diz isso', () => {
    const r = respostaAliquotas({ ...base, data: '2025-01-01', linhas: [ADAMANTINA[0] as AliquotaEncontrada, ADAMANTINA[5] as AliquotaEncontrada], prefixos: ['01.', '09.'] });
    expect(r.resposta).toContain('código 01.05.01.000: nenhum registro vigente em 01/01/2025; o último registro é 2% de 01/08/2025 [1]');
    expect(r.resposta).toContain('código 09.01.01.000: nenhum registro vigente em 01/01/2025 (só registros cancelados no cadastro)');
  });

  it('sem código de serviço: resume as alíquotas vigentes e pede o subitem', () => {
    const r = respostaAliquotas({ ...base, linhas: ADAMANTINA, prefixos: null });
    expect(r.resposta).toContain('há 3 códigos de serviço com registro vigente em 17/11/2026');
    expect(r.resposta).toContain('Informe o subitem');
    expect(r.fontes.length).toBeGreaterThan(0);
  });

  it('código sem registro: sem-resposta, sem fontes', () => {
    const r = respostaAliquotas({ ...base, linhas: [], prefixos: ['40.01.'] });
    expect(r).toMatchObject({ situacao: 'sem-resposta', fontes: [] });
    expect(r.resposta).toContain('não traz registro para Adamantina/SP');
  });

  it('avisa tabela velha pelo SLA da fonte', () => {
    const r = respostaAliquotas({ ...base, agora: new Date('2026-11-25T12:00:00.000Z'), linhas: [ADAMANTINA[0] as AliquotaEncontrada], prefixos: ['01.05.'] });
    expect(r.avisos).toContain('Tabela verificada pela última vez em 17/11/2026.');
  });
});

class ModeloFalso implements ClienteModelo {
  pedidos: PedidoModelo[] = [];
  gerar(pedido: PedidoModelo): Promise<RespostaModelo> {
    this.pedidos.push(pedido);
    return Promise.resolve({ blocos: [{ texto: 'x', citacoes: [] }], parada: 'end_turn', uso: { modelo: 'claude-opus-5-5', tokensEntrada: 1, tokensSaida: 1, tokensCacheLeitura: 0, tokensCacheEscrita: 0 } });
  }
  gerarJson(): Promise<RespostaJson> {
    return Promise.reject(new Error('não usado'));
  }
}

const EVIDENCIA: Evidencia = {
  tipo: 'trecho',
  id: '77777777-7777-4777-8777-777777777777',
  titulo: 'lcp116.htm',
  texto: 'Art. 8º-A A alíquota mínima do Imposto sobre Serviços de Qualquer Natureza é de 2% (dois por cento).',
  secao: 'Art. 8-A',
  paginaIni: null,
  paginaFim: null,
  url: 'https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp116.htm',
  fonteId: 'planalto-legislacao',
  documentoId: '11111111-1111-4111-8111-111111111111',
  snapshotId: '33333333-3333-4333-8333-333333333333',
  sha256: 'c'.repeat(64),
  coletadoEm: '2026-11-17T10:00:00.000Z',
  confirmadoEm: '2026-11-17T10:00:00.000Z',
  documentoIndisponivel: false,
};

function cenario(iss?: Pick<ConsultasIss, 'tabelaVigente' | 'municipios' | 'aliquotas'>) {
  const modelo = new ModeloFalso();
  const buscas: (readonly string[] | undefined)[] = [];
  const consultasAliquota: { codigoIbge: string; prefixos: readonly string[] | null }[] = [];
  const padrao: Pick<ConsultasIss, 'tabelaVigente' | 'municipios' | 'aliquotas'> = {
    tabelaVigente: () => Promise.resolve(TABELA),
    municipios: () => Promise.resolve(DA_TABELA),
    aliquotas: (_e, codigoIbge, prefixos) => {
      consultasAliquota.push({ codigoIbge, prefixos });
      return Promise.resolve(ADAMANTINA.filter((l) => prefixos === null || prefixos.some((p) => l.codigoServico.startsWith(p))));
    },
  };
  return {
    modelo,
    buscas,
    consultasAliquota,
    deps: {
      modelo,
      fontes: FONTES,
      iss: iss ?? padrao,
      agora: () => AGORA,
      buscarTrechos: (_c: string, _l: number, fontes?: readonly string[]) => {
        buscas.push(fontes);
        return Promise.resolve([EVIDENCIA]);
      },
    },
  };
}

describe('pipeline de ISS', () => {
  it('alíquota de município da tabela sai da tabela, sem modelo e sem busca', async () => {
    const c = cenario();
    const r = await responderPergunta('Qual a alíquota do ISS em Adamantina/SP para o item 1.05?', c.deps);
    expect(r.resposta).toMatchObject({ situacao: 'respondida', rota: 'iss-aliquota' });
    expect(r.resposta.fontes[0]?.trecho).toBe(ADAMANTINA[0]?.textoPublicado);
    expect(c.consultasAliquota).toEqual([{ codigoIbge: '3500105', prefixos: ['01.05.'] }]);
    expect(c.modelo.pedidos).toHaveLength(0);
    expect(c.buscas).toHaveLength(0);
    expect(r.custoUsd).toBe(0);
  });

  it('município coberto só pela legislação (São Paulo): busca só a lei dele e a federal', async () => {
    const c = cenario();
    await responderPergunta('Qual a alíquota do ISS em São Paulo para software?', c.deps);
    expect(c.buscas).toEqual([['municipio-3550308-legislacao', 'planalto-legislacao']]);
    expect(c.modelo.pedidos).toHaveLength(1);
  });

  it('apuração em município sem legislação coletada: só a lei federal, com aviso', async () => {
    const c = cenario();
    const r = await responderPergunta('Quem é responsável pela retenção do ISS em Campinas?', c.deps);
    expect(c.buscas).toEqual([['planalto-legislacao']]);
    expect(r.resposta.avisos[0]).toContain('A legislação municipal de Campinas/SP não está na base');
  });

  it('sem município: alíquota geral só na legislação federal, com orientação', async () => {
    const c = cenario();
    const r = await responderPergunta('Qual a alíquota mínima do ISS?', c.deps);
    expect(c.buscas).toEqual([['planalto-legislacao']]);
    expect(r.resposta.avisos[0]).toContain('cite o município');
  });

  it('município ambíguo: pede a UF, sem modelo nem busca', async () => {
    const c = cenario();
    const r = await responderPergunta('Qual a alíquota do ISS em Bom Jesus?', c.deps);
    expect(r.resposta.situacao).toBe('sem-resposta');
    expect(r.resposta.resposta).toContain('Bom Jesus/PI (código IBGE 2201804); Bom Jesus/RS (código IBGE 4302709)');
    expect(c.modelo.pedidos).toHaveLength(0);
    expect(c.buscas).toHaveLength(0);
  });

  it('sem tabela coletada: São Paulo ainda vai à legislação municipal', async () => {
    const c = cenario({ tabelaVigente: () => Promise.resolve(undefined), municipios: () => Promise.reject(new Error('não deveria ler')), aliquotas: () => Promise.reject(new Error('não deveria ler')) });
    await responderPergunta('Qual a alíquota do ISS em São Paulo?', c.deps);
    expect(c.buscas).toEqual([['municipio-3550308-legislacao', 'planalto-legislacao']]);
  });
});
