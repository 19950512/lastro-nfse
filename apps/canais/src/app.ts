import { LimitadorTaxa } from '@lastro/core';
import { ErroCota, ErroModelo, type ServicoPerguntas, type ServicoVerificacoes } from '@lastro/llm';
import Fastify, { type FastifyInstance } from 'fastify';
import { AJUDA_SLACK, interpretarComando, mensagemResposta, mensagemVerificacao, urlRespostaValida, verificarAssinaturaSlack } from './slack.ts';

/** Envia a mensagem final para a `response_url` do Slack. */
export type ResponderSlack = (url: string, corpo: { response_type: 'ephemeral'; text: string }) => Promise<void>;

export interface DependenciasCanais {
  readonly perguntas: ServicoPerguntas;
  readonly verificacoes: ServicoVerificacoes;
  /** Cliente vinculado ao workspace (`canal_slack`); undefined = workspace não autorizado. */
  clienteDoSlack(teamId: string): Promise<string | undefined>;
  /** Signing secret do app do Slack. */
  readonly segredoSlack: string;
  readonly responder: ResponderSlack;
  /** Origem pública da API, onde fica a página canônica da verificação compartilhada. */
  readonly urlPublicaApi: string;
  readonly agora?: () => Date;
}

export interface OpcoesCanais {
  readonly logger?: boolean;
  /** Consultas ao modelo por usuário do Slack por hora. Padrão 20. */
  readonly limitePorHoraUsuario?: number;
  /** Comandos por workspace por minuto. Padrão 60. */
  readonly limitePorMinutoWorkspace?: number;
}

const TEAM = /^T[A-Z0-9]{2,30}$/;
const USUARIO = /^[UW][A-Z0-9]{2,30}$/;

export function respostaPadraoSlack(): (url: string, corpo: object) => Promise<void> {
  return async (url, corpo) => {
    if (!urlRespostaValida(url)) throw new Error('response_url fora do Slack');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Slack respondeu HTTP ${String(r.status)}`);
  };
}

/**
 * why: canais de conversa da Fase 4. Hoje só o Slack (comando `/lastro`); WhatsApp e Teams dependem de conta nos
 * provedores e entram como rotas novas aqui, com a mesma regra: autenticidade conferida antes de qualquer custo.
 *
 * invariant: o corpo só é lido depois de a assinatura do Slack bater; workspace sem vínculo ativo não chega ao
 * modelo; a resposta final vai só para a response_url do próprio Slack. O texto do usuário não vai para log.
 */
export function construirCanais(deps: DependenciasCanais, opcoes: OpcoesCanais = {}): FastifyInstance {
  const app = Fastify({
    logger:
      opcoes.logger === true
        ? { serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] ?? '' }) } }
        : false,
    trustProxy: false,
    bodyLimit: 16_384,
    return503OnClosing: true,
  });
  const agora = deps.agora ?? (() => new Date());
  const limitador = new LimitadorTaxa();
  const porHora = opcoes.limitePorHoraUsuario ?? 20;
  const porMinuto = opcoes.limitePorMinutoWorkspace ?? 60;
  const emAndamento = new Set<Promise<void>>();
  let urlApi = deps.urlPublicaApi;
  // why: laço em vez de /\/+$/, que é quadrático numa sequência longa de barras (alerta js/polynomial-redos).
  while (urlApi.endsWith('/')) urlApi = urlApi.slice(0, -1);

  app.removeAllContentTypeParsers();
  // why: a assinatura do Slack é sobre o corpo bruto; o parser entrega o texto como veio.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, corpo, feito) => {
    feito(null, typeof corpo === 'string' ? corpo : corpo.toString('utf8'));
  });

  app.addHook('onSend', async (_req, resposta) => {
    resposta.header('x-content-type-options', 'nosniff');
    resposta.header('cache-control', 'no-store');
    resposta.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  });

  app.addHook('onClose', async () => {
    // invariant: ao desligar, espera as respostas em voo; quem perguntou não fica sem retorno por causa do deploy.
    await Promise.allSettled([...emAndamento]);
  });

  app.setErrorHandler((erro, req, resposta) => {
    const status = (erro as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) return resposta.status(status).send({ erro: 'requisicao-invalida' });
    req.log.error(erro);
    return resposta.status(500).send({ erro: 'interno' });
  });

  app.get('/saude', () => ({ situacao: 'ok' }));

  const efemera = (text: string) => ({ response_type: 'ephemeral' as const, text });

  app.post('/slack/comandos', async (req, resposta) => {
    const bruto = typeof req.body === 'string' ? req.body : '';
    const timestamp = String(req.headers['x-slack-request-timestamp'] ?? '');
    const assinatura = String(req.headers['x-slack-signature'] ?? '');
    if (!verificarAssinaturaSlack(deps.segredoSlack, timestamp, bruto, assinatura, agora())) {
      req.log.warn({ evento: 'slack-assinatura-invalida', ip: req.ip }, 'assinatura do Slack recusada');
      return resposta.status(401).send({ erro: 'assinatura-invalida' });
    }
    // why: o Slack reenvia quando não recebe 200 em 3 s; o reenvio não pode gastar o modelo de novo.
    if (req.headers['x-slack-retry-num'] !== undefined) return resposta.status(200).send();
    const campos = new URLSearchParams(bruto);
    if (campos.get('ssl_check') === '1') return resposta.status(200).send();

    const team = campos.get('team_id') ?? '';
    const usuario = campos.get('user_id') ?? '';
    const urlResposta = campos.get('response_url') ?? '';
    if (!TEAM.test(team) || !USUARIO.test(usuario) || !urlRespostaValida(urlResposta)) return resposta.status(400).send({ erro: 'requisicao-invalida' });

    const comando = interpretarComando(campos.get('text') ?? '');
    if (comando.tipo === 'ajuda') return efemera(AJUDA_SLACK);

    const clienteId = await deps.clienteDoSlack(team);
    if (clienteId === undefined) {
      req.log.warn({ evento: 'slack-workspace-sem-vinculo', team }, 'workspace sem vínculo');
      return efemera('Este workspace do Slack não está vinculado a uma conta do Lastro. Fale com quem administra a conta.');
    }
    const momento = agora().getTime();
    if (!limitador.consumir(`team:${team}`, porMinuto, momento).permitido) return efemera('Muitos comandos neste workspace agora. Tente de novo em um minuto.');
    if (!limitador.consumir(`usuario:${team}:${usuario}`, porHora, momento, 3_600_000).permitido) {
      return efemera(`Você já fez ${String(porHora)} consultas na última hora. Tente de novo mais tarde.`);
    }
    if (comando.texto.length < 3 || comando.texto.length > (comando.tipo === 'pergunta' ? 1000 : 5000)) {
      return efemera(comando.tipo === 'pergunta' ? 'A pergunta precisa ter de 3 a 1000 caracteres.' : 'O texto a checar precisa ter de 3 a 5000 caracteres.');
    }

    const solicitante = { clienteId, chaveId: null, canal: 'slack' as const };
    const trabalho = (async () => {
      let texto: string;
      try {
        if (comando.tipo === 'pergunta') {
          texto = mensagemResposta((await deps.perguntas.responder(solicitante, comando.texto)).resposta);
        } else {
          const v = await deps.verificacoes.verificar(solicitante, comando.texto);
          const token = await deps.verificacoes.compartilhar(clienteId, v.id);
          texto = mensagemVerificacao(v.resultado, token === undefined ? null : `${urlApi}/verificacoes/${token}`);
        }
      } catch (erro) {
        if (erro instanceof ErroCota) texto = 'A cota do plano desta conta acabou (ou o limite diário de uso foi atingido). Tente de novo mais tarde.';
        else if (erro instanceof ErroModelo) texto = 'O serviço de respostas está indisponível no momento. Tente de novo em instantes.';
        else {
          req.log.error(erro);
          texto = 'Não foi possível responder agora.';
        }
      }
      await deps.responder(urlResposta, efemera(texto));
    })().catch((erro: unknown) => {
      req.log.error({ evento: 'slack-resposta-falhou', erro: erro instanceof Error ? erro.message : 'erro' }, 'resposta ao Slack não entregue');
    });
    emAndamento.add(trabalho);
    void trabalho.finally(() => emAndamento.delete(trabalho));
    return efemera(comando.tipo === 'pergunta' ? 'Consultando as fontes oficiais…' : 'Verificando as alegações nas fontes oficiais…');
  });

  return app;
}
