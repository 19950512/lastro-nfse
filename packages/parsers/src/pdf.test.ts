import { describe, expect, it } from 'vitest';
import { ErroParser } from './erro.ts';
import { extrairPaginasPdf } from './pdf.ts';
import { criarPdf } from './pdf-para-teste.ts';

describe('extrairPaginasPdf (thread isolada)', () => {
  it('extrai o texto de cada página', async () => {
    const paginas = await extrairPaginasPdf(criarPdf(['Art. 1 Primeira pagina', 'Segunda pagina']));
    expect(paginas).toHaveLength(2);
    expect(paginas[0]).toContain('Art. 1 Primeira pagina');
    expect(paginas[1]).toContain('Segunda pagina');
  });

  it('encerra a thread no tempo máximo', async () => {
    await expect(extrairPaginasPdf(criarPdf(['x']), { timeoutMs: 1 })).rejects.toThrow(/tempo esgotado/);
  });

  it('recusa PDF acima do limite de páginas', async () => {
    await expect(extrairPaginasPdf(criarPdf(['a', 'b', 'c']), { maxPaginas: 2 })).rejects.toThrow(/páginas/);
  });

  it('falha fechada com bytes que não são PDF', async () => {
    await expect(extrairPaginasPdf(Buffer.from('isto não é um PDF'))).rejects.toBeInstanceOf(ErroParser);
  });
});
