import { describe, expect, it } from 'vitest';
import { decodificarHtml, EXTENSOES_DOCUMENTO, extrairLinks, linksDeDocumentos, mimesParaDocumento } from './links.ts';

const PAGINA = 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc';

describe('extrairLinks', () => {
  it('resolve relativos, remove fragmento e repetição', () => {
    const html = `
      <a href="rtc/nt-009.pdf">NT</a>
      <a href="/nfse/pt-br/noticias#topo">Notícias</a>
      <a href="/nfse/pt-br/noticias">Notícias</a>
      <a href="mailto:x@y">mail</a>
      <a href="javascript:alert(1)">js</a>
      <link rel="alternate" type="application/rss+xml" href="/nfse/pt-br/noticias/RSS">`;
    const r = extrairLinks(html, PAGINA);
    expect(r.links).toEqual([
      'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/nt-009.pdf',
      'https://www.gov.br/nfse/pt-br/noticias',
    ]);
    expect(r.feeds).toEqual(['https://www.gov.br/nfse/pt-br/noticias/RSS']);
  });

  it('respeita só o primeiro <base>', () => {
    const html = '<base href="https://www.gov.br/nfse/pt-br/pasta/"><base href="https://outro.example/"><a href="a.pdf">a</a>';
    expect(extrairLinks(html, PAGINA).links).toEqual(['https://www.gov.br/nfse/pt-br/pasta/a.pdf']);
  });

  it('decodifica entidades no href', () => {
    expect(extrairLinks('<a href="/nfse/x.pdf?a=1&amp;b=2">x</a>', PAGINA).links).toEqual([
      'https://www.gov.br/nfse/x.pdf?a=1&b=2',
    ]);
  });
});

describe('linksDeDocumentos', () => {
  it('mantém só documentos da lista oficial e conta os de fora', () => {
    const r = linksDeDocumentos([
      'https://www.gov.br/nfse/pt-br/a.pdf',
      'https://www.gov.br/nfse/pt-br/b.XLSX',
      'https://www.gov.br/nfse/pt-br/pagina',
      'https://blog.example/c.pdf',
      'https://www.gov.br/mre/d.pdf',
    ]);
    expect(r.documentos).toEqual(['https://www.gov.br/nfse/pt-br/a.pdf', 'https://www.gov.br/nfse/pt-br/b.XLSX']);
    expect(r.foraDaLista).toBe(2);
  });

  it('converte links de visualização do Plone no arquivo', () => {
    const r = linksDeDocumentos([
      'https://www.gov.br/nfse/pt-br/a.pdf/view',
      'https://www.gov.br/nfse/pt-br/b.zip/@@download/file',
      'https://www.gov.br/nfse/pt-br/pagina/view',
    ]);
    expect(r.documentos).toEqual(['https://www.gov.br/nfse/pt-br/a.pdf', 'https://www.gov.br/nfse/pt-br/b.zip']);
  });
});

describe('mimesParaDocumento', () => {
  it('liga extensão ao tipo esperado', () => {
    expect(mimesParaDocumento('https://www.gov.br/nfse/a.PDF')).toEqual(['application/pdf']);
    expect(mimesParaDocumento('https://www.gov.br/nfse/esquemas.zip')).toContain('application/zip');
    expect(mimesParaDocumento('https://www.gov.br/nfse/pagina')).toBeUndefined();
  });

  it('nunca aceita HTML para documento', () => {
    for (const ext of EXTENSOES_DOCUMENTO) {
      expect(mimesParaDocumento(`https://www.gov.br/nfse/x${ext}`)).not.toContain('text/html');
    }
  });
});

describe('decodificarHtml', () => {
  it('usa o charset do cabeçalho (Planalto em windows-1252)', () => {
    const corpo = Buffer.from([0x63, 0xe9, 0x75]);
    expect(decodificarHtml(corpo, 'text/html; charset=windows-1252')).toBe('céu');
  });

  it('usa o <meta charset> quando o cabeçalho não informa', () => {
    const corpo = Buffer.concat([Buffer.from('<meta charset="iso-8859-1">'), Buffer.from([0xe7])]);
    expect(decodificarHtml(corpo, 'text/html')).toContain('ç');
  });

  it('acha o charset no segundo <meta> e ignora metas sem charset', () => {
    const corpo = Buffer.concat([Buffer.from('<meta name="x" content="y"><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1252">'), Buffer.from([0xe9])]);
    expect(decodificarHtml(corpo, 'text/html')).toContain('é');
  });

  it('é linear com HTML hostil (ReDoS)', () => {
    const hostil = Buffer.from('<meta '.repeat(700) + ' '.repeat(5000));
    const inicio = performance.now();
    decodificarHtml(hostil, 'text/html');
    expect(performance.now() - inicio).toBeLessThan(50);
  });

  it('cai para UTF-8 com charset desconhecido', () => {
    expect(decodificarHtml(Buffer.from('ação'), 'text/html; charset=inexistente')).toBe('ação');
  });
});
