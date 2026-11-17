import type { Fonte } from '@lastro/core';
import { detectarAnomalia, type LadoComparacao } from './anomalia.ts';
import type { ArquivoVersionado, EventoMudanca, RegistroSnapshot, TipoEvento } from './arquivo.ts';
import { buscarOficial, ErroColeta, MIMES_DOCUMENTO, type Transporte } from './http.ts';
import { impressaoDigital, normalizarHtml } from './impressao.ts';
import type { LimitadorPorHost } from './limitador.ts';
import { decodificarHtml, extrairLinks, linksDeDocumentos, mimesParaDocumento } from './links.ts';
import type { CacheRobots } from './robots.ts';

export interface DependenciasColeta {
  readonly transporte: Transporte;
  readonly arquivo: ArquivoVersionado;
  readonly robots: CacheRobots;
  readonly limitador: LimitadorPorHost;
  readonly agora?: () => Date;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export type SituacaoUrl =
  | 'documento-novo'
  | 'nova-versao'
  | 'inalterado'
  | 'nao-modificado'
  | 'bloqueado-robots'
  | 'erro';

export interface ResultadoUrl {
  readonly url: string;
  readonly situacao: SituacaoUrl;
  readonly sha256: string | null;
  readonly detalhe: string | null;
  readonly anomalia: string | null;
}

export interface ResultadoColetaFonte {
  readonly fonteId: string;
  readonly urls: readonly ResultadoUrl[];
  readonly eventos: readonly EventoMudanca[];
}

export interface OpcoesColeta {
  readonly colherDocumentos?: boolean;
  /** why: teto por rodada para uma página adulterada com milhares de links não virar varredura. */
  readonly maxDocumentos?: number;
}

interface Coletado {
  readonly resultado: ResultadoUrl;
  readonly anterior: RegistroSnapshot | undefined;
  readonly corpo: Buffer | undefined;
  readonly mime: string | undefined;
  readonly erro: ErroColeta | undefined;
  readonly linksAnteriores: readonly string[] | undefined;
}

const MIMES_HTML = new Set(['text/html', 'application/xhtml+xml']);
const STATUS_INDISPONIVEL = new Set([401, 403, 404, 410]);
const SITUACOES_DISPONIVEL = new Set<SituacaoUrl>(['inalterado', 'nao-modificado', 'nova-versao']);

function documentosDaPagina(corpo: Buffer, mime: string | undefined, url: string): string[] {
  if (mime === undefined || !MIMES_HTML.has(mime)) return [];
  return linksDeDocumentos(extrairLinks(decodificarHtml(corpo, mime), url).links).documentos;
}

function lado(corpo: Buffer, mime: string, urlFinal: string, url: string): LadoComparacao {
  if (!MIMES_HTML.has(mime)) return { urlFinal, mime, bytes: corpo.byteLength };
  return {
    urlFinal,
    mime,
    bytes: corpo.byteLength,
    textoNormalizado: normalizarHtml(decodificarHtml(corpo, mime)),
    linksDocumentos: documentosDaPagina(corpo, mime, url),
  };
}

/**
 * why: só erros que indicam retirada do documento contam (4xx de acesso, página de erro no lugar do
 * arquivo, redirecionamento para fora da lista). 5xx e falha de rede são instabilidade e não geram evento.
 */
function indisponibilidadeDefinitiva(erro: ErroColeta): boolean {
  if (erro.codigo === 'mime-negado' || erro.codigo === 'origem-negada') return true;
  return erro.codigo === 'status-http' && erro.status !== undefined && STATUS_INDISPONIVEL.has(erro.status);
}

async function coletarUrl(
  fonte: Fonte,
  url: string,
  deps: DependenciasColeta,
  mimesAceitos: readonly string[] = MIMES_DOCUMENTO,
): Promise<Coletado> {
  const agora = deps.agora ?? (() => new Date());
  const host = new URL(url).hostname;
  const anterior = await deps.arquivo.ultimoSnapshot(url);
  const falha = (situacao: SituacaoUrl, detalhe: string, erro?: ErroColeta): Coletado => ({
    resultado: { url, situacao, sha256: null, detalhe, anomalia: null },
    anterior,
    corpo: undefined,
    mime: undefined,
    erro,
    linksAnteriores: undefined,
  });

  const robots = await deps.robots.obter(host);
  if (!robots.permitido(url)) return falha('bloqueado-robots', `robots.txt ${robots.situacao}: ${robots.detalhe}`);
  await deps.limitador.aguardar(host, (robots.atrasoSegundos ?? 0) * 1000);

  let busca;
  try {
    busca = await buscarOficial(url, {
      transporte: deps.transporte,
      mimesAceitos,
      condicional: anterior === undefined ? undefined : { etag: anterior.etag, ultimaModificacao: anterior.ultimaModificacao },
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.userAgent === undefined ? {} : { userAgent: deps.userAgent }),
    });
  } catch (erro) {
    if (erro instanceof ErroColeta) return falha('erro', `${erro.codigo}: ${erro.message}`, erro);
    throw erro;
  }

  const semMudanca = (situacao: SituacaoUrl, sha: string, corpo: Buffer, mime: string): Coletado => ({
    resultado: { url, situacao, sha256: sha, detalhe: null, anomalia: null },
    anterior,
    corpo,
    mime,
    erro: undefined,
    linksAnteriores: undefined,
  });

  if (busca.tipo === 'nao-modificado') {
    if (anterior === undefined) return falha('erro', '304 sem snapshot anterior');
    await deps.arquivo.registrarVerificacao({ url, sha256: anterior.sha256, verificadoEm: agora().toISOString() });
    return semMudanca('nao-modificado', anterior.sha256, await deps.arquivo.lerConteudo(anterior.sha256), anterior.mime);
  }

  const impressao = impressaoDigital(busca.corpo, busca.mime);
  if (anterior?.impressao === impressao) {
    await deps.arquivo.registrarVerificacao({ url, sha256: busca.sha256, verificadoEm: agora().toISOString() });
    return semMudanca('inalterado', busca.sha256, busca.corpo, busca.mime);
  }

  let anomalia: string | null = null;
  let linksAnteriores: readonly string[] | undefined;
  if (anterior !== undefined) {
    const ladoAnterior = lado(await deps.arquivo.lerConteudo(anterior.sha256), anterior.mime, anterior.urlFinal, url);
    linksAnteriores = ladoAnterior.linksDocumentos;
    anomalia = detectarAnomalia(ladoAnterior, lado(busca.corpo, busca.mime, busca.urlFinal, url));
  }

  const snapshot = await deps.arquivo.gravarSnapshot(
    {
      fonteId: fonte.id,
      url,
      urlFinal: busca.urlFinal,
      mime: busca.mime,
      etag: busca.etag,
      ultimaModificacao: busca.ultimaModificacao,
      corpo: busca.corpo,
      sha256: busca.sha256,
      impressao,
    },
    agora(),
  );
  return {
    resultado: {
      url,
      situacao: anterior === undefined ? 'documento-novo' : 'nova-versao',
      sha256: snapshot.sha256,
      detalhe: snapshot.id,
      anomalia,
    },
    anterior,
    corpo: busca.corpo,
    mime: busca.mime,
    erro: undefined,
    linksAnteriores,
  };
}

/**
 * Uma rodada de coleta de uma fonte: sementes e, se configurado, documentos linkados nelas.
 *
 * invariant: mudança gera snapshot novo e evento; nada é sobrescrito. Conteúdo idêntico só
 * registra a verificação (base para o aviso "fonte verificada pela última vez em…").
 */
export async function coletarFonte(
  fonte: Fonte,
  deps: DependenciasColeta,
  opcoes: OpcoesColeta = {},
): Promise<ResultadoColetaFonte> {
  const agora = deps.agora ?? (() => new Date());
  const colherDocumentos = opcoes.colherDocumentos ?? fonte.colherDocumentos;
  const maxDocumentos = opcoes.maxDocumentos ?? 300;
  const urls: ResultadoUrl[] = [];
  const eventos: EventoMudanca[] = [];
  const documentos = new Set<string>();

  const emitir = async (
    tipo: TipoEvento,
    url: string,
    snapshotAnterior: string | null,
    snapshotNovo: string | null,
    resumo: string,
    anomalia: string | null = null,
  ): Promise<void> => {
    eventos.push(
      await deps.arquivo.registrarEvento({
        tipo,
        fonteId: fonte.id,
        url,
        snapshotAnterior,
        snapshotNovo,
        detectadoEm: agora().toISOString(),
        resumo,
        anomalia,
      }),
    );
  };

  const processar = async (c: Coletado): Promise<void> => {
    const { url, situacao } = c.resultado;
    urls.push(c.resultado);
    const definitiva = c.erro !== undefined && indisponibilidadeDefinitiva(c.erro);
    const precisaHistorico = c.anterior !== undefined && (SITUACOES_DISPONIVEL.has(situacao) || definitiva);
    const ultimo = precisaHistorico ? await deps.arquivo.ultimoEvento(url) : undefined;

    if (SITUACOES_DISPONIVEL.has(situacao) && ultimo?.tipo === 'documento-indisponivel') {
      await emitir('documento-restabelecido', url, c.anterior?.id ?? null, null, 'Documento voltou a responder');
    }
    if (situacao === 'documento-novo') {
      await emitir(situacao, url, null, c.resultado.detalhe, 'Documento coletado pela primeira vez');
    } else if (situacao === 'nova-versao') {
      await emitir(
        situacao,
        url,
        c.anterior?.id ?? null,
        c.resultado.detalhe,
        `Conteúdo mudou (sha256 ${c.anterior?.sha256.slice(0, 12) ?? '?'}… → ${c.resultado.sha256?.slice(0, 12) ?? '?'}…)`,
        c.resultado.anomalia,
      );
    } else if (definitiva && c.anterior !== undefined && ultimo?.tipo !== 'documento-indisponivel') {
      await emitir('documento-indisponivel', url, c.anterior.id, null, c.resultado.detalhe ?? 'indisponível');
    }
  };

  for (const semente of fonte.sementes) {
    const coletado = await coletarUrl(fonte, semente, deps);
    await processar(coletado);
    if (!colherDocumentos || coletado.corpo === undefined) continue;

    const atuais = documentosDaPagina(coletado.corpo, coletado.mime, semente);
    for (const doc of atuais) documentos.add(doc);

    if (coletado.linksAnteriores !== undefined && coletado.anterior !== undefined) {
      const atuaisSet = new Set(atuais);
      for (const removido of coletado.linksAnteriores.filter((d) => !atuaisSet.has(d))) {
        await emitir('link-removido', removido, coletado.anterior.id, coletado.resultado.detalhe, `Link removido da página ${semente}`);
      }
    }
  }

  let coletados = 0;
  for (const doc of documentos) {
    if (coletados >= maxDocumentos) {
      urls.push({ url: doc, situacao: 'erro', sha256: null, detalhe: `limite de ${maxDocumentos} documentos por rodada`, anomalia: null });
      continue;
    }
    coletados++;
    await processar(await coletarUrl(fonte, doc, deps, mimesParaDocumento(doc)));
  }

  return { fonteId: fonte.id, urls, eventos };
}
