import { Parser } from 'htmlparser2';

export interface BlocoHtml {
  readonly tipo: 'titulo' | 'paragrafo';
  readonly texto: string;
  readonly nivel: number | null;
}

const IGNORAR = new Set(['head', 'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'nav', 'footer', 'form', 'button', 'select']);
// why: o Planalto mantém no texto compilado os dispositivos revogados ou com redação anterior, riscados
// com <strike>. Indexá-los faria a plataforma citar como vigente um texto que já não vale; o original
// continua no snapshot arquivado.
const RISCADOS = new Set(['strike', 's', 'del']);
const BLOCOS = new Set([
  'p', 'div', 'li', 'tr', 'table', 'section', 'article', 'blockquote', 'dt', 'dd', 'pre', 'center', 'ul', 'ol', 'dl', 'body', 'main', 'aside', 'figcaption', 'caption',
]);
// why: o catálogo de legislação da Prefeitura de São Paulo (Fase 5) não marca área principal; o ato inteiro fica em
// `<div class="col s12 customStyle">` (a ementa repete a classe com `bx-ementa`; `texto_compilado` é só o breadcrumb).
// Conferido nas três páginas coletadas em 17/11/2026. invariant: mesma regra de `normalizarHtml` (packages/ingest).
const temClasse = (classe: string, nome: string): boolean => classe.split(/\s+/).includes(nome);
const areaDeTextoLegal = (classe: string): boolean => temClasse(classe, 'customStyle') && !temClasse(classe, 'bx-ementa');
const TITULOS = new Map([['h1', 1], ['h2', 2], ['h3', 3], ['h4', 4], ['h5', 5], ['h6', 6]]);

const colapsar = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Rótulo de charset declarado em `<meta>`, lido de forma linear (sem regex com retrocesso). */
function charsetDoMeta(inicio: string): string | undefined {
  let posicao = inicio.indexOf('<meta');
  while (posicao !== -1) {
    const fim = inicio.indexOf('>', posicao);
    const tag = inicio.slice(posicao, fim === -1 ? undefined : fim);
    const atributo = tag.indexOf('charset=');
    if (atributo !== -1) {
      const valor = /^["']?([\w-]+)/.exec(tag.slice(atributo + 'charset='.length))?.[1];
      if (valor !== undefined) return valor;
    }
    if (fim === -1) return undefined;
    posicao = inicio.indexOf('<meta', fim);
  }
  return undefined;
}

/**
 * Decodifica HTML oficial.
 *
 * why: o Planalto publica em windows-1252 sem declarar charset; quando nada é declarado e os bytes não
 * são UTF-8 válido, a decodificação cai para windows-1252 em vez de corromper os acentos.
 */
export function decodificarHtml(corpo: Buffer, mime = ''): string {
  const declarado = /charset=["']?([\w-]+)/i.exec(mime)?.[1] ?? charsetDoMeta(corpo.subarray(0, 4096).toString('latin1').toLowerCase());
  if (declarado !== undefined) {
    try {
      return new TextDecoder(declarado).decode(corpo);
    } catch {
      // why: rótulo desconhecido pelo TextDecoder; segue a detecção abaixo.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(corpo);
  } catch {
    return new TextDecoder('windows-1252').decode(corpo);
  }
}

/**
 * Blocos de texto (títulos e parágrafos) da página, na ordem do documento.
 *
 * invariant: se a página tem área principal (`<main>`, `role="main"` ou `id="content"`), só ela conta,
 * como em `normalizarHtml` do coletor: menus e rodapés do gov.br não viram trecho citável.
 */
export function blocosDeHtml(html: string): BlocoHtml[] {
  const todos: BlocoHtml[] = [];
  const daRegiao: BlocoHtml[] = [];
  const pilha: { ignorar: boolean; regiao: boolean }[] = [];
  const estado = { ignorados: 0, emRegiao: 0, regiaoEncontrada: false, nivelTitulo: 0 };
  let buffer: string[] = [];

  const descarregar = (): void => {
    const texto = colapsar(buffer.join(''));
    buffer = [];
    if (texto === '') return;
    const bloco: BlocoHtml = estado.nivelTitulo > 0 ? { tipo: 'titulo', texto, nivel: estado.nivelTitulo } : { tipo: 'paragrafo', texto, nivel: null };
    todos.push(bloco);
    if (estado.emRegiao > 0) daRegiao.push(bloco);
  };

  const parser = new Parser(
    {
      onopentag(nome, atributos) {
        const ignorar = IGNORAR.has(nome) || RISCADOS.has(nome);
        const ehRegiao =
          !estado.regiaoEncontrada &&
          estado.ignorados === 0 &&
          (nome === 'main' || atributos.role === 'main' || atributos.id === 'content' || areaDeTextoLegal(atributos.class ?? ''));
        if (ehRegiao) {
          descarregar();
          estado.regiaoEncontrada = true;
        }
        pilha.push({ ignorar, regiao: ehRegiao });
        if (ignorar) estado.ignorados++;
        if (ehRegiao) estado.emRegiao++;
        if (estado.ignorados > 0) return;
        const nivel = TITULOS.get(nome);
        if (nivel !== undefined) {
          descarregar();
          estado.nivelTitulo = nivel;
        } else if (BLOCOS.has(nome) || nome === 'br') {
          descarregar();
        } else if ((nome === 'td' || nome === 'th') && buffer.join('').trim() !== '') {
          buffer.push(' | ');
        }
      },
      ontext(texto) {
        if (estado.ignorados === 0) buffer.push(texto);
      },
      onclosetag(nome) {
        const topo = pilha.pop();
        if (estado.ignorados === 0) {
          if (TITULOS.has(nome)) {
            descarregar();
            estado.nivelTitulo = 0;
          } else if (BLOCOS.has(nome)) {
            descarregar();
          }
        }
        if (topo?.ignorar === true) estado.ignorados--;
        if (topo?.regiao === true) {
          descarregar();
          estado.emRegiao--;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  descarregar();
  return estado.regiaoEncontrada ? daRegiao : todos;
}
