export interface ConfigSecurityTxt {
  /** `mailto:` ou `https:` do canal de divulgação de vulnerabilidades. */
  readonly contato: string;
  /** Data ISO (AAAA-MM-DD ou com hora) a partir da qual o arquivo deixa de valer. */
  readonly expira: string;
  /** URL https da política de divulgação. */
  readonly politica?: string | undefined;
  /** URL https canônica onde o arquivo é publicado. */
  readonly canonico?: string | undefined;
}

export class ErroSecurityTxt extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroSecurityTxt';
  }
}

const UM_ANO_MS = 366 * 86_400_000;

function exigirHttps(nome: string, valor: string): string {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new ErroSecurityTxt(`${nome}: URL inválida`);
  }
  if (url.protocol !== 'https:') throw new ErroSecurityTxt(`${nome}: use https`);
  return url.toString();
}

/**
 * Conteúdo de `/.well-known/security.txt` (RFC 9116), exigido na Fase 4 (SEGURANCA.md §15).
 *
 * invariant: arquivo vencido não é servido (devolve undefined). Um Expires que se renova sozinho esconderia que
 * ninguém revisou o contato; por isso a data vem da configuração e o RFC limita a menos de um ano.
 */
export function montarSecurityTxt(config: ConfigSecurityTxt, agora: Date = new Date()): string | undefined {
  const contato = config.contato.trim();
  if (contato.startsWith('mailto:')) {
    if (!/^mailto:[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(contato)) throw new ErroSecurityTxt('contato: e-mail inválido');
  } else {
    exigirHttps('contato', contato);
  }
  const expira = new Date(config.expira.length === 10 ? `${config.expira}T00:00:00Z` : config.expira);
  if (Number.isNaN(expira.getTime())) throw new ErroSecurityTxt('expira: data inválida');
  if (expira.getTime() - agora.getTime() > UM_ANO_MS) throw new ErroSecurityTxt('expira: no máximo um ano à frente (RFC 9116)');
  if (expira.getTime() <= agora.getTime()) return undefined;
  const linhas = [`Contact: ${contato}`, `Expires: ${expira.toISOString()}`, 'Preferred-Languages: pt, en'];
  if (config.politica !== undefined && config.politica !== '') linhas.push(`Policy: ${exigirHttps('política', config.politica)}`);
  if (config.canonico !== undefined && config.canonico !== '') linhas.push(`Canonical: ${exigirHttps('canônico', config.canonico)}`);
  return `${linhas.join('\n')}\n`;
}

/** Lê `LASTRO_SECURITY_CONTATO`, `LASTRO_SECURITY_EXPIRA` e `LASTRO_SECURITY_POLITICA`; sem contato, não há arquivo. */
export function securityTxtDoAmbiente(ambiente: NodeJS.ProcessEnv, canonico?: string): ConfigSecurityTxt | undefined {
  const contato = ambiente.LASTRO_SECURITY_CONTATO ?? '';
  if (contato === '') return undefined;
  const expira = ambiente.LASTRO_SECURITY_EXPIRA ?? '';
  if (expira === '') throw new ErroSecurityTxt('LASTRO_SECURITY_EXPIRA é obrigatório quando LASTRO_SECURITY_CONTATO está definido');
  return { contato, expira, politica: ambiente.LASTRO_SECURITY_POLITICA, canonico };
}
