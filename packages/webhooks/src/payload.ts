import type { TipoEvento } from '@lastro/ingest';

export type FormatoWebhook = 'lastro' | 'slack';

export interface EventoParaEnvio {
  readonly id: string;
  readonly tipo: TipoEvento;
  readonly fonteId: string;
  readonly documentoId: string;
  readonly url: string;
  readonly detectadoEm: string;
  readonly anomalia: string | null;
  /** invariant: só nos eventos de curadoria (`fato-aprovado`, `fato-corrigido`). */
  readonly fatoId?: string | null | undefined;
  /** why: alerta por tema do cliente; o nome escolhido por ele identifica o alerta na mensagem. */
  readonly alerta?: { readonly id: string; readonly nome: string } | null | undefined;
}

const ROTULOS: Record<TipoEvento, string> = {
  'documento-novo': 'Documento novo',
  'nova-versao': 'Nova versão',
  'link-removido': 'Link removido',
  'documento-indisponivel': 'Documento indisponível',
  'documento-restabelecido': 'Documento restabelecido',
  'fato-aprovado': 'Fato aprovado pela curadoria',
  'fato-corrigido': 'Fato corrigido pela curadoria (recall)',
};

// why: no mrkdwn do Slack, &, < e > abrem links e menções; texto vindo das fontes precisa ir escapado.
function escaparSlack(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Corpo enviado ao assinante.
 *
 * why: conteúdo mínimo (SEGURANCA.md §9): identificação do evento e links. O detalhe é buscado na API,
 * então um webhook vazado ou interceptado não carrega mais do que o próprio feed público.
 */
export function montarCorpo(evento: EventoParaEnvio, formato: FormatoWebhook, urlPublicaApi: string): string {
  let base = urlPublicaApi;
  // why: laço em vez de /\/+$/, que é quadrático numa sequência longa de barras (alerta js/polynomial-redos).
  while (base.endsWith('/')) base = base.slice(0, -1);
  const linkDocumento = `${base}/v1/documentos/${evento.documentoId}`;
  const fatoId = evento.fatoId ?? null;
  const linkFato = fatoId === null ? null : `${base}/v1/fatos/${fatoId}`;
  const alerta = evento.alerta ?? null;
  if (formato === 'slack') {
    const revisao = evento.anomalia === null ? '' : ' (marcado para revisão)';
    const prefixo = alerta === null ? '' : `[${escaparSlack(alerta.nome)}] `;
    return JSON.stringify({
      text: `${prefixo}${ROTULOS[evento.tipo]}${revisao} em ${escaparSlack(evento.fonteId)}: ${escaparSlack(evento.url)}\nDetalhes: ${linkFato ?? linkDocumento}`,
    });
  }
  return JSON.stringify({
    id: evento.id,
    tipo: evento.tipo,
    fonte_id: evento.fonteId,
    detectado_em: evento.detectadoEm,
    revisao_pendente: evento.anomalia !== null,
    ...(fatoId === null ? {} : { fato_id: fatoId }),
    ...(alerta === null ? {} : { alerta: { id: alerta.id, nome: alerta.nome } }),
    links: {
      documento: linkDocumento,
      mudancas: `${base}/v1/mudancas?desde=${encodeURIComponent(evento.detectadoEm)}`,
      ...(linkFato === null ? {} : { fato: linkFato }),
    },
  });
}
