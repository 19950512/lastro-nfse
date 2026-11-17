import { parentPort, workerData } from 'node:worker_threads';
import { extractText, getDocumentProxy } from 'unpdf';

interface Entrada {
  readonly dados: Uint8Array;
  readonly maxPaginas: number;
}

export type MensagemPdf = { readonly ok: true; readonly paginas: string[] } | { readonly ok: false; readonly erro: string };

async function executar(entrada: Entrada): Promise<MensagemPdf> {
  try {
    const documento = await getDocumentProxy(entrada.dados);
    if (documento.numPages > entrada.maxPaginas) return { ok: false, erro: `PDF com ${documento.numPages} páginas (limite ${entrada.maxPaginas})` };
    const { text } = await extractText(documento, { mergePages: false });
    return { ok: true, paginas: text };
  } catch (erro) {
    return { ok: false, erro: erro instanceof Error ? erro.message : 'falha ao ler PDF' };
  }
}

parentPort?.postMessage(await executar(workerData as Entrada));
