import { hrefSeguro, html, LimitadorTaxa, montarSecurityTxt, type ConfigSecurityTxt, type Html } from '@lastro/core';
import { ErroCota, ErroModelo, type RespostaPergunta, type ServicoPerguntas, type ServicoVerificacoes } from '@lastro/llm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { Captcha } from './captcha.ts';

export interface DependenciasPortal {
  readonly perguntas: ServicoPerguntas;
  readonly verificacoes: ServicoVerificacoes;
  /** Cliente da plataforma em nome do qual o portal anônimo pergunta (plano `portal-publico`). */
  readonly clienteId: string;
  readonly captcha: Captcha;
  /** Origem pública do portal (ex.: https://lastro.example); conferida no Origin de todo POST. */
  readonly origem: string;
  /** Origem pública da API, onde fica a página canônica da verificação compartilhada. */
  readonly urlPublicaApi: string;
  readonly agora?: () => Date;
}

export interface OpcoesPortal {
  readonly logger?: boolean;
  /** Perguntas e verificações por IP por hora (cada uma chama o modelo). Padrão 10. */
  readonly limiteLlmPorHoraIp?: number;
  /** Requisições por IP por minuto, em qualquer página. Padrão 60. */
  readonly limitePorMinutoIp?: number;
  /** IPs ou faixas CIDR do proxy reverso cujo X-Forwarded-For é confiável; sem isso, o IP é o da conexão. */
  readonly proxyConfiavel?: readonly string[];
  readonly securityTxt?: ConfigSecurityTxt | undefined;
}

const PedidoPergunta = z.object({ pergunta: z.string().trim().min(3).max(1000) });
const PedidoVerificacao = z.object({
  texto: z.string().trim().min(10).max(5000),
  data_conteudo: z.preprocess((v) => (v === '' ? undefined : v), z.iso.date().optional()),
});

const formatoData = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });
const data = (iso: string): string => formatoData.format(new Date(iso.length === 10 ? `${iso}T12:00:00-03:00` : iso));

export const ESTILO_PORTAL = `
:root { --fundo:#f7f7f5; --texto:#1d1d1b; --suave:#5f5f5a; --linha:#deded8; --cartao:#ffffff; --alerta:#9a3412; --alerta-fundo:#fff1e6; --link:#1d4ed8; --botao:#1d4ed8; --botao-texto:#ffffff; }
@media (prefers-color-scheme: dark) { :root { --fundo:#161615; --texto:#ecece8; --suave:#a3a39c; --linha:#33332f; --cartao:#1f1f1d; --alerta:#fdba74; --alerta-fundo:#3b2414; --link:#93c5fd; --botao:#93c5fd; --botao-texto:#161615; } }
html { box-sizing:border-box; } *, *::before, *::after { box-sizing:inherit; }
body { margin:0; background:var(--fundo); color:var(--texto); font:16px/1.55 system-ui, sans-serif; }
main { max-width:860px; margin:0 auto; padding:24px 16px 64px; }
nav { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:24px; font-weight:600; }
h1 { font-size:1.4rem; margin:0 0 4px; } h2 { font-size:1.1rem; margin:24px 0 8px; }
p.sub, .meta { color:var(--suave); font-size:.9rem; }
a { color:var(--link); overflow-wrap:anywhere; }
form { background:var(--cartao); border:1px solid var(--linha); border-radius:8px; padding:16px; }
label { display:block; font-weight:600; margin:8px 0 4px; }
textarea, input[type=date] { width:100%; font:inherit; padding:8px; background:var(--fundo); color:var(--texto); border:1px solid var(--linha); border-radius:4px; }
textarea { min-height:7em; resize:vertical; }
button { font:inherit; font-weight:600; padding:8px 18px; margin-top:12px; border:0; border-radius:6px; background:var(--botao); color:var(--botao-texto); cursor:pointer; }
.resposta { background:var(--cartao); border:1px solid var(--linha); border-radius:8px; padding:16px; white-space:pre-wrap; }
.aviso { border:1px solid var(--alerta); background:var(--alerta-fundo); color:var(--alerta); border-radius:8px; padding:12px 16px; margin:16px 0; }
blockquote { margin:8px 0; padding:4px 12px; border-left:3px solid var(--linha); }
ol { padding-left:20px; }
footer { margin-top:40px; border-top:1px solid var(--linha); padding-top:12px; }
`;

// why: único script próprio do portal. Preenche o texto vindo da extensão pelo fragmento (#texto=…), que não vai ao
// servidor nem aparece em log; depois apaga o fragmento da barra de endereço.
export const SCRIPT_PORTAL = `(() => {
  const campo = document.getElementById('texto');
  const m = /^#texto=([\\s\\S]*)$/.exec(location.hash);
  if (!(campo instanceof HTMLTextAreaElement) || m === null) return;
  try { campo.value = decodeURIComponent(m[1]).slice(0, 5000); } catch { return; }
  history.replaceState(null, '', location.pathname + location.search);
})();
`;

class ErroPagina extends Error {
  readonly status: number;
  readonly titulo: string;
  constructor(status: number, titulo: string, mensagem: string) {
    super(mensagem);
    this.status = status;
    this.titulo = titulo;
  }
}

function montarCsp(captcha: Captcha): string {
  const junto = (base: string, extras: readonly string[]) => [base, ...extras].join(' ');
  return [
    "default-src 'none'",
    junto("script-src 'self'", captcha.csp.script),
    junto("style-src 'self'", captcha.csp.style),
    ...(captcha.csp.frame.length === 0 ? [] : [`frame-src ${captcha.csp.frame.join(' ')}`]),
    ...(captcha.csp.connect.length === 0 ? [] : [`connect-src ${captcha.csp.connect.join(' ')}`]),
    "img-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * why: portal público anônimo da Fase 4 (perguntas e verificações), em processo e origem próprios, separado do painel
 * de curadoria e da API B2B (SEGURANCA.md §4).
 *
 * invariant: o que chama o modelo passa, nesta ordem, por limite por IP, Origin, CAPTCHA confirmado no servidor e
 * limite por IP por hora; depois valem a cota e o orçamento do cliente do portal e o disjuntor global de gasto
 * (SEGURANCA.md §11). Texto do usuário não vai para log; a resposta só aparece na própria página.
 */
export function construirPortal(deps: DependenciasPortal, opcoes: OpcoesPortal = {}): FastifyInstance {
  const proxy = opcoes.proxyConfiavel ?? [];
  const app = Fastify({
    logger:
      opcoes.logger === true
        ? {
            redact: ['req.headers.cookie', 'req.headers.authorization'],
            serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] ?? '' }) },
          }
        : false,
    trustProxy: proxy.length === 0 ? false : [...proxy],
    bodyLimit: 16_384,
    requestTimeout: 150_000,
    return503OnClosing: true,
  });
  const agora = deps.agora ?? (() => new Date());
  const limitador = new LimitadorTaxa();
  const limiteMinuto = opcoes.limitePorMinutoIp ?? 60;
  const limiteHora = opcoes.limiteLlmPorHoraIp ?? 10;
  const csp = montarCsp(deps.captcha);
  let urlApi = deps.urlPublicaApi;
  // why: laço em vez de /\/+$/, que é quadrático numa sequência longa de barras (alerta js/polynomial-redos).
  while (urlApi.endsWith('/')) urlApi = urlApi.slice(0, -1);

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, corpo, feito) => {
    feito(null, Object.fromEntries(new URLSearchParams(typeof corpo === 'string' ? corpo : corpo.toString('utf8'))));
  });

  function pagina(titulo: string, corpo: Html, comCaptcha = false): Html {
    const script = comCaptcha && deps.captcha.script !== null ? html`<script src="${deps.captcha.script}" async defer></script>` : '';
    return html`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo} · Lastro</title><link rel="stylesheet" href="/estilo.css"><script src="/portal.js" defer></script>${script}</head>
<body><main>
<nav><a href="/">Perguntar</a><a href="/verificar">Isso é verdade?</a></nav>
${corpo}
<footer class="meta">Respostas montadas só com documentos de órgãos oficiais (Receita Federal, CGIBS, Comitê Gestor da NFS-e, Planalto), com link e data de coleta de cada fonte. Não cobre ISS municipal. Não substitui orientação profissional.</footer>
</main></body></html>`;
  }

  function widget(): Html {
    return deps.captcha.provedor === 'desligado' ? html`` : html`<div class="${deps.captcha.classe}" data-sitekey="${deps.captcha.chaveSite}"></div>`;
  }

  function enviar(resposta: FastifyReply, conteudo: Html, status = 200): FastifyReply {
    return resposta.status(status).header('content-type', 'text/html; charset=utf-8').send(conteudo.valor);
  }

  app.addHook('onRequest', async (req, resposta) => {
    const porIp = limitador.consumir(`ip:${req.ip}`, limiteMinuto, agora().getTime());
    if (!porIp.permitido) {
      return enviar(resposta.header('retry-after', String(porIp.tenteEmSegundos)), pagina('Muitas requisições', html`<h1>Muitas requisições</h1><p>Aguarde um pouco e tente de novo.</p>`), 429);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // hazard: o portal não tem sessão, mas um site de terceiros poderia gastar a cota do portal pelo navegador da vítima; Origin barra isso.
      const origem = req.headers.origin;
      // hazard: com Referrer-Policy no-referrer o navegador manda "Origin: null" até no POST da própria página; aí decide o
      // Sec-Fetch-Site, que a página não forja. Site atacante com no-referrer também manda null, mas chega como cross-site.
      const mesmoSite = origem === deps.origem || ((origem === undefined || origem === 'null') && req.headers['sec-fetch-site'] === 'same-origin');
      if (!mesmoSite) {
        req.log.warn({ evento: 'origem-recusada', ip: req.ip }, 'POST de outra origem recusado');
        return enviar(resposta, pagina('Recusado', html`<h1>Requisição recusada</h1>`), 403);
      }
    }
  });

  app.addHook('onSend', async (_req, resposta) => {
    if (resposta.getHeader('content-security-policy') === undefined) resposta.header('content-security-policy', csp);
    resposta.header('x-content-type-options', 'nosniff');
    resposta.header('referrer-policy', 'no-referrer');
    resposta.header('x-frame-options', 'DENY');
    resposta.header('cross-origin-opener-policy', 'same-origin');
    resposta.header('cross-origin-resource-policy', 'same-origin');
    resposta.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    resposta.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    if (resposta.getHeader('cache-control') === undefined) resposta.header('cache-control', 'no-store');
  });

  app.setErrorHandler((erro, req, resposta) => {
    if (erro instanceof ZodError) {
      return enviar(resposta, pagina('Dados inválidos', html`<h1>Confira o que foi enviado</h1><ul>${erro.issues.map((i) => html`<li>${i.path.join('.') || 'formulário'}: ${i.message}</li>`)}</ul><p><a href="/">Voltar</a></p>`), 400);
    }
    if (erro instanceof ErroPagina) return enviar(resposta, pagina(erro.titulo, html`<h1>${erro.titulo}</h1><p>${erro.message}</p>`), erro.status);
    if (erro instanceof ErroCota || erro instanceof ErroModelo) {
      req.log.warn({ evento: erro instanceof ErroCota ? 'cota' : 'llm-indisponivel', motivo: erro instanceof ErroCota ? erro.motivo : undefined }, 'portal sem capacidade');
      return enviar(
        resposta.header('retry-after', '3600'),
        pagina('Indisponível', html`<h1>Limite de uso do portal atingido</h1><p>O portal gratuito atingiu o limite de consultas por enquanto. Tente de novo mais tarde.</p>`),
        503,
      );
    }
    const status = (erro as { statusCode?: number }).statusCode;
    if (status === 413) return enviar(resposta, pagina('Texto longo demais', html`<h1>Texto longo demais</h1>`), 413);
    if (status !== undefined && status >= 400 && status < 500) return enviar(resposta, pagina('Requisição inválida', html`<h1>Requisição inválida</h1>`), status);
    // hazard: nunca devolver mensagem ou pilha do erro interno (SEGURANCA.md A10).
    req.log.error(erro);
    return enviar(resposta, pagina('Erro', html`<h1>Erro interno</h1><p>Tente de novo em instantes.</p>`), 500);
  });

  app.setNotFoundHandler((_req, resposta) => enviar(resposta, pagina('Não encontrado', html`<h1>Página não encontrada</h1>`), 404));

  async function conferirLlm(req: FastifyRequest, corpo: Record<string, unknown>): Promise<void> {
    const token = corpo[deps.captcha.campo];
    if (!(await deps.captcha.verificar(typeof token === 'string' ? token : '', req.ip))) {
      req.log.warn({ evento: 'captcha-recusado', ip: req.ip }, 'CAPTCHA não confirmado');
      throw new ErroPagina(400, 'Confirmação necessária', 'Não foi possível confirmar que o envio veio de uma pessoa. Volte, marque a confirmação e envie de novo.');
    }
    // invariant: só conta no limite por hora o pedido que passou do CAPTCHA; robô barrado antes não consome a cota de quem divide o IP.
    const porHora = limitador.consumir(`llm:${req.ip}`, limiteHora, agora().getTime(), 3_600_000);
    if (!porHora.permitido) throw new ErroPagina(429, 'Limite por hora atingido', `Este endereço já fez ${String(limiteHora)} consultas na última hora. Tente de novo mais tarde.`);
  }

  app.get('/estilo.css', (_req, resposta) => resposta.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'public, max-age=3600').send(ESTILO_PORTAL));
  app.get('/portal.js', (_req, resposta) =>
    resposta.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'public, max-age=3600').send(SCRIPT_PORTAL),
  );
  app.get('/saude', () => ({ situacao: 'ok' }));

  app.get('/.well-known/security.txt', (_req, resposta) => {
    const conteudo = opcoes.securityTxt === undefined ? undefined : montarSecurityTxt(opcoes.securityTxt, agora());
    if (conteudo === undefined) return enviar(resposta, pagina('Não encontrado', html`<h1>Não encontrado</h1>`), 404);
    return resposta.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400').send(conteudo);
  });

  app.get('/', (_req, resposta) =>
    enviar(
      resposta,
      pagina(
        'Perguntar sobre NFS-e',
        html`<h1>NFS-e e reforma tributária com fonte oficial</h1>
<p class="sub">Pergunte sobre NFS-e, IBS e CBS. Cada frase da resposta cita o documento oficial de onde saiu; se não houver fonte oficial, a resposta diz que não encontrou.</p>
<form method="post" action="/perguntar">
<label for="pergunta">Sua pergunta</label>
<textarea id="pergunta" name="pergunta" required minlength="3" maxlength="1000" placeholder="Ex.: Quando o grupo IBS/CBS passa a ser obrigatório na NFS-e?"></textarea>
<p class="meta">Não inclua CPF, CNPJ, nomes ou dados de clientes.</p>
${widget()}
<button type="submit">Perguntar</button>
</form>`,
        true,
      ),
    ),
  );

  app.get('/verificar', (_req, resposta) =>
    enviar(
      resposta,
      pagina(
        'Isso é verdade?',
        html`<h1>Isso é verdade?</h1>
<p class="sub">Cole um post, mensagem ou notícia sobre NFS-e e reforma tributária. Cada alegação recebe um veredito com o trecho oficial que o sustenta.</p>
<form method="post" action="/verificar">
<label for="texto">Texto a verificar</label>
<textarea id="texto" name="texto" required minlength="10" maxlength="5000"></textarea>
<label for="data_conteudo">Data do post (opcional)</label>
<input id="data_conteudo" type="date" name="data_conteudo">
<p class="meta">O resultado vira uma página pública com link próprio (sem o texto que você colou), para você compartilhar. CPF, CNPJ, e-mail e telefone são mascarados antes da análise.</p>
${widget()}
<button type="submit">Verificar</button>
</form>`,
        true,
      ),
    ),
  );

  function respostaHtml(r: RespostaPergunta): Html {
    // why: o marcador [n] vira link para a fonte n; o resto do texto continua escapado pelo template.
    const partes = r.resposta.split(/(\[\d{1,3}\])/);
    const ids = new Set(r.fontes.map((f) => f.id));
    return html`${partes.map((p) => {
      const n = /^\[(\d{1,3})\]$/.exec(p)?.[1];
      return n !== undefined && ids.has(Number(n)) ? html`<a href="#fonte-${n}">[${n}]</a>` : p;
    })}`;
  }

  app.post('/perguntar', async (req, resposta) => {
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const { pergunta } = PedidoPergunta.parse(corpo);
    await conferirLlm(req, corpo);
    const { resposta: r } = await deps.perguntas.responder({ clienteId: deps.clienteId, chaveId: null, canal: 'portal' }, pergunta);
    return enviar(
      resposta,
      pagina(
        'Resposta',
        html`<h1>Resposta</h1>
<p class="sub">Posição em ${data(r.posicao_em)} · somente fontes oficiais</p>
<blockquote>${pergunta}</blockquote>
<div class="resposta">${respostaHtml(r)}</div>
${r.avisos.map((a) => html`<p class="aviso">${a}</p>`)}
${
  r.fontes.length === 0
    ? ''
    : html`<h2>Fontes</h2><ol>${r.fontes.map(
        (f) => html`<li id="fonte-${f.id}"><a href="${hrefSeguro(f.url)}" rel="noopener noreferrer">${f.titulo}</a> — ${f.orgao} (${f.nivel})${f.secao === null ? '' : html` · ${f.secao}`}${f.pagina === null ? '' : html` · p. ${f.pagina}`}<br>
<blockquote>“${f.trecho}”</blockquote><span class="meta">coletado em ${data(f.coletado_em)} · SHA-256 ${f.sha256.slice(0, 12)}…</span></li>`,
      )}</ol>`
}
<p class="meta">${r.aviso} ${r.limites.join(' ')}</p>
<p><a href="/">Fazer outra pergunta</a></p>`,
      ),
    );
  });

  app.post('/verificar', async (req, resposta) => {
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const pedido = PedidoVerificacao.parse(corpo);
    await conferirLlm(req, corpo);
    const v = await deps.verificacoes.verificar({ clienteId: deps.clienteId, chaveId: null, canal: 'portal' }, pedido.texto, { dataConteudo: pedido.data_conteudo });
    const token = await deps.verificacoes.compartilhar(deps.clienteId, v.id);
    if (token === undefined) throw new Error('verificação recém-criada sem link');
    // invariant: o resultado mora numa página só (a canônica da API); o portal não guarda nem mostra outra cópia.
    return resposta.redirect(`${urlApi}/verificacoes/${token}`, 303);
  });

  return app;
}
