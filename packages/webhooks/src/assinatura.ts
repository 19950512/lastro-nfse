import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CABECALHO_ASSINATURA = 'lastro-assinatura';

export function gerarSegredo(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Assinatura HMAC-SHA256 de `t.corpo` (SEGURANCA.md §9).
 *
 * why: o timestamp entra no conteúdo assinado para o receptor recusar reenvio de uma mensagem antiga
 * capturada (replay), comparando `t` com o relógio dele.
 */
export function assinar(segredo: string, corpo: string, instante: Date): string {
  const t = Math.floor(instante.getTime() / 1000);
  const v1 = createHmac('sha256', segredo).update(`${String(t)}.${corpo}`).digest('hex');
  return `t=${String(t)},v1=${v1}`;
}

// why: referência para o receptor implementar a verificação; a comparação em tempo constante evita vazar o HMAC por tempo de resposta.
export function verificarAssinatura(
  segredo: string,
  corpo: string,
  cabecalho: string,
  agora: Date,
  toleranciaSegundos = 300,
): boolean {
  const partes = new Map(cabecalho.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(partes.get('t'));
  const recebido = partes.get('v1');
  if (!Number.isInteger(t) || recebido === undefined || !/^[0-9a-f]{64}$/.test(recebido)) return false;
  if (Math.abs(agora.getTime() / 1000 - t) > toleranciaSegundos) return false;
  const esperado = createHmac('sha256', segredo).update(`${String(t)}.${corpo}`).digest();
  return timingSafeEqual(esperado, Buffer.from(recebido, 'hex'));
}
