export const UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB',
  'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
] as const;

/**
 * Prefixo do código de serviço da tabela de alíquotas (formato `01.05.01.000`) a partir do que a pessoa escreve:
 * subitem da LC 116 ("1.05" → "01.05."), código de tributação nacional ("010501" ou "01.05.01" → "01.05.01.")
 * ou o código completo. Devolve null para o que não é código de serviço (ano, código IBGE, CNPJ…).
 *
 * invariant: a saída tem só dígitos e pontos, e entra num LIKE como prefixo.
 */
export function prefixoCodigoServico(entrada: string): string | null {
  const s = entrada.trim();
  const subitem = /^(\d{1,2})\.(\d{2})$/.exec(s);
  if (subitem !== null) {
    const item = Number(subitem[1]);
    return item >= 1 ? `${String(item).padStart(2, '0')}.${subitem[2] ?? ''}.` : null;
  }
  const nacional = /^(\d{2})\.?(\d{2})\.?(\d{2})$/.exec(s);
  if (nacional !== null && Number(nacional[1]) >= 1) return `${nacional[1] ?? ''}.${nacional[2] ?? ''}.${nacional[3] ?? ''}.`;
  if (/^\d{2}\.\d{2}\.\d{2}\.\d{3}$/.test(s) && Number(s.slice(0, 2)) >= 1) return s;
  return null;
}
