import { describe, expect, it } from 'vitest';
import { gerarRelatorio } from './relatorio.ts';
import type { SondagemUrl } from './sondagem.ts';

const base: SondagemUrl = {
  fonteId: 'nfse-rtc',
  fonteNome: 'RTC',
  nivel: 'N2',
  url: 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc',
  robots: { situacao: 'encontrado', detalhe: '10 bytes', atrasoSegundos: null, permitido: true },
  acesso: 'ok',
  status: 200,
  mime: 'text/html',
  bytes: 2048,
  sha256: 'a'.repeat(64),
  duracaoMs: 100,
  urlFinal: 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc',
  saltos: [],
  erro: null,
  etag: null,
  ultimaModificacao: null,
  condicional: 'sem-validadores',
  estavel: false,
  estavelConteudo: true,
  documentos: { total: 3, porExtensao: { '.pdf': 2, '.xlsx': 1 }, exemplos: [] },
  documentosForaDaLista: 0,
  feeds: [],
};

describe('gerarRelatorio', () => {
  it('resume e lista cada semente', () => {
    const md = gerarRelatorio({ executadaEm: '2026-11-16T23:00:00.000Z', userAgent: 'LastroBot/0.1', resultados: [base] });
    expect(md).toContain('| Sementes sondadas | 1 |');
    expect(md).toContain('| Bytes diferentes entre duas leituras seguidas | 1 |');
    expect(md).toContain('| Conteúdo normalizado diferente entre duas leituras seguidas | 0 |');
    expect(md).toContain('**não** / sim');
    expect(md).toContain('3 (2 pdf, 1 xlsx)');
    expect(md).toContain('2.0 KiB');
  });

  it('escapa texto vindo do site para não quebrar a tabela nem injetar HTML', () => {
    const md = gerarRelatorio({
      executadaEm: '2026-11-16T23:00:00.000Z',
      userAgent: 'x',
      resultados: [
        {
          ...base,
          acesso: 'erro',
          erro: { codigo: 'rede', mensagem: 'falha | <script>alert(1)</script>\nlinha', status: null },
        },
      ],
    });
    expect(md).not.toContain('<script>');
    expect(md).toContain('falha \\| &lt;script&gt;');
  });
});
