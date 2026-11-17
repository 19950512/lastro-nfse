import { describe, expect, it } from 'vitest';
import { FONTES } from './fontes.ts';
import { verificarOrigem } from './origem.ts';

describe('catálogo de fontes', () => {
  it('tem ids únicos', () => {
    const ids = FONTES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(FONTES.flatMap((f) => f.sementes.map((s) => [f.id, s] as const)))(
    '%s: semente %s está na lista oficial',
    (_id, semente) => {
      expect(verificarOrigem(semente).permitido).toBe(true);
    },
  );

  it('toda fonte tem semente e SLA positivo', () => {
    for (const f of FONTES) {
      expect(f.sementes.length).toBeGreaterThan(0);
      expect(f.slaHoras).toBeGreaterThan(0);
      expect(f.frequenciaHoras).toBeLessThanOrEqual(f.slaHoras);
    }
  });
});
