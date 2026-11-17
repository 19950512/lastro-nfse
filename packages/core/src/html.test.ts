import { describe, expect, it } from 'vitest';
import { hrefSeguro, html } from './html.ts';

describe('html', () => {
  it('escapa interpolações por padrão e preserva Html aninhado', () => {
    const perigoso = `"><script>alert('x')</script>`;
    const saida = html`<a title="${perigoso}">${html`<b>${perigoso}</b>`}</a>`.valor;
    expect(saida).toBe(
      '<a title="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"><b>&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;</b></a>',
    );
  });

  it('renderiza listas e omite vazios', () => {
    expect(html`${['<a>', '<b>']}${null}${undefined}${false}${0}`.valor).toBe('&lt;a&gt;&lt;b&gt;0');
  });

  it('recusa objetos arbitrários', () => {
    expect(() => html`${{ toString: () => '<x>' }}`).toThrow(TypeError);
  });
});

describe('hrefSeguro', () => {
  it.each([
    ['javascript:alert(1)', '#'],
    ['data:text/html,<script>', '#'],
    ['http://www.gov.br/nfse', '#'],
    ['//atacante.example/x', '#'],
    ['/painel/documentos', '/painel/documentos'],
    ['https://www.gov.br/nfse/pt-br', 'https://www.gov.br/nfse/pt-br'],
  ])('%s → %s', (entrada, esperado) => {
    expect(hrefSeguro(entrada)).toBe(esperado);
  });
});
