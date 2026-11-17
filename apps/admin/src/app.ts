import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hrefSeguro, html, LimitadorTaxa, type Fonte, type Html } from '@lastro/core';
import { ErroCuradoria, TIPOS_FATO, type PropostaDetalhe, type PropostaResumo, type RepositorioCuradoria, type SessaoCurador } from '@lastro/db';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { desafioPkce, ErroOidc, type ProvedorOidc } from './oidc.ts';

export interface DependenciasAdmin {
  readonly curadoria: RepositorioCuradoria;
  readonly oidc: ProvedorOidc;
  readonly fontes: readonly Fonte[];
  /** Origem pública do painel (ex.: https://curadoria.example); conferida no cabeçalho Origin de todo POST. */
  readonly origem: string;
  readonly duracaoSessaoMin?: number;
  readonly agora?: () => Date;
}

export interface OpcoesAdmin {
  readonly logger?: boolean;
  readonly limiteLoginPorMinuto?: number;
}

interface SessaoAtiva {
  readonly token: string;
  readonly sessao: SessaoCurador;
}

declare module 'fastify' {
  interface FastifyRequest {
    sessaoCurador: SessaoAtiva | null;
  }
}

const COOKIE_SESSAO = '__Host-lastro_sessao';
const COOKIE_LOGIN = '__Host-lastro_login';
const LOGIN_MIN = 10;
const ROTAS_PUBLICAS = new Set(['/login', '/oidc/retorno', '/estilo.css']);

// why: o painel não tem script nenhum; a CSP proíbe qualquer script e formulários só para a própria origem.
const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const ESTILO = `
:root { --fundo:#f7f7f5; --texto:#1d1d1b; --suave:#5f5f5a; --linha:#deded8; --alerta:#9a3412; --alerta-fundo:#fff1e6; --ok:#166534; --link:#1d4ed8; --marca:#fef08a; }
@media (prefers-color-scheme: dark) { :root { --fundo:#161615; --texto:#ecece8; --suave:#a3a39c; --linha:#33332f; --alerta:#fdba74; --alerta-fundo:#3b2414; --ok:#86efac; --link:#93c5fd; --marca:#713f12; } }
html { box-sizing: border-box; } *, *::before, *::after { box-sizing: inherit; }
body { margin:0; background:var(--fundo); color:var(--texto); font:15px/1.5 system-ui, sans-serif; }
main { max-width:1200px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:1.4rem; margin:0 0 4px; } h2 { font-size:1.1rem; margin:28px 0 8px; }
p.sub { color:var(--suave); margin:0 0 16px; }
a { color:var(--link); }
.tabela { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.9rem; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--linha); vertical-align:top; }
th { color:var(--suave); font-weight:600; }
.url { word-break:break-all; }
.etiqueta { display:inline-block; padding:0 6px; border-radius:4px; border:1px solid var(--linha); font-size:.8rem; }
.alerta { color:var(--alerta); background:var(--alerta-fundo); border-color:var(--alerta); }
.ok { color:var(--ok); }
.lado { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
@media (max-width: 800px) { .lado { grid-template-columns:1fr; } }
.original { white-space:pre-wrap; border:1px solid var(--linha); padding:12px; max-height:70vh; overflow:auto; font-size:.9rem; }
mark { background:var(--marca); color:inherit; }
nav { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
nav form { margin-left:auto; }
form.decisao { border:1px solid var(--linha); padding:12px; margin:12px 0; }
label { display:block; margin:8px 0 4px; font-weight:600; }
input[type=text], input[type=date], textarea, select { width:100%; max-width:100%; font:inherit; padding:6px; background:var(--fundo); color:var(--texto); border:1px solid var(--linha); }
textarea { min-height:5em; }
button { font:inherit; padding:6px 14px; margin-top:8px; cursor:pointer; }
`;

const formatoData = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
const data = (iso: string | null): string => (iso === null ? '—' : formatoData.format(new Date(iso)));

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const aleatorio = (): string => randomBytes(32).toString('base64url');
const tokenCsrf = (sessao: string): string => sha256(`csrf\0${sessao}`);

function iguais(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function lerCookies(cabecalho: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const parte of (cabecalho ?? '').split(';')) {
    const i = parte.indexOf('=');
    if (i <= 0) continue;
    cookies.set(parte.slice(0, i).trim(), parte.slice(i + 1).trim());
  }
  return cookies;
}

function cookie(nome: string, valor: string, maxAge: number, sameSite: 'Strict' | 'Lax'): string {
  // invariant: prefixo __Host- exige Secure, Path=/ e nenhum Domain; o cookie nunca sai para subdomínios.
  return `${nome}=${valor}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${String(maxAge)}`;
}

const opcional = <T extends z.ZodType>(esquema: T) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), esquema.optional());

const TIPO_PROPOSTA = z.enum(['fato', 'relacao']);
const SITUACAO = z.enum(['proposto', 'aprovado', 'rejeitado', 'revogado', 'superado']);
const ConsultaFila = z.strictObject({ tipo: TIPO_PROPOSTA.default('fato'), situacao: SITUACAO.default('proposto') });
const ParametroProposta = z.strictObject({ tipo: TIPO_PROPOSTA, id: z.uuid() });
const ParametroId = z.strictObject({ id: z.uuid() });
const ConsultaRetorno = z.object({ code: z.string().min(1).max(2048), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const ConsultaNovoFato = z.strictObject({ trecho: z.uuid() });
const CorpoDecisao = z
  .strictObject({ decisao: z.enum(['aprovar', 'rejeitar']), motivo: opcional(z.string().trim().max(2000)) })
  .refine((c) => c.decisao === 'aprovar' || (c.motivo?.length ?? 0) >= 3, { message: 'rejeição exige motivo (mínimo 3 caracteres)', path: ['motivo'] });
const CorpoRecall = z.strictObject({ motivo: z.string().trim().min(3).max(2000) });
const CorpoFato = z.strictObject({
  trecho: z.uuid(),
  tipo: z.enum(TIPOS_FATO),
  tema: z.string().trim().regex(/^[a-z0-9-]{2,80}$/),
  enunciado: z.string().trim().min(10).max(1000),
  publico: opcional(z.string().trim().max(300)),
  data_efeito: opcional(z.iso.date()),
  evidencia_texto: z.string().trim().min(1).max(2000),
  substitui: opcional(z.uuid()),
});

class ErroPagina extends Error {
  readonly status: number;
  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.status = status;
  }
}

/**
 * Painel de curadoria (ARQUITETURA.md §2.3; SEGURANCA.md §4, §5 e §15, Fase 3): SSO com MFA, sessão curta em
 * cookie __Host- HttpOnly SameSite=Strict, token anti-CSRF e conferência de Origin em todo POST, HTML sem script.
 *
 * invariant: o curador que decide vem sempre da sessão, nunca do formulário; o banco confere de novo
 * (lastro.curador_id na transação, dupla aprovação, quem propôs não aprova, recall só por supervisor).
 */
export function construirAdmin(deps: DependenciasAdmin, opcoes: OpcoesAdmin = {}): FastifyInstance {
  const app = Fastify({
    logger:
      opcoes.logger === true
        ? {
            redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
            // hazard: a query do retorno OIDC traz code e state; o log só leva o caminho.
            serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] ?? '' }) },
          }
        : false,
    trustProxy: false,
    bodyLimit: 8192,
    routerOptions: { maxParamLength: 120 },
  });
  const agora = deps.agora ?? (() => new Date());
  const duracaoMin = deps.duracaoSessaoMin ?? 120;
  const limitador = new LimitadorTaxa();
  const limiteLogin = opcoes.limiteLoginPorMinuto ?? 30;
  const fontes = new Map(deps.fontes.map((f) => [f.id, f]));

  app.decorateRequest('sessaoCurador', null);

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, corpo, feito) => {
    feito(null, Object.fromEntries(new URLSearchParams(typeof corpo === 'string' ? corpo : corpo.toString('utf8'))));
  });

  function pagina(titulo: string, corpo: Html, sessao: SessaoAtiva | null): Html {
    return html`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo} · Curadoria Lastro</title><link rel="stylesheet" href="/estilo.css"></head>
<body><main>
${
  sessao === null
    ? ''
    : html`<nav><a href="/fila?tipo=fato">Fatos propostos</a><a href="/fila?tipo=relacao">Relações propostas</a><a href="/fila?tipo=fato&amp;situacao=aprovado">Fatos aprovados</a>
<span class="sub">${sessao.sessao.curador.nome} (${sessao.sessao.curador.papel})</span>
<form method="post" action="/sair">${campoCsrf(sessao)}<button type="submit">Sair</button></form></nav>`
}
${corpo}
</main></body></html>`;
  }

  function campoCsrf(s: SessaoAtiva): Html {
    return html`<input type="hidden" name="csrf" value="${tokenCsrf(s.token)}">`;
  }

  function enviar(resposta: FastifyReply, conteudo: Html, status = 200): FastifyReply {
    return resposta.status(status).header('content-type', 'text/html; charset=utf-8').send(conteudo.valor);
  }

  function sessaoDe(req: FastifyRequest): SessaoAtiva {
    if (req.sessaoCurador === null) throw new ErroPagina(401, 'sessão ausente');
    return req.sessaoCurador;
  }

  app.addHook('onRequest', async (req, resposta) => {
    const caminho = req.url.split('?')[0] ?? '';
    if (ROTAS_PUBLICAS.has(caminho)) return;
    const token = lerCookies(req.headers.cookie).get(COOKIE_SESSAO);
    const sessao = token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token) ? undefined : await deps.curadoria.obterSessao(sha256(token));
    if (token === undefined || sessao === undefined) {
      if (req.method === 'GET') return resposta.redirect('/login', 303);
      return enviar(resposta, pagina('Sessão expirada', html`<h1>Sessão expirada</h1><p><a href="/login">Entrar de novo</a></p>`, null), 401);
    }
    req.sessaoCurador = { token, sessao };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // hazard: SameSite=Strict já barra o cookie em POST de outro site; Origin é a segunda camada (SEGURANCA.md §5).
      const origem = req.headers.origin;
      // hazard: com Referrer-Policy no-referrer o navegador manda "Origin: null" até no POST da própria página; aí decide o
      // Sec-Fetch-Site, que a página não forja. Site atacante com no-referrer também manda null, mas chega como cross-site.
      const mesmoSite = origem === deps.origem || ((origem === undefined || origem === 'null') && req.headers['sec-fetch-site'] === 'same-origin');
      if (!mesmoSite) {
        req.log.warn({ evento: 'csrf-origem', curador: sessao.curador.id }, 'POST de outra origem recusado');
        return enviar(resposta, pagina('Recusado', html`<h1>Requisição recusada</h1>`, null), 403);
      }
    }
  });

  app.addHook('preHandler', async (req, resposta) => {
    if (req.method !== 'POST' || req.sessaoCurador === null) return;
    const corpo = req.body as Record<string, unknown> | undefined;
    const csrf = corpo?.csrf;
    if (typeof csrf !== 'string' || !iguais(csrf, tokenCsrf(req.sessaoCurador.token))) {
      req.log.warn({ evento: 'csrf-token', curador: req.sessaoCurador.sessao.curador.id }, 'token anti-CSRF inválido');
      return enviar(resposta, pagina('Recusado', html`<h1>Requisição recusada</h1><p>Recarregue a página e tente de novo.</p>`, null), 403);
    }
    delete corpo?.csrf;
  });

  app.addHook('onSend', async (_req, resposta) => {
    resposta.header('content-security-policy', CSP);
    resposta.header('x-content-type-options', 'nosniff');
    resposta.header('referrer-policy', 'no-referrer');
    resposta.header('x-frame-options', 'DENY');
    resposta.header('cross-origin-resource-policy', 'same-origin');
    resposta.header('cross-origin-opener-policy', 'same-origin');
    resposta.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    if (resposta.getHeader('cache-control') === undefined) resposta.header('cache-control', 'no-store');
  });

  app.setErrorHandler((erro, req, resposta) => {
    const s = req.sessaoCurador;
    if (erro instanceof ZodError) {
      const itens = erro.issues.map((i) => html`<li>${i.path.join('.') || 'consulta'}: ${i.message}</li>`);
      return enviar(resposta, pagina('Dados inválidos', html`<h1>Dados inválidos</h1><ul>${itens}</ul>`, s), 400);
    }
    if (erro instanceof ErroCuradoria) {
      const status = erro.codigo === 'nao-permitido' ? 403 : erro.codigo === 'conflito' ? 409 : 400;
      req.log.warn({ evento: 'curadoria-recusada', codigo: erro.codigo, curador: s?.sessao.curador.id }, 'regra de curadoria recusou');
      return enviar(resposta, pagina('Não permitido', html`<h1>Não foi possível registrar</h1><p>${erro.message}</p>`, s), status);
    }
    if (erro instanceof ErroPagina) return enviar(resposta, pagina('Erro', html`<h1>${erro.message}</h1>`, s), erro.status);
    if (erro instanceof ErroOidc) {
      req.log.warn({ evento: 'sso-indisponivel', erro: erro.message }, 'provedor de identidade indisponível');
      return enviar(resposta.header('retry-after', '60'), pagina('Login indisponível', html`<h1>Login indisponível no momento</h1><p>O provedor de identidade não respondeu. Tente de novo em instantes.</p>`, s), 503);
    }
    const status = (erro as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) return enviar(resposta, pagina('Requisição inválida', html`<h1>Requisição inválida</h1>`, s), status);
    // hazard: nunca devolver mensagem ou pilha do erro interno (SEGURANCA.md A10).
    req.log.error(erro);
    return enviar(resposta, pagina('Erro', html`<h1>Erro interno</h1>`, s), 500);
  });

  app.setNotFoundHandler((req, resposta) => enviar(resposta, pagina('Não encontrado', html`<h1>Não encontrado</h1>`, req.sessaoCurador), 404));

  function limitarLogin(req: FastifyRequest): void {
    const r = limitador.consumir(`login:${req.ip}`, limiteLogin, agora().getTime());
    if (!r.permitido) throw new ErroPagina(429, 'muitas tentativas de login; aguarde um minuto');
  }

  app.get('/estilo.css', (_req, resposta) =>
    resposta.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'public, max-age=3600').send(ESTILO),
  );

  app.get('/login', async (req, resposta) => {
    limitarLogin(req);
    const estado = aleatorio();
    const nonce = aleatorio();
    const verificador = aleatorio();
    await deps.curadoria.iniciarLogin({ hashEstado: sha256(estado), nonce, verificador, expiraEm: new Date(agora().getTime() + LOGIN_MIN * 60_000) });
    const destino = await deps.oidc.urlAutorizacao({ estado, nonce, desafio: desafioPkce(verificador) });
    // why: SameSite=Lax porque o retorno do provedor é uma navegação GET vinda de outro site.
    return resposta.header('set-cookie', cookie(COOKIE_LOGIN, estado, LOGIN_MIN * 60, 'Lax')).redirect(destino, 303);
  });

  app.get('/oidc/retorno', async (req, resposta) => {
    limitarLogin(req);
    const falhar = (motivo: string) => {
      req.log.warn({ evento: 'falha-login', ip: req.ip, motivo }, 'login recusado');
      return enviar(resposta, pagina('Login recusado', html`<h1>Login recusado</h1><p><a href="/login">Tentar de novo</a></p>`, null), 403);
    };
    const q = ConsultaRetorno.safeParse(req.query);
    if (!q.success) return falhar('parâmetros do retorno');
    const noCookie = lerCookies(req.headers.cookie).get(COOKIE_LOGIN);
    // invariant: o state volta pelo navegador que iniciou o login (cookie) e é de uso único (banco); sem os dois, login CSRF.
    if (noCookie === undefined || !iguais(noCookie, q.data.state)) return falhar('state diferente do cookie');
    const pendente = await deps.curadoria.consumirLogin(sha256(q.data.state));
    if (pendente === undefined) return falhar('state expirado ou já usado');
    let identidade;
    try {
      identidade = await deps.oidc.trocarCodigo({ codigo: q.data.code, verificador: pendente.verificador, nonce: pendente.nonce });
    } catch (erro) {
      if (erro instanceof ErroOidc) return falhar(erro.message);
      throw erro;
    }
    const curador = await deps.curadoria.curadorPorIdentidade(identidade.emissor, identidade.sujeito);
    if (curador === undefined) return falhar('identidade sem curador ativo');
    const token = aleatorio();
    await deps.curadoria.criarSessao({ hash: sha256(token), curadorId: curador.id, amr: identidade.amr, expiraEm: new Date(agora().getTime() + duracaoMin * 60_000) });
    req.log.info({ evento: 'login', curador: curador.id }, 'curador entrou');
    return resposta
      .header('set-cookie', [cookie(COOKIE_SESSAO, token, duracaoMin * 60, 'Strict'), cookie(COOKIE_LOGIN, '', 0, 'Lax')])
      .redirect('/fila', 303);
  });

  app.post('/sair', async (req, resposta) => {
    await deps.curadoria.encerrarSessao(sha256(sessaoDe(req).token));
    return resposta.header('set-cookie', cookie(COOKIE_SESSAO, '', 0, 'Strict')).redirect('/login', 303);
  });

  app.get('/', (_req, resposta) => resposta.redirect('/fila', 303));

  const nivel = (fonteId: string): string => {
    const f = fontes.get(fonteId);
    return f === undefined ? fonteId : `${f.nivel} · ${f.orgao}`;
  };

  function etiquetas(p: PropostaResumo): Html {
    return html`${p.souProponente ? html` <span class="etiqueta">sua proposta</span>` : ''}${p.jaDecidi ? html` <span class="etiqueta ok">já decidi</span>` : ''}${
      p.evidenciaAtual ? '' : html` <span class="etiqueta alerta">documento mudou — revisar</span>`
    }`;
  }

  app.get('/fila', async (req, resposta) => {
    const s = sessaoDe(req);
    const q = ConsultaFila.parse(req.query);
    const propostas = await deps.curadoria.listarPropostas(s.sessao.curador.id, { tipo: q.tipo, situacao: q.situacao, limite: 200 });
    const rotulo = q.tipo === 'fato' ? 'Fatos' : 'Relações normativas';
    return enviar(
      resposta,
      pagina(
        rotulo,
        html`<h1>${rotulo} — ${q.situacao} (${propostas.length})</h1>
<p class="sub">Aprovação exige dois curadores distintos; quem propôs não aprova. Abra a proposta para ver o trecho oficial.</p>
<div class="tabela"><table><thead><tr><th>Proposta</th><th>Extrator</th><th>Proposto por</th><th>Aprovações</th><th>Fonte</th></tr></thead><tbody>
${propostas.map(
  (p) => html`<tr><td><a href="${hrefSeguro(`/propostas/${p.tipo}/${p.id}`)}">${p.titulo}</a>${etiquetas(p)}</td><td>${p.extrator}</td><td>${p.propostoPor ?? 'automático'}<br><span class="sub">${data(p.propostoEm)}</span></td><td>${p.aprovacoes}/2</td><td class="url">${nivel(p.fonteId)}<br><a href="${hrefSeguro(p.url)}" rel="noopener noreferrer">${p.url}</a></td></tr>`,
)}
</tbody></table></div>`,
        s,
      ),
    );
  });

  function realcar(texto: string, trecho: string): Html {
    const i = trecho === '' ? -1 : texto.indexOf(trecho);
    if (i < 0) return html`${texto}`;
    return html`${texto.slice(0, i)}<mark>${trecho}</mark>${texto.slice(i + trecho.length)}`;
  }

  function descricao(p: PropostaDetalhe): Html {
    if (p.fato !== null) {
      const f = p.fato;
      return html`<table><tbody>
<tr><th>Enunciado</th><td>${f.enunciado}</td></tr><tr><th>Tipo</th><td>${f.tipo}</td></tr><tr><th>Tema</th><td>${f.tema}</td></tr>
<tr><th>Público</th><td>${f.publico ?? '—'}</td></tr><tr><th>Data de efeito</th><td>${f.dataEfeito ?? '—'}</td></tr>
${f.substitui === null ? '' : html`<tr><th>Substitui</th><td><a href="${hrefSeguro(`/propostas/fato/${f.substitui}`)}">${f.substitui}</a></td></tr>`}
</tbody></table>`;
    }
    if (p.relacao !== null) {
      const r = p.relacao;
      return html`<table><tbody>
<tr><th>Ato de origem</th><td class="url">${r.origemTitulo ?? '(sem identificação)'}<br><a href="${hrefSeguro(r.origemUrl)}" rel="noopener noreferrer">${r.origemUrl}</a></td></tr>
<tr><th>Relação</th><td><strong>${r.tipo}</strong></td></tr>
<tr><th>Ato de destino</th><td class="url">${r.destinoDescricao}${r.destinoChave === null ? '' : html` <span class="sub">(${r.destinoChave})</span>`}<br>${
        r.destinoUrl === null ? html`<span class="etiqueta alerta">não arquivado na base</span>` : html`<a href="${hrefSeguro(r.destinoUrl)}" rel="noopener noreferrer">${r.destinoUrl}</a>`
      }</td></tr>
<tr><th>Dispositivo</th><td>${r.dispositivo ?? 'ato inteiro'}</td></tr><tr><th>Efeito em</th><td>${r.efeitoEm ?? 'imediato'}</td></tr>
</tbody></table>`;
    }
    return html``;
  }

  app.get('/propostas/:tipo/:id', async (req, resposta) => {
    const s = sessaoDe(req);
    const { tipo, id } = ParametroProposta.parse(req.params);
    const p = await deps.curadoria.obterProposta(s.sessao.curador.id, tipo, id);
    if (p === undefined) throw new ErroPagina(404, 'Proposta não encontrada');
    const t = p.trecho;
    const podeDecidir = p.situacao === 'proposto' && !p.jaDecidi;
    const supervisor = s.sessao.curador.papel === 'supervisor';
    const uso = tipo === 'fato' && p.situacao === 'aprovado' && supervisor ? await deps.curadoria.usoDoFato(id) : null;
    const acao = `/propostas/${tipo}/${id}/decisao`;
    return enviar(
      resposta,
      pagina(
        'Proposta',
        html`<h1>${tipo === 'fato' ? 'Fato' : 'Relação normativa'} — <span class="etiqueta">${p.situacao}</span>${etiquetas(p)}</h1>
<p class="sub">Extrator: ${p.extrator} · proposto por ${p.propostoPor ?? 'automático'} em ${data(p.propostoEm)} · aprovações ${p.aprovacoes}/2</p>
<div class="lado">
<section><h2>Proposta</h2>${descricao(p)}
<h2>Evidência citada</h2><blockquote>${p.evidenciaTexto}</blockquote>
${
  podeDecidir
    ? html`${
        p.souProponente
          ? html`<p class="sub">Você propôs isto: pode rejeitar, mas a aprovação é de outros dois curadores.</p>`
          : html`<form class="decisao" method="post" action="${hrefSeguro(acao)}">${campoCsrf(s)}<input type="hidden" name="decisao" value="aprovar">
<label for="motivo-aprovar">Observação (opcional)</label><textarea id="motivo-aprovar" name="motivo" maxlength="2000"></textarea>
<button type="submit">Aprovar — conferi no trecho oficial</button></form>`
      }<form class="decisao" method="post" action="${hrefSeguro(acao)}">${campoCsrf(s)}<input type="hidden" name="decisao" value="rejeitar">
<label for="motivo-rejeitar">Motivo da rejeição</label><textarea id="motivo-rejeitar" name="motivo" required minlength="3" maxlength="2000"></textarea>
<button type="submit">Rejeitar</button></form>`
    : ''
}
${
  uso === null
    ? ''
    : html`<form class="decisao" method="post" action="${hrefSeguro(`/fatos/${id}/recall`)}">${campoCsrf(s)}
<p><strong>Recall.</strong> Usado em ${uso.verificacoes} verificações e ${uso.consultas} respostas. O fato deixa de valer, os links compartilhados mostram aviso de correção e os assinantes de webhook são avisados.</p>
<label for="motivo-recall">Motivo</label><textarea id="motivo-recall" name="motivo" required minlength="3" maxlength="2000"></textarea>
<button type="submit">Revogar fato aprovado</button></form>`
}
<h2>Decisões</h2>
${p.decisoes.length === 0 ? html`<p class="sub">Nenhuma ainda.</p>` : html`<ul>${p.decisoes.map((d) => html`<li>${data(d.decididaEm)} — ${d.curador}: <strong>${d.decisao}</strong>${d.motivo === null ? '' : html` — ${d.motivo}`}</li>`)}</ul>`}
</section>
<section><h2>Trecho oficial</h2>
<p class="sub url">${nivel(t.fonteId)} · ${t.secao ?? ''}${t.paginaIni === null ? '' : html` · p. ${t.paginaIni}`}<br>
<a href="${hrefSeguro(t.url)}" rel="noopener noreferrer">${t.url}</a><br>SHA-256 <code>${t.sha256}</code> · coletado em ${data(t.coletadoEm)}${t.vigente ? '' : html` <span class="etiqueta alerta">versão antiga</span>`}</p>
<div class="original">${realcar(t.texto, p.evidenciaTexto)}</div>
<p><a href="${hrefSeguro(`/fatos/novo?trecho=${t.id}`)}">Propor outro fato a partir deste trecho</a></p>
</section></div>`,
        s,
      ),
    );
  });

  app.post('/propostas/:tipo/:id/decisao', async (req, resposta) => {
    const s = sessaoDe(req);
    const { tipo, id } = ParametroProposta.parse(req.params);
    const corpo = CorpoDecisao.parse(req.body);
    await deps.curadoria.decidir(s.sessao.curador.id, tipo, id, corpo.decisao, corpo.motivo ?? null);
    req.log.info({ evento: 'decisao-curadoria', curador: s.sessao.curador.id, tipo, id, decisao: corpo.decisao }, 'decisão registrada');
    return resposta.redirect(`/propostas/${tipo}/${id}`, 303);
  });

  app.post('/fatos/:id/recall', async (req, resposta) => {
    const s = sessaoDe(req);
    const { id } = ParametroId.parse(req.params);
    if (s.sessao.curador.papel !== 'supervisor') throw new ErroPagina(403, 'Recall é exclusivo de supervisor');
    const { motivo } = CorpoRecall.parse(req.body);
    const uso = await deps.curadoria.recall(s.sessao.curador.id, id, motivo);
    req.log.warn({ evento: 'recall', curador: s.sessao.curador.id, fato: id, ...uso }, 'fato revogado (recall)');
    return enviar(
      resposta,
      pagina(
        'Recall registrado',
        html`<h1>Recall registrado</h1><p>Afetados: ${uso.verificacoes} verificações e ${uso.consultas} respostas. Os links compartilhados passam a mostrar o aviso de correção; o evento "fato-corrigido" vai para os webhooks no próximo despacho.</p>
<p><a href="${hrefSeguro(`/propostas/fato/${id}`)}">Voltar ao fato</a></p>`,
        s,
      ),
    );
  });

  app.get('/fatos/novo', async (req, resposta) => {
    const s = sessaoDe(req);
    const { trecho: trechoId } = ConsultaNovoFato.parse(req.query);
    const t = await deps.curadoria.obterTrecho(trechoId);
    if (t === undefined) throw new ErroPagina(404, 'Trecho não encontrado');
    return enviar(
      resposta,
      pagina(
        'Propor fato',
        html`<h1>Propor fato</h1><div class="lado"><section>
<form method="post" action="/fatos">${campoCsrf(s)}<input type="hidden" name="trecho" value="${t.id}">
<label for="tipo">Tipo</label><select id="tipo" name="tipo">${TIPOS_FATO.map((x) => html`<option value="${x}">${x}</option>`)}</select>
<label for="tema">Tema (minúsculas e hífen, ex.: emissor-nacional-simples)</label><input id="tema" type="text" name="tema" required maxlength="80">
<label for="enunciado">Enunciado</label><textarea id="enunciado" name="enunciado" required minlength="10" maxlength="1000"></textarea>
<label for="publico">Público (opcional)</label><input id="publico" type="text" name="publico" maxlength="300">
<label for="data_efeito">Data de efeito (opcional)</label><input id="data_efeito" type="date" name="data_efeito">
<label for="evidencia_texto">Evidência — copie o texto exato do trecho ao lado</label><textarea id="evidencia_texto" name="evidencia_texto" required maxlength="2000"></textarea>
<label for="substitui">Substitui o fato (id, opcional)</label><input id="substitui" type="text" name="substitui">
<button type="submit">Propor</button></form></section>
<section><h2>Trecho oficial</h2><p class="sub url">${nivel(t.fonteId)} · <a href="${hrefSeguro(t.url)}" rel="noopener noreferrer">${t.url}</a></p><div class="original">${t.texto}</div></section></div>`,
        s,
      ),
    );
  });

  app.post('/fatos', async (req, resposta) => {
    const s = sessaoDe(req);
    const c = CorpoFato.parse(req.body);
    const t = await deps.curadoria.obterTrecho(c.trecho);
    if (t === undefined) throw new ErroPagina(400, 'Trecho não encontrado');
    // invariant: a evidência é cópia literal do trecho oficial (o banco confere de novo por trigger).
    if (!t.texto.includes(c.evidencia_texto)) throw new ErroPagina(400, 'A evidência precisa ser cópia exata de parte do trecho oficial');
    const id = await deps.curadoria.proporFato(s.sessao.curador.id, {
      tipo: c.tipo,
      tema: c.tema,
      enunciado: c.enunciado,
      publico: c.publico ?? null,
      dataEfeito: c.data_efeito ?? null,
      evidenciaTrechoId: t.id,
      evidenciaTexto: c.evidencia_texto,
      substitui: c.substitui ?? null,
    });
    req.log.info({ evento: 'fato-proposto', curador: s.sessao.curador.id, fato: id }, 'fato proposto pelo painel');
    return resposta.redirect(`/propostas/fato/${id}`, 303);
  });

  return app;
}
