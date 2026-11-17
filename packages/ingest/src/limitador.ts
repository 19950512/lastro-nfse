import { setTimeout as esperar } from 'node:timers/promises';

/**
 * Intervalo mínimo entre requisições ao mesmo host (coleta respeitosa, ARQUITETURA.md §2.1).
 *
 * invariant: o horário de cada vaga é reservado de forma síncrona, então chamadas concorrentes
 * para o mesmo host ficam enfileiradas sem corrida.
 */
export class LimitadorPorHost {
  private readonly proximaVaga = new Map<string, number>();
  private readonly intervaloPadraoMs: number;
  private readonly relogio: () => number;

  constructor(intervaloPadraoMs: number, relogio: () => number = Date.now) {
    this.intervaloPadraoMs = intervaloPadraoMs;
    this.relogio = relogio;
  }

  async aguardar(host: string, intervaloMinimoMs = 0): Promise<void> {
    const intervalo = Math.max(this.intervaloPadraoMs, intervaloMinimoMs);
    const agora = this.relogio();
    const inicio = Math.max(agora, this.proximaVaga.get(host) ?? 0);
    this.proximaVaga.set(host, inicio + intervalo);
    if (inicio > agora) await esperar(inicio - agora);
  }
}
