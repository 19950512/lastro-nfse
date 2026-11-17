import { describe, expect, it } from 'vitest';
import { LimitadorPorHost } from './limitador.ts';

describe('LimitadorPorHost', () => {
  it('espaça chamadas ao mesmo host e não atrasa hosts diferentes', async () => {
    const limitador = new LimitadorPorHost(60);
    const inicio = Date.now();
    const tempos: Record<string, number[]> = { a: [], b: [] };
    await Promise.all([
      ...[1, 2, 3].map(async () => {
        await limitador.aguardar('a');
        tempos.a?.push(Date.now() - inicio);
      }),
      (async () => {
        await limitador.aguardar('b');
        tempos.b?.push(Date.now() - inicio);
      })(),
    ]);
    const a = (tempos.a ?? []).sort((x, y) => x - y);
    expect(a[2]).toBeGreaterThanOrEqual(110);
    expect(tempos.b?.[0]).toBeLessThan(50);
  });

  it('usa o maior entre o intervalo padrão e o crawl-delay', async () => {
    const limitador = new LimitadorPorHost(10);
    const inicio = Date.now();
    await limitador.aguardar('h', 80);
    await limitador.aguardar('h', 80);
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(75);
  });
});
