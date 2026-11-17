import type { Fonte, Nivel } from '@lastro/core';
import {
  buscarOficial,
  decodificarHtml,
  ErroColeta,
  extensaoDocumento,
  extrairLinks,
  impressaoDigital,
  linksDeDocumentos,
  MIMES_DOCUMENTO,
  type CacheRobots,
  type LimitadorPorHost,
  type ResultadoBusca,
  type SituacaoRobots,
  type Transporte,
} from '@lastro/ingest';

export type ResultadoCondicional = 'suportado' | 'ignorado' | 'sem-validadores' | 'nao-testado';

export interface SondagemUrl {
  readonly fonteId: string;
  readonly fonteNome: string;
  readonly nivel: Nivel;
  readonly url: string;
  readonly robots: {
    readonly situacao: SituacaoRobots;
    readonly detalhe: string;
    readonly atrasoSegundos: number | null;
    readonly permitido: boolean;
  };
  readonly acesso: 'ok' | 'erro' | 'bloqueado-robots';
  readonly status: number | null;
  readonly mime: string | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly duracaoMs: number | null;
  readonly urlFinal: string | null;
  readonly saltos: readonly string[];
  readonly erro: { readonly codigo: string; readonly mensagem: string; readonly status: number | null } | null;
  readonly etag: string | null;
  readonly ultimaModificacao: string | null;
  readonly condicional: ResultadoCondicional;
  /** Duas leituras seguidas com o mesmo SHA-256 dos bytes. `null` quando a segunda leitura falhou. */
  readonly estavel: boolean | null;
  /** Mesma comparação pela impressão digital de conteúdo, que é o que a coleta usa. */
  readonly estavelConteudo: boolean | null;
  readonly documentos: {
    readonly total: number;
    readonly porExtensao: Readonly<Record<string, number>>;
    readonly exemplos: readonly string[];
  };
  readonly documentosForaDaLista: number;
  readonly feeds: readonly string[];
}

export interface Sondagem {
  readonly executadaEm: string;
  readonly userAgent: string;
  readonly resultados: readonly SondagemUrl[];
}

export interface DependenciasSondagem {
  readonly transporte: Transporte;
  readonly robots: CacheRobots;
  readonly limitador: LimitadorPorHost;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly agora?: () => Date;
  readonly aoProgredir?: (mensagem: string) => void;
}

const SEM_DOCUMENTOS = { total: 0, porExtensao: {}, exemplos: [] };

async function sondarUrl(fonte: Fonte, url: string, deps: DependenciasSondagem): Promise<SondagemUrl> {
  const host = new URL(url).hostname;
  const robots = await deps.robots.obter(host);
  const permitido = robots.permitido(url);
  const intervaloRobots = (robots.atrasoSegundos ?? 0) * 1000;
  const base = {
    fonteId: fonte.id,
    fonteNome: fonte.nome,
    nivel: fonte.nivel,
    url,
    robots: {
      situacao: robots.situacao,
      detalhe: robots.detalhe,
      atrasoSegundos: robots.atrasoSegundos ?? null,
      permitido,
    },
  };
  const vazio = {
    status: null,
    mime: null,
    bytes: null,
    sha256: null,
    duracaoMs: null,
    urlFinal: null,
    saltos: [],
    etag: null,
    ultimaModificacao: null,
    condicional: 'nao-testado' as const,
    estavel: null,
    estavelConteudo: null,
    documentos: SEM_DOCUMENTOS,
    documentosForaDaLista: 0,
    feeds: [],
  };

  if (!permitido) return { ...base, ...vazio, acesso: 'bloqueado-robots', erro: null };

  const buscar = async (condicional?: { etag: string | null; ultimaModificacao: string | null }): Promise<ResultadoBusca> => {
    await deps.limitador.aguardar(host, intervaloRobots);
    return buscarOficial(url, {
      transporte: deps.transporte,
      mimesAceitos: MIMES_DOCUMENTO,
      timeoutMs: deps.timeoutMs,
      userAgent: deps.userAgent,
      condicional,
    });
  };

  let primeira: ResultadoBusca;
  try {
    primeira = await buscar();
  } catch (erro) {
    if (!(erro instanceof ErroColeta)) throw erro;
    return {
      ...base,
      ...vazio,
      acesso: 'erro',
      erro: { codigo: erro.codigo, mensagem: erro.message, status: erro.status ?? null },
    };
  }
  if (primeira.tipo !== 'ok') throw new Error('resposta condicional sem pedido condicional');

  let estavel: boolean | null = null;
  let estavelConteudo: boolean | null = null;
  try {
    const segunda = await buscar();
    if (segunda.tipo === 'ok') {
      estavel = segunda.sha256 === primeira.sha256;
      estavelConteudo = impressaoDigital(segunda.corpo, segunda.mime) === impressaoDigital(primeira.corpo, primeira.mime);
    }
  } catch {
    // why: falha na segunda leitura deixa a estabilidade como desconhecida (null), não como instável.
  }

  let condicional: ResultadoCondicional = 'sem-validadores';
  if (primeira.etag !== null || primeira.ultimaModificacao !== null) {
    try {
      const terceira = await buscar({ etag: primeira.etag, ultimaModificacao: primeira.ultimaModificacao });
      condicional = terceira.tipo === 'nao-modificado' ? 'suportado' : 'ignorado';
    } catch {
      condicional = 'ignorado';
    }
  }

  let documentos: SondagemUrl['documentos'] = SEM_DOCUMENTOS;
  let documentosForaDaLista = 0;
  let feeds: readonly string[] = [];
  if (primeira.mime === 'text/html' || primeira.mime === 'application/xhtml+xml') {
    const pagina = extrairLinks(decodificarHtml(primeira.corpo, primeira.mime), primeira.urlFinal);
    const docs = linksDeDocumentos(pagina.links);
    const porExtensao: Record<string, number> = {};
    for (const doc of docs.documentos) {
      const extensao = extensaoDocumento(new URL(doc).pathname) ?? '?';
      porExtensao[extensao] = (porExtensao[extensao] ?? 0) + 1;
    }
    documentos = { total: docs.documentos.length, porExtensao, exemplos: docs.documentos.slice(0, 5) };
    documentosForaDaLista = docs.foraDaLista;
    feeds = pagina.feeds;
  }

  return {
    ...base,
    acesso: 'ok',
    erro: null,
    status: primeira.status,
    mime: primeira.mime,
    bytes: primeira.corpo.byteLength,
    sha256: primeira.sha256,
    duracaoMs: primeira.duracaoMs,
    urlFinal: primeira.urlFinal,
    saltos: primeira.saltos,
    etag: primeira.etag,
    ultimaModificacao: primeira.ultimaModificacao,
    condicional,
    estavel,
    estavelConteudo,
    documentos,
    documentosForaDaLista,
    feeds,
  };
}

/**
 * Sondagem da Fase 0 (ROADMAP.md): para cada semente do catálogo, registra robots.txt, acesso,
 * formato, validadores HTTP, estabilidade do conteúdo e documentos encontrados.
 */
export async function sondar(fontes: readonly Fonte[], deps: DependenciasSondagem): Promise<Sondagem> {
  const agora = deps.agora ?? (() => new Date());
  const executadaEm = agora().toISOString();
  const tarefas = fontes.flatMap((fonte) => fonte.sementes.map((url) => ({ fonte, url })));

  // why: hosts diferentes podem ser sondados em paralelo; o limitador já serializa cada host.
  const resultados = await Promise.all(
    tarefas.map(async ({ fonte, url }) => {
      const resultado = await sondarUrl(fonte, url, deps);
      deps.aoProgredir?.(`${resultado.acesso.padEnd(16)} ${url}`);
      return resultado;
    }),
  );
  return { executadaEm, userAgent: deps.userAgent, resultados };
}
