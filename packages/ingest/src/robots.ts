import { verificarOrigemRobots } from '@lastro/core';
import robotsParserModulo from 'robots-parser';
import { buscarOficial, ErroColeta, type Transporte } from './http.ts';

// hazard: o pacote é CommonJS (`module.exports = fn`), mas o .d.ts declara `export default`.
// No ESM do Node o import default já é a função; só o tipo precisa ser corrigido.
const robotsParser = robotsParserModulo as unknown as typeof robotsParserModulo.default;

export const TOKEN_ROBO = 'LastroBot';

export type SituacaoRobots = 'encontrado' | 'ausente' | 'inacessivel';

export interface PoliticaRobots {
  readonly host: string;
  readonly situacao: SituacaoRobots;
  readonly detalhe: string;
  readonly atrasoSegundos: number | undefined;
  permitido(url: string): boolean;
}

function politica(
  host: string,
  situacao: SituacaoRobots,
  detalhe: string,
  conteudo?: string,
): PoliticaRobots {
  if (conteudo === undefined) {
    const liberado = situacao === 'ausente';
    return { host, situacao, detalhe, atrasoSegundos: undefined, permitido: () => liberado };
  }
  const robo = robotsParser(`https://${host}/robots.txt`, conteudo);
  return {
    host,
    situacao,
    detalhe,
    atrasoSegundos: robo.getCrawlDelay(TOKEN_ROBO),
    // invariant: o parser devolve undefined para URL de outro host; isso conta como não permitido.
    permitido: (url) => robo.isAllowed(url, TOKEN_ROBO) === true,
  };
}

/**
 * Interpreta robots.txt conforme a RFC 9309.
 *
 * why: §2.3.1.3 — erro 4xx significa "sem restrições"; §2.3.1.4 — erro 5xx ou falha de rede
 * significa "tudo proibido". Falhar fechado aqui também cobre redirecionamento para fora da lista.
 */
export async function obterRobots(host: string, transporte: Transporte, userAgent?: string): Promise<PoliticaRobots> {
  const url = `https://${host}/robots.txt`;
  try {
    const resposta = await buscarOficial(url, {
      transporte,
      verificar: verificarOrigemRobots,
      mimesAceitos: ['text/plain'],
      maxBytes: 512 * 1024,
      timeoutMs: 30_000,
      ...(userAgent === undefined ? {} : { userAgent }),
    });
    if (resposta.tipo !== 'ok') return politica(host, 'inacessivel', 'resposta inesperada');
    return politica(host, 'encontrado', `${resposta.corpo.byteLength} bytes`, resposta.corpo.toString('utf8'));
  } catch (erro) {
    if (erro instanceof ErroColeta) {
      if (erro.codigo === 'status-http' && erro.status !== undefined && erro.status >= 400 && erro.status < 500) {
        return politica(host, 'ausente', `HTTP ${erro.status}`);
      }
      if (erro.codigo === 'mime-negado') {
        return politica(host, 'ausente', `não é robots.txt (${erro.message})`);
      }
      return politica(host, 'inacessivel', `${erro.codigo}: ${erro.message}`);
    }
    throw erro;
  }
}

/** Cache por host durante uma rodada de coleta. */
export class CacheRobots {
  private readonly cache = new Map<string, Promise<PoliticaRobots>>();
  private readonly transporte: Transporte;
  private readonly userAgent: string | undefined;

  constructor(transporte: Transporte, userAgent?: string) {
    this.transporte = transporte;
    this.userAgent = userAgent;
  }

  obter(host: string): Promise<PoliticaRobots> {
    let politicaHost = this.cache.get(host);
    if (politicaHost === undefined) {
      politicaHost = obterRobots(host, this.transporte, this.userAgent);
      this.cache.set(host, politicaHost);
    }
    return politicaHost;
  }
}
