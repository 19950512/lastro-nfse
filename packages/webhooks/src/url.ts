import { isIP } from 'node:net';

export type ResultadoUrlWebhook = { readonly valida: true; readonly url: URL } | { readonly valida: false; readonly motivo: string };

const SUFIXOS_INTERNOS = ['.local', '.internal', '.localhost', '.lan', '.home', '.corp', '.intranet'];

/**
 * Validação estática da URL de um assinante (SEGURANCA.md §9). A resolução de DNS é conferida de
 * novo a cada envio, pelo lookup seguro, porque o DNS do cliente pode mudar depois do cadastro.
 *
 * hazard: aqui não há lista fechada como no coletor; a URL é do cliente. A proteção é só HTTPS,
 * nome de host público e endereço resolvido público no momento da conexão.
 */
export function validarUrlWebhook(entrada: string): ResultadoUrlWebhook {
  let url: URL;
  try {
    url = new URL(entrada);
  } catch {
    return { valida: false, motivo: 'URL inválida' };
  }
  if (url.protocol !== 'https:') return { valida: false, motivo: 'só HTTPS é aceito' };
  if (url.username !== '' || url.password !== '') return { valida: false, motivo: 'URL com credenciais embutidas' };
  if (url.hash !== '') return { valida: false, motivo: 'URL com fragmento' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return { valida: false, motivo: 'IP literal não é aceito; use um nome de host' };
  if (!host.includes('.')) return { valida: false, motivo: 'host sem domínio público' };
  if (SUFIXOS_INTERNOS.some((s) => host.endsWith(s))) return { valida: false, motivo: 'domínio interno' };
  if (entrada.length > 2048) return { valida: false, motivo: 'URL longa demais' };
  return { valida: true, url };
}
