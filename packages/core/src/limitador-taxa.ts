interface Balde {
  fichas: number;
  atualizadoEm: number;
}

const MAX_CHAVES = 100_000;

/**
 * Limite de requisições por janela deslizante aproximada (balde de fichas), em memória.
 *
 * hazard: vale por processo. Com mais de uma instância da API, cada uma conta separado; o limite efetivo
 * vira N × limite. Para escalar horizontalmente, trocar por contador compartilhado (ex.: Postgres ou Redis).
 */
export class LimitadorTaxa {
  private readonly baldes = new Map<string, Balde>();

  /** why: `janelaMs` permite limites como "5 por hora" (portal público); `porMinuto` é capacidade e reposição por janela. */
  consumir(chave: string, porMinuto: number, agoraMs: number, janelaMs = 60_000): { permitido: boolean; tenteEmSegundos: number } {
    const taxa = porMinuto / janelaMs;
    const atual = this.baldes.get(chave) ?? { fichas: porMinuto, atualizadoEm: agoraMs };
    atual.fichas = Math.min(porMinuto, atual.fichas + Math.max(0, agoraMs - atual.atualizadoEm) * taxa);
    atual.atualizadoEm = agoraMs;
    this.baldes.delete(chave);
    this.baldes.set(chave, atual);
    if (this.baldes.size > MAX_CHAVES) {
      // invariant: Map preserva ordem de inserção e cada uso reinsere; a primeira chave é a mais antiga.
      const antiga = this.baldes.keys().next().value;
      if (antiga !== undefined) this.baldes.delete(antiga);
    }
    if (atual.fichas >= 1) {
      atual.fichas -= 1;
      return { permitido: true, tenteEmSegundos: 0 };
    }
    return { permitido: false, tenteEmSegundos: Math.max(1, Math.ceil((1 - atual.fichas) / taxa / 1000)) };
  }
}
