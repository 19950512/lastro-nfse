import type { Fonte } from '@lastro/core';
import type { ArquivoVersionado, EventoMudanca, RegistroSnapshot } from './arquivo.ts';
import { buscarOficial, ErroColeta, MIMES_DOCUMENTO, type Transporte } from './http.ts';
import { impressaoDigital } from './impressao.ts';
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
}

const MIMES_HTML = new Set(['text/html', 'application/xhtml+xml']);

async function coletarUrl(
  fonte: Fonte,
  url: string,
  deps: DependenciasColeta,
  mimesAceitos: readonly string[] = MIMES_DOCUMENTO,
): Promise<Coletado> {
  const agora = deps.agora ?? (() => new Date());
  const host = new URL(url).hostname;
  const anterior = await deps.arquivo.ultimoSnapshot(url);
  const falha = (situacao: SituacaoUrl, detalhe: string): Coletado => ({
    resultado: { url, situacao, sha256: null, detalhe },
    anterior,
    corpo: undefined,
    mime: undefined,
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
    if (erro instanceof ErroColeta) return falha('erro', `${erro.codigo}: ${erro.message}`);
    throw erro;
  }

  if (busca.tipo === 'nao-modificado') {
    if (anterior === undefined) return falha('erro', '304 sem snapshot anterior');
    await deps.arquivo.registrarVerificacao({ url, sha256: anterior.sha256, verificadoEm: agora().toISOString() });
    return {
      resultado: { url, situacao: 'nao-modificado', sha256: anterior.sha256, detalhe: null },
      anterior,
      corpo: await deps.arquivo.lerConteudo(anterior.sha256),
      mime: anterior.mime,
    };
  }

  const impressao = impressaoDigital(busca.corpo, busca.mime);
  if (anterior?.impressao === impressao) {
    await deps.arquivo.registrarVerificacao({ url, sha256: busca.sha256, verificadoEm: agora().toISOString() });
    return {
      resultado: { url, situacao: 'inalterado', sha256: busca.sha256, detalhe: null },
      anterior,
      corpo: busca.corpo,
      mime: busca.mime,
    };
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
    },
    anterior,
    corpo: busca.corpo,
    mime: busca.mime,
  };
}

function documentosDaPagina(corpo: Buffer, mime: string | undefined, url: string): string[] {
  if (mime === undefined || !MIMES_HTML.has(mime)) return [];
  return linksDeDocumentos(extrairLinks(decodificarHtml(corpo, mime), url).links).documentos;
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

  const registrar = async (resultado: ResultadoUrl, anterior: RegistroSnapshot | undefined): Promise<void> => {
    urls.push(resultado);
    if (resultado.situacao !== 'documento-novo' && resultado.situacao !== 'nova-versao') return;
    eventos.push(
      await deps.arquivo.registrarEvento({
        tipo: resultado.situacao,
        fonteId: fonte.id,
        url: resultado.url,
        snapshotAnterior: anterior?.id ?? null,
        snapshotNovo: resultado.detalhe,
        detectadoEm: agora().toISOString(),
        resumo:
          resultado.situacao === 'documento-novo'
            ? 'Documento coletado pela primeira vez'
            : `Conteúdo mudou (sha256 ${anterior?.sha256.slice(0, 12) ?? '?'}… → ${resultado.sha256?.slice(0, 12) ?? '?'}…)`,
      }),
    );
  };

  for (const semente of fonte.sementes) {
    const coletado = await coletarUrl(fonte, semente, deps);
    await registrar(coletado.resultado, coletado.anterior);
    if (!colherDocumentos || coletado.corpo === undefined) continue;

    const atuais = documentosDaPagina(coletado.corpo, coletado.mime, semente);
    for (const doc of atuais) documentos.add(doc);

    if (coletado.resultado.situacao === 'nova-versao' && coletado.anterior !== undefined) {
      const antigos = documentosDaPagina(
        await deps.arquivo.lerConteudo(coletado.anterior.sha256),
        coletado.anterior.mime,
        semente,
      );
      const atuaisSet = new Set(atuais);
      for (const removido of antigos.filter((d) => !atuaisSet.has(d))) {
        eventos.push(
          await deps.arquivo.registrarEvento({
            tipo: 'link-removido',
            fonteId: fonte.id,
            url: removido,
            snapshotAnterior: coletado.anterior.id,
            snapshotNovo: coletado.resultado.detalhe,
            detectadoEm: agora().toISOString(),
            resumo: `Link removido da página ${semente}`,
          }),
        );
      }
    }
  }

  let coletados = 0;
  for (const doc of documentos) {
    if (coletados >= maxDocumentos) {
      urls.push({ url: doc, situacao: 'erro', sha256: null, detalhe: `limite de ${maxDocumentos} documentos por rodada` });
      continue;
    }
    coletados++;
    const coletado = await coletarUrl(fonte, doc, deps, mimesParaDocumento(doc));
    await registrar(coletado.resultado, coletado.anterior);
  }

  return { fonteId: fonte.id, urls, eventos };
}
