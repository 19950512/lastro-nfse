import type { Mudanca } from '@lastro/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DependenciasApi } from './app.ts';
import { listarFontes } from './app.ts';
import { ConsultaDocumentos, ParametroId } from './esquemas.ts';
import { hrefSeguro, html, type Html } from './html.ts';

// why: a tela não tem script nenhum; a CSP proíbe qualquer script e só permite o CSS servido pela própria aplicação.
const CSP_PAINEL =
  "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const ESTILO = `
:root { --fundo:#f7f7f5; --texto:#1d1d1b; --suave:#5f5f5a; --linha:#deded8; --alerta:#9a3412; --alerta-fundo:#fff1e6; --ok:#166534; --link:#1d4ed8; }
@media (prefers-color-scheme: dark) { :root { --fundo:#161615; --texto:#ecece8; --suave:#a3a39c; --linha:#33332f; --alerta:#fdba74; --alerta-fundo:#3b2414; --ok:#86efac; --link:#93c5fd; } }
html { box-sizing: border-box; } main, table, td, th { box-sizing: inherit; }
body { margin:0; background:var(--fundo); color:var(--texto); font:15px/1.5 system-ui, sans-serif; }
main { max-width:1100px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:1.4rem; margin:0 0 4px; } h2 { font-size:1.1rem; margin:32px 0 8px; }
p.sub { color:var(--suave); margin:0 0 16px; }
a { color:var(--link); }
.tabela { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.9rem; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--linha); vertical-align:top; }
th { color:var(--suave); font-weight:600; }
td.url, p.url { word-break:break-all; }
.etiqueta { display:inline-block; padding:0 6px; border-radius:4px; border:1px solid var(--linha); font-size:.8rem; }
.alerta { color:var(--alerta); background:var(--alerta-fundo); border-color:var(--alerta); }
.ok { color:var(--ok); }
nav a { margin-right:12px; }
`;

const formatoData = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
const data = (iso: string | null): string => (iso === null ? '—' : formatoData.format(new Date(iso)));

function pagina(titulo: string, corpo: Html): Html {
  return html`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo} · Lastro</title><link rel="stylesheet" href="/painel/estilo.css"></head>
<body><main>
<nav><a href="/painel">Início</a><a href="/painel/documentos">Documentos</a><a href="/v1/openapi.json">API</a></nav>
${corpo}
<p class="sub">Somente fontes oficiais. Informação, não orientação profissional.</p>
</main></body></html>`;
}

function enviar(resposta: FastifyReply, conteudo: Html): FastifyReply {
  return resposta
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', CSP_PAINEL)
    .send(conteudo.valor);
}

function linhaMudanca(m: Mudanca): Html {
  return html`<tr>
<td>${data(m.detectadoEm)}</td>
<td><span class="etiqueta">${m.tipo}</span></td>
<td>${m.fonteId}</td>
<td class="url"><a href="${hrefSeguro(`/painel/documentos/${m.documentoId}`)}">${m.url}</a></td>
<td>${m.resumo}${m.anomalia === null ? '' : html` <span class="etiqueta alerta">revisão: ${m.anomalia}</span>`}</td>
</tr>`;
}

export function registrarPainel(app: FastifyInstance, deps: DependenciasApi): void {
  const agora = deps.agora ?? (() => new Date());

  app.get('/painel/estilo.css', (_req, resposta) =>
    resposta.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'public, max-age=3600').send(ESTILO),
  );

  app.get('/painel', async (_req, resposta) => {
    const fontes = await listarFontes(deps);
    const mudancas = await deps.consultas.listarMudancas({ desde: new Date(agora().getTime() - 7 * 86_400_000), limite: 500 });
    const recentes = [...mudancas.itens].reverse();
    return enviar(
      resposta,
      pagina(
        'Monitor',
        html`<h1>Lastro — monitor de fontes oficiais</h1>
<p class="sub">Posição em ${data(agora().toISOString())}</p>
<h2>Fontes</h2>
<div class="tabela"><table><thead><tr><th>Fonte</th><th>Nível</th><th>Órgão</th><th>Documentos</th><th>Última verificação</th><th>Situação</th></tr></thead><tbody>
${fontes.map(
  (f) => html`<tr><td><a href="${hrefSeguro(`/painel/documentos?fonte=${encodeURIComponent(f.id)}`)}">${f.nome}</a></td><td>${f.nivel}</td><td>${f.orgao}</td><td>${f.documentos}</td><td>${data(f.ultima_verificacao_em ?? f.ultima_versao_em)}</td><td>${f.atrasada ? html`<span class="etiqueta alerta">atrasada</span>` : html`<span class="ok">em dia</span>`}</td></tr>`,
)}
</tbody></table></div>
<h2>Mudanças nos últimos 7 dias (${recentes.length})</h2>
<div class="tabela"><table><thead><tr><th>Quando</th><th>Tipo</th><th>Fonte</th><th>Documento</th><th>Resumo</th></tr></thead><tbody>
${recentes.map(linhaMudanca)}
</tbody></table></div>`,
      ),
    );
  });

  app.get('/painel/documentos', async (req, resposta) => {
    const q = ConsultaDocumentos.parse(req.query);
    const p = await deps.consultas.listarDocumentos({ fonteId: q.fonte, limite: q.limite, cursor: q.cursor });
    const proximo =
      p.proximo === null
        ? null
        : `/painel/documentos?${new URLSearchParams({ ...(q.fonte === undefined ? {} : { fonte: q.fonte }), cursor: p.proximo }).toString()}`;
    return enviar(
      resposta,
      pagina(
        'Documentos',
        html`<h1>Documentos${q.fonte === undefined ? '' : html` — ${q.fonte}`}</h1>
<div class="tabela"><table><thead><tr><th>URL oficial</th><th>Versões</th><th>Última versão</th><th>Última verificação</th><th>Situação</th></tr></thead><tbody>
${p.itens.map(
  (d) => html`<tr><td class="url"><a href="${hrefSeguro(`/painel/documentos/${d.id}`)}">${d.url}</a></td><td>${d.versoes}</td><td>${data(d.ultimaVersaoEm)}</td><td>${data(d.ultimaVerificacaoEm)}</td><td>${d.situacao === 'indisponivel' ? html`<span class="etiqueta alerta">indisponível</span>` : 'disponível'}</td></tr>`,
)}
</tbody></table></div>
${proximo === null ? '' : html`<p><a href="${hrefSeguro(proximo)}">Próxima página</a></p>`}`,
      ),
    );
  });

  app.get('/painel/documentos/:id', async (req, resposta) => {
    const { id } = ParametroId.parse(req.params);
    const d = await deps.consultas.obterDocumento(id);
    if (d === undefined) return resposta.status(404).send({ erro: 'nao-encontrado' });
    return enviar(
      resposta,
      pagina(
        'Documento',
        html`<h1>Documento</h1>
<p class="sub url"><a href="${hrefSeguro(d.url)}" rel="noopener noreferrer">${d.url}</a></p>
<p>Fonte: ${d.fonteId} · ${d.versoes} versões · ${d.situacao === 'indisponivel' ? html`<span class="etiqueta alerta">indisponível na fonte</span>` : 'disponível na fonte'}</p>
<h2>Versões arquivadas</h2>
<div class="tabela"><table><thead><tr><th>Coletada em</th><th>SHA-256</th><th>Tipo</th><th>Tamanho</th><th>Original</th></tr></thead><tbody>
${d.historico.map(
  (v) => html`<tr><td>${data(v.coletadoEm)}</td><td><code>${v.sha256.slice(0, 16)}…</code></td><td>${v.mime}</td><td>${v.bytes.toLocaleString('pt-BR')} bytes</td><td><a href="${hrefSeguro(`/v1/snapshots/${v.id}/original`)}">baixar</a></td></tr>`,
)}
</tbody></table></div>
<h2>Eventos</h2>
<div class="tabela"><table><thead><tr><th>Quando</th><th>Tipo</th><th>Fonte</th><th>Documento</th><th>Resumo</th></tr></thead><tbody>
${d.eventos.map(linhaMudanca)}
</tbody></table></div>`,
      ),
    );
  });

  app.get('/', (_req, resposta) => resposta.redirect('/painel'));
}
