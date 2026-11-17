import { describe, expect, it } from 'vitest';
import { chaveAto, encontrarReferencias, extrairCabecalho, extrairRelacoes } from './atos.ts';

describe('referências a atos', () => {
  it('normaliza tipo, órgão, número e ano na chave canônica', () => {
    const refs = encontrarReferencias(
      'divulgado pela Resolução CGIBS nº 6, de 30 de abril de 2026, e o Ato Conjunto RFB/CGIBS nº 4, de 30 de julho de 2026; a Lei no 7.192, de 5 de junho de 1984; Lei Complementar nº 227, de 2026; NT 1/2026',
    );
    expect(refs.map((r) => r.chave)).toEqual(['resolucao-cgibs-6-2026', 'ato-conjunto-rfb-cgibs-4-2026', 'lei-7192-1984', 'lei-complementar-227-2026']);
    expect(refs[0]).toMatchObject({ data: '2026-04-30', orgao: 'cgibs', numero: '6' });
    expect(refs[3]?.data).toBeNull();
  });

  it('cabeçalho em caixa alta, órgão com hífen e zero à esquerda viram a mesma chave da citação', () => {
    expect(encontrarReferencias('RESOLUÇÃO CG-IBS Nº 4, DE 8 DE ABRIL DE 2026')[0]?.chave).toBe('resolucao-cgibs-4-2026');
    expect(encontrarReferencias('RESOLUÇÃO CGIBS Nº 07, DE 18 DE MAIO DE 2026')[0]?.chave).toBe('resolucao-cgibs-7-2026');
    expect(encontrarReferencias('RESOLUÇÃO CGIBS Nº 18, 15 SETEMBRO DE 2026')[0]?.data).toBe('2026-09-15');
    expect(encontrarReferencias('a Resolução CGIBS nº 7, de 18 de maio de 2026')[0]?.chave).toBe('resolucao-cgibs-7-2026');
  });

  it('sem ano não há chave (identidade ambígua)', () => {
    expect(encontrarReferencias('nos termos da Resolução CGSN nº 140')[0]?.chave).toBeNull();
    expect(chaveAto('lei', null, '1.234', 2020)).toBe('lei-1234-2020');
  });

  it('não confunde palavra comum com tipo de ato', () => {
    expect(encontrarReferencias('a leitura nº 3 do decretório')).toEqual([]);
  });

  it('expressão sem retrocesso catastrófico em texto adversarial', () => {
    const adversarial = `Resolução ${'A/'.repeat(5000)} nº ${'1.'.repeat(5000)}`;
    const inicio = performance.now();
    encontrarReferencias(adversarial);
    extrairRelacoes(`Fica revogada ${'a Lei nº 1; '.repeat(2000)}`, null);
    expect(performance.now() - inicio).toBeLessThan(2000);
  });
});

describe('cabeçalho', () => {
  it('identifica o próprio ato no começo do documento', () => {
    const c = extrairCabecalho('COMITÊ GESTOR DO IMPOSTO SOBRE BENS E SERVIÇOS – CGIBS RESOLUÇÃO CGIBS Nº 11, DE 30 DE JUNHO DE 2026 Dispõe, em caráter provisório…');
    expect(c?.referencia.chave).toBe('resolucao-cgibs-11-2026');
    expect(extrairCabecalho('Presidência da República Casa Civil LEI COMPLEMENTAR Nº 214, DE 16 DE JANEIRO DE 2025 Mensagem de veto')?.referencia.chave).toBe(
      'lei-complementar-214-2025',
    );
  });

  it('citação em texto corrido no começo de uma página não é cabeçalho', () => {
    expect(extrairCabecalho('Lista de Serviços Anexa à Lei Complementar nº 116, de 31 de julho de 2003 Pesquise na lista a sua atividade')).toBeNull();
  });

  it('minuta não ganha identidade', () => {
    expect(extrairCabecalho('MINUTA DO ATO CONJUNTO RFB/CGIBS Nº 6, DE 28 DE AGOSTO DE 2026. Dispõe sobre')).toBeNull();
  });
});

describe('relações', () => {
  it('revogação do ato inteiro', () => {
    const texto = 'Art. 39. Fica revogada a Resolução CGIBS nº 11, de 30 de junho de 2026.';
    const [r] = extrairRelacoes(texto, 'resolucao-cgibs-19-2026');
    expect(r).toMatchObject({ tipo: 'revoga', dispositivo: null });
    expect(r?.destino.chave).toBe('resolucao-cgibs-11-2026');
    expect(texto.includes(r?.evidencia ?? '∅')).toBe(true);
  });

  it('revogação de dispositivo é alteração, não revogação do ato', () => {
    const texto = 'Art. 2º Fica revogado o item 3 da alínea “b” do inciso XVII do caput do art. 1º do Ato Conjunto RFB/CGIBS nº 4, de 30 de julho de 2026.';
    const [r] = extrairRelacoes(texto, null);
    expect(r?.tipo).toBe('altera');
    expect(r?.dispositivo).toContain('item 3');
  });

  it('rol de revogações separa ato inteiro de dispositivo, item por item', () => {
    const texto =
      'Art. 10. Ficam revogados os arts. 8o, 10, 11 e 12 do Decreto-Lei no 406, de 31 de dezembro de 1968; a Lei Complementar no 22, de 9 de dezembro de 1974; a Lei no 7.192, de 5 de junho de 1984.';
    const r = extrairRelacoes(texto, 'lei-complementar-116-2003');
    expect(r.map((x) => [x.tipo, x.destino.chave])).toEqual([
      ['altera', 'decreto-lei-406-1968'],
      ['revoga', 'lei-complementar-22-1974'],
      ['revoga', 'lei-7192-1984'],
    ]);
    for (const x of r) expect(texto.includes(x.evidencia)).toBe(true);
  });

  it('revogação com data futura carrega a data de efeito; "seguintes dispositivos" é parcial (LC 214, art. 543)', () => {
    const texto =
      'Art. 543. Ficam revogados a partir de 1º de janeiro de 2033: Produção de efeitos I - o Decreto-lei nº 406, de 31 de dezembro de 1968; II - os seguintes dispositivos da Lei Complementar nº 24, de 7 de janeiro de 1975: a) os arts. 1º a 12; IV - a Lei Complementar nº 116, de 31 de julho de 2003; V - os seguintes dispositivos da Lei Complementar nº 123, de 2006: a) do art. 13';
    const r = extrairRelacoes(texto, 'lei-complementar-214-2025');
    expect(r.map((x) => [x.tipo, x.destino.chave, x.efeitoEm])).toEqual([
      ['revoga', 'decreto-lei-406-1968', '2033-01-01'],
      ['altera', 'lei-complementar-24-1975', '2033-01-01'],
      ['revoga', 'lei-complementar-116-2003', '2033-01-01'],
      ['altera', 'lei-complementar-123-2006', '2033-01-01'],
    ]);
    expect(r[1]?.dispositivo).toBe('revoga os seguintes dispositivos da');
  });

  it('"passa a vigorar com" é alteração, inclusive com o sujeito sendo um artigo do outro ato', () => {
    const inteiro = extrairRelacoes('Art. 1º O Ato Conjunto RFB/CGIBS nº 4, de 30 de julho de 2026, passa a vigorar com as seguintes alterações: “Art. 1º ...', null);
    expect(inteiro).toMatchObject([{ tipo: 'altera', dispositivo: null }]);
    const artigo = extrairRelacoes(
      'Art. 1º O art. 617 do Regulamento do Imposto sobre Bens e Serviços (IBS), divulgado pela Resolução CGIBS nº 6, de 30 de abril de 2026, passa a vigorar com a seguinte redação:',
      null,
    );
    expect(artigo[0]?.tipo).toBe('altera');
    expect(artigo[0]?.dispositivo).toMatch(/^art\. 617/);
  });

  it('ementa "Altera a …"', () => {
    expect(extrairRelacoes('RESOLUÇÃO CGIBS Nº 5, DE 30 DE ABRIL DE 2026 Altera a Resolução CGIBS nº 4, de 8 de abril de 2026, para dispor', 'resolucao-cgibs-5-2026')).toMatchObject([
      { tipo: 'altera', destino: { chave: 'resolucao-cgibs-4-2026' } },
    ]);
  });

  it('anotação passiva do texto compilado não vira relação no sentido errado', () => {
    expect(extrairRelacoes('§ 4º (Revogado pela Lei Complementar nº 227, de 2026) § 5º (Redação dada pela Lei Complementar nº 227, de 2026)', 'lei-complementar-214-2025')).toEqual([]);
    expect(extrairRelacoes('(Vide Lei Complementar nº 214, de 2025)', 'lei-complementar-116-2003')).toEqual([]);
  });

  it('mera citação não é relação; a própria chave é ignorada', () => {
    expect(extrairRelacoes('nos termos do art. 112 da Lei Complementar nº 214, de 16 de janeiro de 2025', null)).toEqual([]);
    expect(extrairRelacoes('Fica revogada a Resolução CGIBS nº 5, de 30 de abril de 2026.', 'resolucao-cgibs-5-2026')).toEqual([]);
  });

  it('revogação não alcança outro artigo', () => {
    const r = extrairRelacoes('Art. 2º Fica revogada a Resolução CGIBS nº 3, de 10 de março de 2026. Art. 3º Aplica-se a Resolução CGIBS nº 4, de 8 de abril de 2026.', null);
    expect(r.map((x) => x.destino.chave)).toEqual(['resolucao-cgibs-3-2026']);
  });
});
