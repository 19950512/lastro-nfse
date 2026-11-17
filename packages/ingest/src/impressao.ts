import { Parser } from 'htmlparser2';
import { sha256 } from './http.ts';
import { decodificarHtml } from './links.ts';

const IGNORAR = new Set(['head', 'script', 'style', 'noscript', 'template', 'svg', 'iframe']);
const MIMES_HTML = new Set(['text/html', 'application/xhtml+xml']);

/**
 * Texto normalizado de uma página: texto visível + destinos de links, sem `<head>`, scripts e
 * atributos. Se houver área principal (`<main>`, `role="main"` ou `id="content"`), só ela conta.
 *
 * why: a sondagem da Fase 0 (docs/SONDAGEM-FASE-0.md) mostrou páginas oficiais com bytes diferentes
 * a cada leitura sem mudança de conteúdo — token do balanceador F5 no Planalto, id aleatório no
 * CGIBS, réplicas do gov.br com `<link rel="search">` distinto. Comparar bytes geraria "nova versão"
 * falsa a cada rodada.
 */
export function normalizarHtml(html: string): string {
  const todas: string[] = [];
  const regiao: string[] = [];
  const pilha: { ignorar: boolean; regiao: boolean }[] = [];
  const estado = { ignorados: 0, emRegiao: 0, regiaoEncontrada: false };

  const emitir = (texto: string): void => {
    todas.push(texto);
    if (estado.emRegiao > 0) regiao.push(texto);
  };

  const parser = new Parser(
    {
      onopentag(nome, atributos) {
        const ignorar = IGNORAR.has(nome);
        const ehRegiao =
          !estado.regiaoEncontrada &&
          estado.ignorados === 0 &&
          (nome === 'main' || atributos.role === 'main' || atributos.id === 'content');
        if (ehRegiao) estado.regiaoEncontrada = true;
        pilha.push({ ignorar, regiao: ehRegiao });
        if (ignorar) estado.ignorados++;
        if (ehRegiao) estado.emRegiao++;
        if (estado.ignorados === 0 && (nome === 'a' || nome === 'area') && atributos.href !== undefined) {
          emitir(` [${atributos.href.trim()}] `);
        }
      },
      ontext(texto) {
        if (estado.ignorados === 0) emitir(texto);
      },
      onclosetag() {
        const topo = pilha.pop();
        if (topo?.ignorar === true) estado.ignorados--;
        if (topo?.regiao === true) estado.emRegiao--;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const escolhido = estado.regiaoEncontrada ? regiao : todas;
  return escolhido.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Identidade de conteúdo usada para detectar mudança.
 *
 * invariant: só HTML é normalizado. PDF, XLSX, ZIP e demais formatos usam o SHA-256 dos bytes,
 * porque qualquer byte diferente pode ser uma versão nova do documento.
 */
export function impressaoDigital(corpo: Buffer, mime: string): string {
  if (!MIMES_HTML.has(mime)) return sha256(corpo);
  return `html:${sha256(Buffer.from(normalizarHtml(decodificarHtml(corpo, mime))))}`;
}
