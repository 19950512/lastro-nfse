/**
 * Template HTML que escapa toda interpolação por padrão (SEGURANCA.md §4).
 *
 * invariant: texto só vira marcação se já for `Html` produzido por este template. Títulos, URLs e
 * resumos vindos de sites oficiais entram sempre escapados, mesmo se um documento for adulterado.
 */
export class Html {
  readonly valor: string;
  constructor(valor: string) {
    this.valor = valor;
  }
  toString(): string {
    return this.valor;
  }
}

const ENTIDADES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapar(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ENTIDADES[c] ?? c);
}

function renderizar(valor: unknown): string {
  if (valor instanceof Html) return valor.valor;
  if (Array.isArray(valor)) return valor.map(renderizar).join('');
  if (valor === null || valor === undefined || valor === false) return '';
  if (typeof valor === 'string') return escapar(valor);
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  throw new TypeError('valor não renderizável no template HTML');
}

export function html(partes: TemplateStringsArray, ...valores: unknown[]): Html {
  let saida = partes[0] ?? '';
  valores.forEach((valor, i) => {
    saida += renderizar(valor) + (partes[i + 1] ?? '');
  });
  return new Html(saida);
}

// hazard: href aceita só caminho relativo da própria aplicação ou https; `javascript:` e similares viram '#'.
export function hrefSeguro(url: string): string {
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    return new URL(url).protocol === 'https:' ? url : '#';
  } catch {
    return '#';
  }
}
