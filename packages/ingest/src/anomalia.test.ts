import { describe, expect, it } from 'vitest';
import { detectarAnomalia, type LadoComparacao } from './anomalia.ts';

const pagina: LadoComparacao = {
  urlFinal: 'https://www.gov.br/nfse/pt-br/rtc',
  mime: 'text/html',
  bytes: 90_000,
  textoNormalizado: 'Documentação técnica da Reforma Tributária do Consumo. '.repeat(20),
  linksDocumentos: ['a.pdf', 'b.pdf', 'c.xlsx', 'd.zip'].map((d) => `https://www.gov.br/nfse/pt-br/rtc/${d}`),
};

describe('detectarAnomalia', () => {
  it('mudança normal não é anomalia', () => {
    const atual = { ...pagina, textoNormalizado: `${pagina.textoNormalizado ?? ''} NT 011 publicada.`, linksDocumentos: [...(pagina.linksDocumentos ?? []), 'https://www.gov.br/nfse/pt-br/rtc/e.pdf'] };
    expect(detectarAnomalia(pagina, atual)).toBeNull();
  });

  it('página de manutenção no lugar do conteúdo (caso INLABS)', () => {
    const manutencao = { ...pagina, textoNormalizado: 'Sistema em Manutenção Programada. Tente novamente mais tarde.', linksDocumentos: [] };
    const motivo = detectarAnomalia(pagina, manutencao);
    expect(motivo).toContain('texto encolheu');
    expect(motivo).toContain('4 de 4 links de documentos sumiram');
  });

  it('troca de domínio no destino final', () => {
    expect(detectarAnomalia(pagina, { ...pagina, urlFinal: 'https://cgibs.gov.br/x' })).toContain('destino final mudou');
  });

  it('PDF que encolhe demais', () => {
    const pdf = { urlFinal: 'https://www.gov.br/nfse/a.pdf', mime: 'application/pdf', bytes: 700_000 };
    expect(detectarAnomalia(pdf, { ...pdf, bytes: 20_000 })).toContain('arquivo encolheu');
    expect(detectarAnomalia(pdf, { ...pdf, bytes: 650_000 })).toBeNull();
  });

  it('troca de tipo', () => {
    const pdf = { urlFinal: 'https://www.gov.br/nfse/a.pdf', mime: 'application/pdf', bytes: 1000 };
    expect(detectarAnomalia(pdf, { ...pdf, mime: 'application/zip' })).toContain('tipo mudou');
  });

  it('não acusa encolhimento de texto em página já curta', () => {
    const curta = { ...pagina, textoNormalizado: 'Notícias', linksDocumentos: [] };
    expect(detectarAnomalia(curta, { ...curta, textoNormalizado: 'X' })).toBeNull();
  });
});
