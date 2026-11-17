import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RespostaPergunta, ResultadoVerificacao } from '@lastro/llm';

// why: o Slack recomenda recusar pedidos com mais de 5 minutos (proteção contra reenvio de pedido capturado).
export const TOLERANCIA_SLACK_S = 300;
const MAX_TEXTO_SLACK = 3500;

/** invariant: verificação v0 do Slack: HMAC-SHA256 de `v0:<timestamp>:<corpo bruto>`, comparado em tempo constante. */
export function verificarAssinaturaSlack(segredo: string, timestamp: string, corpo: string, assinatura: string, agora: Date): boolean {
  if (!/^\d{1,12}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/.test(assinatura)) return false;
  if (Math.abs(agora.getTime() / 1000 - Number(timestamp)) > TOLERANCIA_SLACK_S) return false;
  const esperada = `v0=${createHmac('sha256', segredo).update(`v0:${timestamp}:${corpo}`).digest('hex')}`;
  return timingSafeEqual(Buffer.from(esperada), Buffer.from(assinatura));
}

/** hazard: o servidor só posta na URL de resposta do próprio Slack; qualquer outra seria SSRF a pedido de quem forjou o corpo. */
export function urlRespostaValida(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com' && u.port === '' && u.username === '' && u.pathname.startsWith('/commands/');
  } catch {
    return false;
  }
}

// why: no mrkdwn do Slack, &, < e > abrem links e menções (<!channel>); texto do modelo e das fontes vai escapado.
export function escaparSlack(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function link(url: string, rotulo: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return escaparSlack(rotulo);
  }
  if (u.protocol !== 'https:') return escaparSlack(rotulo);
  const seguro = u.toString().replace(/\|/g, '%7C').replace(/</g, '%3C').replace(/>/g, '%3E');
  return `<${seguro}|${escaparSlack(rotulo).replace(/\|/g, '¦')}>`;
}

const formatoData = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });
const data = (iso: string): string => formatoData.format(new Date(iso.length === 10 ? `${iso}T12:00:00-03:00` : iso));

function limitar(texto: string): string {
  return texto.length <= MAX_TEXTO_SLACK ? texto : `${texto.slice(0, MAX_TEXTO_SLACK - 1)}…`;
}

export type Comando = { readonly tipo: 'ajuda' } | { readonly tipo: 'pergunta'; readonly texto: string } | { readonly tipo: 'verificacao'; readonly texto: string };

export function interpretarComando(texto: string): Comando {
  const limpo = texto.trim();
  if (limpo === '' || /^(ajuda|help)$/i.test(limpo)) return { tipo: 'ajuda' };
  const m = /^(checar|verificar)\s+([\s\S]+)$/i.exec(limpo);
  if (m?.[2] !== undefined) return { tipo: 'verificacao', texto: m[2].trim() };
  return { tipo: 'pergunta', texto: limpo };
}

export const AJUDA_SLACK = [
  '*Lastro* — NFS-e e reforma tributária só com fonte oficial.',
  '• `/lastro <pergunta>`: resposta com citação de cada fonte oficial.',
  '• `/lastro checar <texto>`: verifica as alegações de um post ou mensagem e gera um link público do resultado.',
  'As respostas aparecem só para você. ISS: só alíquotas do Portal NFS-e, LC 116/2003 e legislação dos municípios coletados; não substitui orientação profissional.',
].join('\n');

export function mensagemResposta(r: RespostaPergunta): string {
  const fontes = r.fontes.map((f) => `${String(f.id)}. ${link(f.url, f.titulo)} — ${escaparSlack(f.orgao)} (${f.nivel})${f.secao === null ? '' : ` · ${escaparSlack(f.secao)}`} · coletado em ${data(f.coletado_em)}`);
  return limitar(
    [
      `*Resposta* (posição em ${data(r.posicao_em)})`,
      escaparSlack(r.resposta),
      ...r.avisos.map((a) => `:warning: ${escaparSlack(a)}`),
      ...(fontes.length === 0 ? [] : ['', '*Fontes oficiais*', ...fontes]),
      '',
      `_${escaparSlack(r.aviso)}_`,
    ].join('\n'),
  );
}

export function mensagemVerificacao(r: ResultadoVerificacao, linkPublico: string | null): string {
  const alegacoes = r.alegacoes.map((a) => `*${escaparSlack(a.rotulo)}* — ${escaparSlack(a.alegacao)}\n${escaparSlack(a.explicacao)}`);
  return limitar(
    [
      `*Verificação* (posição em ${data(r.posicao_em)})`,
      ...(alegacoes.length === 0 ? ['Nenhuma alegação verificável encontrada.'] : alegacoes),
      ...(linkPublico === null ? [] : ['', `Resultado completo, com os trechos oficiais: ${link(linkPublico, 'abrir verificação')}`]),
      '',
      `_${escaparSlack(r.aviso)}_`,
    ].join('\n'),
  );
}
