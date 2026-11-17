import { Worker } from 'node:worker_threads';
import { ErroParser } from './erro.ts';
import type { MensagemPdf } from './pdf-worker.ts';

export interface OpcoesPdf {
  readonly timeoutMs?: number;
  readonly maxMemoriaMb?: number;
  readonly maxPaginas?: number;
}

/**
 * Texto de cada página (índice 0 = página 1) de um PDF.
 *
 * hazard: PDF malformado pode travar ou estourar memória do pdf.js. O parsing roda numa thread
 * isolada com memória limitada e é encerrado no tempo máximo (SEGURANCA.md §8). A camada de
 * produção prevista, contêiner sem rede e com CPU limitada, ainda está pendente.
 */
export function extrairPaginasPdf(corpo: Buffer, opcoes: OpcoesPdf = {}): Promise<string[]> {
  const timeoutMs = opcoes.timeoutMs ?? 120_000;
  const maxPaginas = opcoes.maxPaginas ?? 2000;
  return new Promise((resolver, rejeitar) => {
    const worker = new Worker(new URL('./pdf-worker.ts', import.meta.url), {
      workerData: { dados: new Uint8Array(corpo), maxPaginas },
      resourceLimits: { maxOldGenerationSizeMb: opcoes.maxMemoriaMb ?? 512, maxYoungGenerationSizeMb: 64 },
      stdout: true,
      stderr: true,
    });
    let encerrado = false;
    const terminar = (acao: () => void): void => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(relogio);
      acao();
      void worker.terminate();
    };
    const relogio = setTimeout(() => {
      terminar(() => {
        rejeitar(new ErroParser(`PDF: tempo esgotado (${timeoutMs} ms)`));
      });
    }, timeoutMs);
    worker.on('message', (mensagem: MensagemPdf) => {
      terminar(() => {
        if (!mensagem.ok) rejeitar(new ErroParser(`PDF: ${mensagem.erro}`));
        else if (!Array.isArray(mensagem.paginas) || mensagem.paginas.some((p) => typeof p !== 'string')) rejeitar(new ErroParser('PDF: resposta inválida do extrator'));
        else resolver(mensagem.paginas);
      });
    });
    worker.on('error', (erro: unknown) => {
      terminar(() => {
        rejeitar(new ErroParser(`PDF: extrator falhou (${erro instanceof Error ? erro.name : 'erro'})`));
      });
    });
    worker.on('exit', (codigo) => {
      terminar(() => {
        rejeitar(new ErroParser(`PDF: extrator encerrou sem resposta (código ${codigo})`));
      });
    });
  });
}
