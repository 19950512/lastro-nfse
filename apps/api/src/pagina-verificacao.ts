import { hrefSeguro, html, type Html } from '@lastro/core';
import type { z } from 'zod';
import type { AlegacaoVerificada, VerificacaoPublica } from './esquemas.ts';

/**
 * invariant: a página do link compartilhável não tem script nenhum (a CSP proíbe), não carrega nada de fora e
 * escapa todo texto: alegação vinda do usuário, trecho de documento e explicação do modelo (SEGURANCA.md §4).
 */
export const CSP_VERIFICACAO = "default-src 'none'; style-src 'self'; img-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

export const ESTILO_VERIFICACAO = `
:root { --fundo:#f7f7f5; --texto:#1d1d1b; --suave:#5f5f5a; --linha:#deded8; --cartao:#ffffff; --alerta:#9a3412; --alerta-fundo:#fff1e6;
  --v-confirmado:#166534; --v-falso:#b91c1c; --v-desatualizado:#a16207; --v-neutro:#475569; --link:#1d4ed8; }
@media (prefers-color-scheme: dark) { :root { --fundo:#161615; --texto:#ecece8; --suave:#a3a39c; --linha:#33332f; --cartao:#1f1f1d;
  --alerta:#fdba74; --alerta-fundo:#3b2414; --v-confirmado:#86efac; --v-falso:#fca5a5; --v-desatualizado:#fcd34d; --v-neutro:#cbd5e1; --link:#93c5fd; } }
html, body, main, section, blockquote, ul { box-sizing: border-box; }
body { margin:0; background:var(--fundo); color:var(--texto); font:16px/1.55 system-ui, sans-serif; }
main { max-width:860px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:1.35rem; margin:0 0 4px; } h2 { font-size:1.05rem; margin:0 0 8px; }
p.sub, .meta { color:var(--suave); font-size:.9rem; }
a { color:var(--link); word-break:break-all; }
.recall { border:1px solid var(--alerta); background:var(--alerta-fundo); color:var(--alerta); border-radius:8px; padding:12px 16px; margin:16px 0; }
.alegacao { background:var(--cartao); border:1px solid var(--linha); border-radius:8px; padding:16px; margin:16px 0; }
.veredito { display:inline-block; font-weight:700; font-size:.8rem; letter-spacing:.04em; padding:2px 8px; border-radius:4px; border:1px solid currentColor; margin-bottom:8px; }
.v-confirmado { color:var(--v-confirmado); } .v-falso { color:var(--v-falso); } .v-desatualizado { color:var(--v-desatualizado); }
.v-neutro { color:var(--v-neutro); }
blockquote { margin:8px 0; padding:4px 12px; border-left:3px solid var(--linha); }
ul { padding-left:20px; }
`;

const formatoData = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });
const data = (iso: string): string => formatoData.format(new Date(iso.length === 10 ? `${iso}T12:00:00-03:00` : iso));

const CLASSE: Readonly<Record<string, string>> = {
  confirmado: 'v-confirmado',
  falso: 'v-falso',
  desatualizado: 'v-desatualizado',
  impreciso: 'v-desatualizado',
};

function alegacao(a: z.infer<typeof AlegacaoVerificada>): Html {
  return html`<section class="alegacao">
<span class="veredito ${CLASSE[a.veredito] ?? 'v-neutro'}">${a.rotulo}</span>
<h2>${a.alegacao}</h2>
<p>${a.explicacao}</p>
${a.evidencias.length === 0 ? '' : html`<p class="meta">O que dizem as fontes oficiais:</p>`}
${a.evidencias.map(
  (e) => html`<blockquote>“${e.trecho}”</blockquote>
<p class="meta">${e.orgao} (${e.nivel}) · <a href="${hrefSeguro(e.url)}" rel="noopener noreferrer">${e.titulo}</a>${e.secao === null ? '' : html` · ${e.secao}`}${e.pagina === null ? '' : html` · p. ${e.pagina}`} · coletado em ${data(e.coletado_em)} · SHA-256 ${e.sha256.slice(0, 12)}…${e.revogado_por === null ? '' : html` · <strong>revogado por ${e.revogado_por}</strong>`}</p>`,
)}
${a.fatos.length === 0 ? '' : html`<p class="meta">Fatos aprovados pela curadoria:</p><ul>${a.fatos.map((f) => html`<li>${f.enunciado}</li>`)}</ul>`}
${a.relacoes.length === 0 ? '' : html`<p class="meta">Relações entre atos (grafo normativo):</p><ul>${a.relacoes.map((r) => html`<li>${r.origem} ${r.tipo} ${r.destino}${r.dispositivo === null ? '' : html` (${r.dispositivo})`}</li>`)}</ul>`}
${a.avisos.map((t) => html`<p class="meta">${t}</p>`)}
${a.busca === null || a.evidencias.length > 0 ? '' : html`<p class="meta">Busca feita: “${a.busca.consulta}” em ${a.busca.fontes_consultadas} fontes oficiais.</p>`}
</section>`;
}

export function paginaVerificacao(v: z.infer<typeof VerificacaoPublica>): Html {
  const r = v.resultado;
  return html`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Verificação de alegações</title><link rel="stylesheet" href="/verificacoes/estilo.css"></head>
<body><main>
<h1>Verificação de alegações</h1>
<p class="sub">Posição em ${data(r.posicao_em)} · verificação ${v.id.slice(0, 8)} · somente fontes oficiais</p>
${v.correcoes.length === 0
  ? ''
  : html`<div class="recall"><strong>Correção:</strong> esta verificação usou informação que a curadoria revogou depois. Os vereditos abaixo podem não valer mais.<ul>${v.correcoes.map((c) => html`<li>${c.descricao}</li>`)}</ul></div>`}
${r.alegacoes.length === 0 ? html`<p>Nenhuma alegação verificável foi encontrada.</p>` : r.alegacoes.map(alegacao)}
${r.avisos.map((t) => html`<p class="meta">${t}</p>`)}
<p class="meta">${r.aviso} ${r.limites.join(' ')}</p>
<p class="meta">Esta página é a referência desta verificação; capturas de tela podem estar adulteradas. Válida até ${data(v.expira_em)}.</p>
</main></body></html>`;
}
