import { describe, expect, it } from 'vitest';
import { prefixoCodigoServico } from './iss.ts';

describe('prefixoCodigoServico', () => {
  it.each([
    ['1.05', '01.05.'],
    ['01.05', '01.05.'],
    ['16.01', '16.01.'],
    ['010501', '01.05.01.'],
    ['01.05.01', '01.05.01.'],
    ['01.05.01.000', '01.05.01.000'],
    [' 7.02 ', '07.02.'],
  ])('%j → %j', (entrada, esperado) => {
    expect(prefixoCodigoServico(entrada)).toBe(esperado);
  });

  it.each(['2026', '3550308', '0.05', '00.01.01.000', '12.345.678/0001-90', '1.5', 'abc', '01.05%', '01_05'])('recusa %j', (entrada) => {
    expect(prefixoCodigoServico(entrada)).toBeNull();
  });
});
