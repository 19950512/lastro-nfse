import { describe, expect, it } from 'vitest';
import { FONTES, fontesMunicipais } from './fontes.ts';
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

  it('fonte municipal tem código IBGE coerente com a UF, id próprio e nível N1', () => {
    const municipais = fontesMunicipais();
    expect(municipais.length).toBeGreaterThan(0);
    const codigosUf: Record<string, string> = { SP: '35', RJ: '33', MG: '31', DF: '53' };
    for (const f of municipais) {
      const m = f.municipio;
      expect(m?.codigoIbge).toMatch(/^\d{7}$/);
      expect(f.id).toBe(`municipio-${m?.codigoIbge ?? ''}-legislacao`);
      expect(f.nivel).toBe('N1');
      expect(m?.codigoIbge.slice(0, 2)).toBe(codigosUf[m?.uf ?? '']);
    }
  });

  it('toda fonte tem semente e SLA positivo', () => {
    for (const f of FONTES) {
      expect(f.sementes.length).toBeGreaterThan(0);
      expect(f.slaHoras).toBeGreaterThan(0);
      expect(f.frequenciaHoras).toBeLessThanOrEqual(f.slaHoras);
    }
  });
});
