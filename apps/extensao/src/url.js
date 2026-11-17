// invariant: o portal recebe o texto só pelo fragmento (#texto=…), que o navegador não manda ao servidor nem põe no
// Referer; o texto selecionado não passa por log de proxy nem de servidor antes de a pessoa decidir enviar.

export const MAX_TEXTO = 5000;

const LOCAIS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** why: só HTTPS (ou o portal local de desenvolvimento) recebe o texto; o resto vira null e a extensão pede configuração. */
export function validarPortal(entrada) {
  if (typeof entrada !== 'string' || entrada.trim() === '') return null;
  let url;
  try {
    url = new URL(entrada.trim());
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOCAIS.has(url.hostname)) return url.origin;
  return null;
}

export function montarUrlVerificacao(portal, texto) {
  const origem = validarPortal(portal);
  if (origem === null) return null;
  const limpo = typeof texto === 'string' ? texto.trim().slice(0, MAX_TEXTO) : '';
  if (limpo === '') return null;
  return `${origem}/verificar#texto=${encodeURIComponent(limpo)}`;
}
