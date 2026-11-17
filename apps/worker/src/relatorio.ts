import type { Sondagem, SondagemUrl } from './sondagem.ts';

// hazard: o relatório é Markdown publicado no repositório; texto vindo de sites (mensagens de erro,
// URLs) passa por escape para não quebrar a tabela nem injetar marcação.
function celula(texto: string): string {
  return texto.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
}

function tamanho(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function acesso(r: SondagemUrl): string {
  if (r.acesso === 'ok') return `✅ ${r.status ?? ''} ${r.mime ?? ''}`.trim();
  if (r.acesso === 'bloqueado-robots') return '⛔ robots.txt';
  return `❌ ${r.erro?.codigo ?? 'erro'}${r.erro?.status == null ? '' : ` (${r.erro.status})`}`;
}

function simNao(valor: boolean | null): string {
  if (valor === null) return '—';
  return valor ? 'sim' : '**não**';
}

function estavel(r: SondagemUrl): string {
  return `${simNao(r.estavel)} / ${simNao(r.estavelConteudo)}`;
}

function validadores(r: SondagemUrl): string {
  const partes = [r.etag === null ? null : 'ETag', r.ultimaModificacao === null ? null : 'Last-Modified'].filter(
    (p): p is string => p !== null,
  );
  return partes.length === 0 ? 'nenhum' : partes.join(' + ');
}

function documentos(r: SondagemUrl): string {
  if (r.documentos.total === 0) return '—';
  const detalhe = Object.entries(r.documentos.porExtensao)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ext, n]) => `${n} ${ext.slice(1)}`)
    .join(', ');
  return `${r.documentos.total} (${detalhe})`;
}

export function gerarRelatorio(sondagem: Sondagem): string {
  const r = sondagem.resultados;
  const ok = r.filter((x) => x.acesso === 'ok').length;
  const erros = r.filter((x) => x.acesso === 'erro');
  const bloqueados = r.filter((x) => x.acesso === 'bloqueado-robots');
  const instaveis = r.filter((x) => x.estavel === false);
  const instaveisConteudo = r.filter((x) => x.estavelConteudo === false);
  const comValidadores = r.filter((x) => x.etag !== null || x.ultimaModificacao !== null);

  const linhas: string[] = [
    '# Sondagem das fontes oficiais — Fase 0',
    '',
    `> Gerado por \`pnpm sondar\` em ${sondagem.executadaEm}. Não edite à mão: rode a sondagem de novo.`,
    `> User-Agent: \`${sondagem.userAgent}\`. Cada semente foi lida duas vezes (estabilidade) e, se houver validadores HTTP, uma terceira com requisição condicional.`,
    '',
    '## Resumo',
    '',
    `| Item | Quantidade |`,
    `|---|---|`,
    `| Sementes sondadas | ${r.length} |`,
    `| Acessíveis | ${ok} |`,
    `| Com erro | ${erros.length} |`,
    `| Bloqueadas por robots.txt | ${bloqueados.length} |`,
    `| Bytes diferentes entre duas leituras seguidas | ${instaveis.length} |`,
    `| Conteúdo normalizado diferente entre duas leituras seguidas | ${instaveisConteudo.length} |`,
    `| Com ETag ou Last-Modified | ${comValidadores.length} |`,
    '',
    '"Estável" compara duas leituras seguidas: primeiro os bytes, depois a impressão digital de conteúdo',
    '(HTML sem `<head>`, scripts e atributos; ver `packages/ingest/src/impressao.ts`), que é o que a coleta usa para detectar mudança.',
    '',
    '## Por semente',
    '',
    '| Fonte | Nível | URL | Acesso | Tamanho | Validadores | Condicional | Estável (bytes / conteúdo) | Documentos linkados | Feeds |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const x of r) {
    linhas.push(
      `| ${celula(x.fonteId)} | ${x.nivel} | ${celula(x.url)} | ${celula(acesso(x))} | ${tamanho(x.bytes)} | ${validadores(x)} | ${x.condicional} | ${estavel(x)} | ${documentos(x)} | ${x.feeds.length === 0 ? '—' : x.feeds.map(celula).join('<br>')} |`,
    );
  }

  const hosts = new Map<string, SondagemUrl['robots']>();
  for (const x of r) hosts.set(new URL(x.url).hostname, x.robots);
  linhas.push('', '## robots.txt por host', '', '| Host | Situação | Crawl-delay | Detalhe |', '|---|---|---|---|');
  for (const [host, robots] of [...hosts].sort(([a], [b]) => a.localeCompare(b))) {
    linhas.push(
      `| ${host} | ${robots.situacao} | ${robots.atrasoSegundos === null ? '—' : `${robots.atrasoSegundos} s`} | ${celula(robots.detalhe)} |`,
    );
  }

  if (erros.length > 0) {
    linhas.push('', '## Erros', '', '| URL | Código | Mensagem |', '|---|---|---|');
    for (const x of erros) {
      linhas.push(`| ${celula(x.url)} | ${x.erro?.codigo ?? ''} | ${celula(x.erro?.mensagem ?? '')} |`);
    }
  }

  const redirecionadas = r.filter((x) => x.saltos.length > 0);
  if (redirecionadas.length > 0) {
    linhas.push('', '## Redirecionamentos', '', '| URL | Destino final |', '|---|---|');
    for (const x of redirecionadas) linhas.push(`| ${celula(x.url)} | ${celula(x.urlFinal ?? '')} |`);
  }

  linhas.push('');
  return linhas.join('\n');
}
