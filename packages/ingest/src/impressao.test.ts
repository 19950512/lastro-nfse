import { describe, expect, it } from 'vitest';
import { sha256 } from './http.ts';
import { impressaoDigital, normalizarHtml } from './impressao.ts';

describe('normalizarHtml', () => {
  it('ignora token do balanceador F5 em <script> (caso real do Planalto)', () => {
    const a = '<html><body><p>Art. 1º Esta Lei Complementar…</p><script id="f5_cspm">var f5_p=\'GJFDCD\';</script></body></html>';
    const b = '<html><body><p>Art. 1º Esta Lei Complementar…</p><script id="f5_cspm">var f5_p=\'BPDFKA\';</script></body></html>';
    expect(normalizarHtml(a)).toBe(normalizarHtml(b));
    expect(normalizarHtml(a)).toBe('Art. 1º Esta Lei Complementar…');
  });

  it('ignora atributos aleatórios (caso real do CGIBS)', () => {
    const a = '<body><div id="dynamicTop6afb8d69840d1">Resolução CGIBS nº 6</div></body>';
    const b = '<body><div id="dynamicTop6afb8d6d61179">Resolução CGIBS nº 6</div></body>';
    expect(normalizarHtml(a)).toBe(normalizarHtml(b));
  });

  it('ignora o <head> (caso real das réplicas do gov.br)', () => {
    const a = '<head><link rel="search" href="https://www.gov.br/nfse/@@search"></head><body><main>NT 009</main></body>';
    const b = '<head><link rel="search" href="https://www.gov.br/nfse/pt-br/@@search"></head><body><main>NT 009</main></body>';
    expect(normalizarHtml(a)).toBe(normalizarHtml(b));
  });

  it('usa só a área principal quando existe', () => {
    const html = '<body><nav>Menu 1</nav><main id="main-content"><h1>RTC</h1></main><footer>Rodapé</footer></body>';
    expect(normalizarHtml(html)).toBe('RTC');
  });

  it('detecta mudança de texto e de destino de link', () => {
    const base = '<main><a href="nt-009-v1-01.pdf">NT 009</a></main>';
    expect(normalizarHtml(base)).not.toBe(normalizarHtml('<main><a href="nt-009-v1-02.pdf">NT 009</a></main>'));
    expect(normalizarHtml(base)).not.toBe(normalizarHtml('<main><a href="nt-009-v1-01.pdf">NT 010</a></main>'));
  });

  it('colapsa espaços', () => {
    expect(normalizarHtml('<p>a\n\n   b</p>')).toBe(normalizarHtml('<p>a b</p>'));
  });
});

describe('impressaoDigital', () => {
  it('usa o hash dos bytes para documentos que não são HTML', () => {
    const pdf = Buffer.from('%PDF-1.7');
    expect(impressaoDigital(pdf, 'application/pdf')).toBe(sha256(pdf));
  });

  it('marca impressões de HTML para não colidirem com hash de bytes', () => {
    expect(impressaoDigital(Buffer.from('<p>x</p>'), 'text/html')).toMatch(/^html:[0-9a-f]{64}$/);
  });
});
