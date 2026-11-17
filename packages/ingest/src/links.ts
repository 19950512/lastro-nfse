import { verificarOrigem } from '@lastro/core';
import { Parser } from 'htmlparser2';

export interface LinksDaPagina {
  /** Links absolutos http(s), sem fragmento e sem repetição, na ordem em que aparecem. */
  readonly links: readonly string[];
  /** Feeds RSS/Atom anunciados em <link rel="alternate">. */
  readonly feeds: readonly string[];
}

const TIPOS_FEED = new Set(['application/rss+xml', 'application/atom+xml']);

function rotuloCharset(contentType: string | undefined, corpo: Buffer): string {
  const doCabecalho = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (doCabecalho !== undefined) return doCabecalho;
  const inicio = corpo.subarray(0, 4096).toString('latin1');
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(inicio)?.[1] ?? 'utf-8';
}

/** why: o Planalto publica em windows-1252/ISO-8859-1; decodificar como UTF-8 corromperia acentos. */
export function decodificarHtml(corpo: Buffer, contentType?: string): string {
  try {
    return new TextDecoder(rotuloCharset(contentType, corpo)).decode(corpo);
  } catch {
    return new TextDecoder('utf-8').decode(corpo);
  }
}

function absoluto(href: string, base: URL): string | undefined {
  try {
    const url = new URL(href.trim(), base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function extrairLinks(html: string, urlPagina: string): LinksDaPagina {
  let base = new URL(urlPagina);
  let baseDefinida = false;
  const links = new Set<string>();
  const feeds = new Set<string>();

  const parser = new Parser(
    {
      onopentag(nome, atributos) {
        if (nome === 'base' && !baseDefinida && atributos.href !== undefined) {
          // why: como no navegador, só o primeiro <base> vale; o destino ainda passa pela lista oficial depois.
          const novaBase = absoluto(atributos.href, base);
          if (novaBase !== undefined) base = new URL(novaBase);
          baseDefinida = true;
          return;
        }
        const href = atributos.href;
        if (href === undefined) return;
        if (nome === 'a' || nome === 'area') {
          const url = absoluto(href, base);
          if (url !== undefined) links.add(url);
        } else if (nome === 'link' && /\balternate\b/i.test(atributos.rel ?? '')) {
          if (TIPOS_FEED.has((atributos.type ?? '').toLowerCase())) {
            const url = absoluto(href, base);
            if (url !== undefined) feeds.add(url);
          }
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return { links: [...links], feeds: [...feeds] };
}

const MIMES_POR_EXTENSAO: Readonly<Record<string, readonly string[]>> = {
  '.pdf': ['application/pdf'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xls': ['application/vnd.ms-excel'],
  '.zip': ['application/zip', 'application/x-zip-compressed'],
  '.xsd': ['application/xml', 'text/xml'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.odt': ['application/vnd.oasis.opendocument.text'],
  '.ods': ['application/vnd.oasis.opendocument.spreadsheet'],
  '.csv': ['text/csv'],
};

export const EXTENSOES_DOCUMENTO = Object.keys(MIMES_POR_EXTENSAO);

/**
 * Tipos aceitos para a URL de um documento, pela extensão.
 *
 * hazard: sites oficiais em manutenção respondem 200 com página HTML (caso real do INLABS em
 * 16/11/2026). Sem esta checagem, a página de erro seria arquivada como nova versão do PDF.
 */
export function mimesParaDocumento(url: string): readonly string[] | undefined {
  const extensao = extensaoDocumento(new URL(url).pathname);
  return extensao === undefined ? undefined : MIMES_POR_EXTENSAO[extensao];
}

/** Sufixos do Plone que apontam para a página de visualização em vez do arquivo. */
const SUFIXOS_PLONE = ['/view', '/@@download/file', '/at_download/file'];

export function extensaoDocumento(caminho: string): string | undefined {
  const minusculo = caminho.toLowerCase();
  return EXTENSOES_DOCUMENTO.find((e) => minusculo.endsWith(e));
}

/**
 * Filtra links que apontam para documentos dentro da lista oficial.
 * Links para fora da lista são descartados aqui (barreira de origem, ARQUITETURA.md §2.1).
 */
export function linksDeDocumentos(links: readonly string[]): { documentos: string[]; foraDaLista: number } {
  const documentos = new Set<string>();
  let foraDaLista = 0;
  for (const link of links) {
    const url = new URL(link);
    for (const sufixo of SUFIXOS_PLONE) {
      if (url.pathname.endsWith(sufixo) && extensaoDocumento(url.pathname.slice(0, -sufixo.length)) !== undefined) {
        url.pathname = url.pathname.slice(0, -sufixo.length);
      }
    }
    if (extensaoDocumento(url.pathname) === undefined) continue;
    if (!verificarOrigem(url).permitido) {
      foraDaLista++;
      continue;
    }
    documentos.add(url.toString());
  }
  return { documentos: [...documentos], foraDaLista };
}
