import { isIP } from 'node:net';

/**
 * Lista fechada de origens oficiais (docs/FONTES-OFICIAIS.md, "Política: somente fontes oficiais").
 *
 * invariant: uma origem é host exato + prefixo de caminho. O host `www.gov.br` hospeda todos os
 * órgãos federais, então liberar o host inteiro abriria a base para órgãos fora do catálogo.
 */
export interface OrigemOficial {
  readonly host: string;
  readonly prefixos: readonly string[];
  readonly orgao: string;
}

export const ORIGENS_OFICIAIS: readonly OrigemOficial[] = [
  { host: 'www.gov.br', prefixos: ['/nfse/'], orgao: 'Comitê Gestor da NFS-e (CGNFS-e) / Portal Nacional da NFS-e' },
  { host: 'www.gov.br', prefixos: ['/receitafederal/'], orgao: 'Receita Federal do Brasil' },
  { host: 'www.gov.br', prefixos: ['/fazenda/'], orgao: 'Ministério da Fazenda' },
  { host: 'www.planalto.gov.br', prefixos: ['/ccivil_03/'], orgao: 'Presidência da República (Planalto)' },
  { host: 'www.in.gov.br', prefixos: ['/'], orgao: 'Imprensa Nacional (Diário Oficial da União)' },
  { host: 'inlabs.in.gov.br', prefixos: ['/'], orgao: 'Imprensa Nacional (INLABS)' },
  { host: 'normas.receita.fazenda.gov.br', prefixos: ['/'], orgao: 'Receita Federal do Brasil (SIJUT)' },
  { host: 'www.cgibs.gov.br', prefixos: ['/'], orgao: 'Comitê Gestor do IBS (CGIBS)' },
  // why: o Portal NFS-e linka os atos do CGIBS no domínio sem www (ex.: Ato Conjunto nº 7/2026).
  { host: 'cgibs.gov.br', prefixos: ['/'], orgao: 'Comitê Gestor do IBS (CGIBS)' },
  { host: 'www.lexml.gov.br', prefixos: ['/'], orgao: 'LexML Brasil' },
  { host: 'www.nfe.fazenda.gov.br', prefixos: ['/portal/'], orgao: 'Portal Nacional da NF-e' },
];

export type ResultadoOrigem =
  | { readonly permitido: true; readonly url: URL; readonly origem: OrigemOficial }
  | { readonly permitido: false; readonly motivo: string };

// hazard: o parser de URL não decodifica %2F, %5C nem %2E, mas o servidor pode decodificar e
// resolver para outro caminho (ex.: /nfse/..%2F..%2Fmre/), fugindo do prefixo do órgão.
const SEQUENCIA_PERIGOSA = /%(2f|5c|2e|00)/i;

function normalizarHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function analisar(entrada: string | URL): URL | string {
  try {
    return new URL(entrada.toString());
  } catch {
    return 'URL inválida';
  }
}

/** Verificações comuns a qualquer requisição a site oficial: protocolo, credenciais, porta, host. */
function validarBase(url: URL): string | undefined {
  if (url.protocol !== 'https:') return `protocolo não permitido: ${url.protocol}`;
  if (url.username !== '' || url.password !== '') return 'URL com credenciais embutidas';
  if (url.port !== '') return `porta explícita não permitida: ${url.port}`;
  const host = normalizarHost(url.hostname);
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return 'IP literal não permitido';
  if (SEQUENCIA_PERIGOSA.test(url.pathname)) return 'caminho com sequência codificada proibida';
  return undefined;
}

export function verificarOrigem(entrada: string | URL): ResultadoOrigem {
  const url = analisar(entrada);
  if (typeof url === 'string') return { permitido: false, motivo: url };
  const erro = validarBase(url);
  if (erro !== undefined) return { permitido: false, motivo: erro };

  const host = normalizarHost(url.hostname);
  const origem = ORIGENS_OFICIAIS.find(
    (o) => o.host === host && o.prefixos.some((p) => url.pathname.startsWith(p)),
  );
  if (origem === undefined) return { permitido: false, motivo: `origem fora da lista oficial: ${host}${url.pathname}` };
  return { permitido: true, url, origem };
}

/**
 * robots.txt fica na raiz do host, fora do prefixo do órgão (ex.: www.gov.br/robots.txt).
 * Só esse caminho exato é liberado, e só para hosts da lista.
 */
export function verificarOrigemRobots(entrada: string | URL): ResultadoOrigem {
  const url = analisar(entrada);
  if (typeof url === 'string') return { permitido: false, motivo: url };
  const erro = validarBase(url);
  if (erro !== undefined) return { permitido: false, motivo: erro };
  if (url.pathname !== '/robots.txt' || url.search !== '') return { permitido: false, motivo: 'não é /robots.txt' };

  const host = normalizarHost(url.hostname);
  const origem = ORIGENS_OFICIAIS.find((o) => o.host === host);
  if (origem === undefined) return { permitido: false, motivo: `host fora da lista oficial: ${host}` };
  return { permitido: true, url, origem };
}

export function hostsOficiais(): string[] {
  return [...new Set(ORIGENS_OFICIAIS.map((o) => o.host))];
}
