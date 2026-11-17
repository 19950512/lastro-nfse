import { createHash } from 'node:crypto';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import zlib from 'node:zlib';
import { verificarOrigem, type ResultadoOrigem } from '@lastro/core';
import { criarLookupSeguro, EnderecoBloqueado } from './rede.ts';

export interface RespostaBruta {
  readonly status: number;
  /** Cabeçalhos com nome em minúsculas; repetidos vêm unidos por vírgula. */
  readonly cabecalhos: Readonly<Record<string, string | undefined>>;
  readonly corpo: AsyncIterable<Uint8Array>;
  descartar(): void;
}

export type Transporte = (url: URL, cabecalhos: Record<string, string>, sinal: AbortSignal) => Promise<RespostaBruta>;

export function criarTransporteHttps(lookup: LookupFunction = criarLookupSeguro()): Transporte {
  const agente = new https.Agent({ keepAlive: true, maxSockets: 2 });
  return (url, cabecalhos, sinal) =>
    new Promise((resolve, reject) => {
      const requisicao = https.request(
        url,
        {
          method: 'GET',
          headers: cabecalhos,
          agent: agente,
          lookup,
          signal: sinal,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        },
        (resposta) => {
          const normalizados: Record<string, string | undefined> = {};
          for (const [nome, valor] of Object.entries(resposta.headers)) {
            normalizados[nome] = Array.isArray(valor) ? valor.join(', ') : valor;
          }
          resolve({
            status: resposta.statusCode ?? 0,
            cabecalhos: normalizados,
            corpo: resposta,
            descartar: () => resposta.destroy(),
          });
        },
      );
      requisicao.on('error', reject);
      requisicao.end();
    });
}

export type CodigoErroColeta =
  | 'origem-negada'
  | 'redirecionamento'
  | 'status-http'
  | 'mime-negado'
  | 'tamanho-excedido'
  | 'tempo-esgotado'
  | 'endereco-bloqueado'
  | 'codificacao'
  | 'rede';

export class ErroColeta extends Error {
  readonly codigo: CodigoErroColeta;
  readonly url: string;
  readonly status: number | undefined;
  constructor(codigo: CodigoErroColeta, url: string, mensagem: string, status?: number) {
    super(mensagem);
    this.name = 'ErroColeta';
    this.codigo = codigo;
    this.url = url;
    this.status = status;
  }
}

export const MIMES_PAGINA = ['text/html', 'application/xhtml+xml'] as const;

export const MIMES_DOCUMENTO = [
  ...MIMES_PAGINA,
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/zip',
  'application/x-zip-compressed',
  'application/xml',
  'text/xml',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',
] as const;

export const USER_AGENT_PADRAO = 'LastroBot/0.1 (coletor de fontes oficiais de NFS-e)';

export interface OpcoesBusca {
  readonly transporte: Transporte;
  readonly verificar?: (url: string | URL) => ResultadoOrigem;
  readonly mimesAceitos?: readonly string[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirecionamentos?: number;
  readonly condicional?: { readonly etag: string | null; readonly ultimaModificacao: string | null } | undefined;
  readonly userAgent?: string;
}

interface BaseResultado {
  readonly urlSolicitada: string;
  readonly urlFinal: string;
  readonly saltos: readonly string[];
  readonly duracaoMs: number;
}

export type ResultadoBusca =
  | (BaseResultado & {
      readonly tipo: 'ok';
      readonly status: number;
      readonly mime: string;
      readonly etag: string | null;
      readonly ultimaModificacao: string | null;
      readonly corpo: Buffer;
      readonly sha256: string;
    })
  | (BaseResultado & { readonly tipo: 'nao-modificado' });

const REDIRECIONAMENTOS = new Set([301, 302, 303, 307, 308]);

export function sha256(dados: Uint8Array): string {
  return createHash('sha256').update(dados).digest('hex');
}

export function mimeDe(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function traduzirErro(erro: unknown, url: string, sinal: AbortSignal): ErroColeta {
  if (erro instanceof ErroColeta) return erro;
  if (erro instanceof EnderecoBloqueado || (erro instanceof Error && erro.cause instanceof EnderecoBloqueado)) {
    return new ErroColeta('endereco-bloqueado', url, erro.message);
  }
  if (sinal.aborted) return new ErroColeta('tempo-esgotado', url, 'tempo máximo da requisição esgotado');
  const codigo = (erro as NodeJS.ErrnoException | undefined)?.code;
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  return new ErroColeta('rede', url, codigo === undefined ? mensagem : `${codigo}: ${mensagem}`);
}

/**
 * hazard: pedimos `identity`, mas um servidor pode comprimir mesmo assim. A descompressão tem
 * teto de saída (`maxOutputLength`) para um arquivo pequeno não virar uma bomba de descompressão.
 */
function decodificar(corpo: Buffer, codificacao: string | undefined, maxBytes: number, url: string): Buffer {
  const tipo = (codificacao ?? 'identity').trim().toLowerCase();
  try {
    switch (tipo) {
      case '':
      case 'identity':
        return corpo;
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(corpo, { maxOutputLength: maxBytes });
      case 'deflate':
        return zlib.inflateSync(corpo, { maxOutputLength: maxBytes });
      case 'br':
        return zlib.brotliDecompressSync(corpo, { maxOutputLength: maxBytes });
      default:
        throw new ErroColeta('codificacao', url, `content-encoding não suportado: ${tipo}`);
    }
  } catch (erro) {
    if (erro instanceof ErroColeta) throw erro;
    if (erro instanceof RangeError) throw new ErroColeta('tamanho-excedido', url, 'conteúdo descomprimido acima do limite');
    throw new ErroColeta('codificacao', url, `falha ao descomprimir ${tipo}`);
  }
}

/**
 * GET em site oficial com as proteções de SEGURANCA.md §8.
 *
 * invariant: cada salto de redirecionamento é validado contra a lista oficial antes de ser
 * requisitado; nada é seguido automaticamente pelo transporte.
 */
export async function buscarOficial(entrada: string, opcoes: OpcoesBusca): Promise<ResultadoBusca> {
  const verificar = opcoes.verificar ?? verificarOrigem;
  const mimes = opcoes.mimesAceitos ?? MIMES_DOCUMENTO;
  const maxBytes = opcoes.maxBytes ?? 50 * 1024 * 1024;
  const maxSaltos = opcoes.maxRedirecionamentos ?? 5;
  const sinal = AbortSignal.timeout(opcoes.timeoutMs ?? 60_000);
  const inicio = performance.now();
  const saltos: string[] = [];
  let atual = entrada;

  for (;;) {
    const origem = verificar(atual);
    if (!origem.permitido) throw new ErroColeta('origem-negada', atual, origem.motivo);

    const cabecalhos: Record<string, string> = {
      'user-agent': opcoes.userAgent ?? USER_AGENT_PADRAO,
      accept: mimes.join(', '),
      'accept-encoding': 'identity',
      'accept-language': 'pt-BR,pt;q=0.9',
    };
    if (saltos.length === 0 && opcoes.condicional !== undefined) {
      if (opcoes.condicional.etag !== null) cabecalhos['if-none-match'] = opcoes.condicional.etag;
      if (opcoes.condicional.ultimaModificacao !== null) {
        cabecalhos['if-modified-since'] = opcoes.condicional.ultimaModificacao;
      }
    }

    let resposta: RespostaBruta;
    try {
      resposta = await opcoes.transporte(origem.url, cabecalhos, sinal);
    } catch (erro) {
      throw traduzirErro(erro, atual, sinal);
    }

    const base = (): BaseResultado => ({
      urlSolicitada: entrada,
      urlFinal: atual,
      saltos,
      duracaoMs: Math.round(performance.now() - inicio),
    });

    if (REDIRECIONAMENTOS.has(resposta.status)) {
      resposta.descartar();
      const destino = resposta.cabecalhos.location;
      if (destino === undefined || destino === '') {
        throw new ErroColeta('redirecionamento', atual, 'redirecionamento sem Location', resposta.status);
      }
      if (saltos.length >= maxSaltos) {
        throw new ErroColeta('redirecionamento', atual, `mais de ${maxSaltos} redirecionamentos`, resposta.status);
      }
      atual = new URL(destino, origem.url).toString();
      saltos.push(atual);
      continue;
    }

    if (resposta.status === 304 && opcoes.condicional !== undefined) {
      resposta.descartar();
      return { tipo: 'nao-modificado', ...base() };
    }

    if (resposta.status !== 200) {
      resposta.descartar();
      throw new ErroColeta('status-http', atual, `HTTP ${resposta.status}`, resposta.status);
    }

    const mime = mimeDe(resposta.cabecalhos['content-type']);
    if (!mimes.includes(mime)) {
      resposta.descartar();
      throw new ErroColeta('mime-negado', atual, `tipo não aceito: ${mime || '(vazio)'}`, resposta.status);
    }

    const declarado = Number(resposta.cabecalhos['content-length'] ?? Number.NaN);
    if (Number.isFinite(declarado) && declarado > maxBytes) {
      resposta.descartar();
      throw new ErroColeta('tamanho-excedido', atual, `content-length ${declarado} acima de ${maxBytes}`);
    }

    const partes: Buffer[] = [];
    let total = 0;
    try {
      for await (const parte of resposta.corpo) {
        total += parte.byteLength;
        if (total > maxBytes) {
          resposta.descartar();
          throw new ErroColeta('tamanho-excedido', atual, `corpo acima de ${maxBytes} bytes`);
        }
        partes.push(Buffer.from(parte));
      }
    } catch (erro) {
      throw traduzirErro(erro, atual, sinal);
    }

    const corpo = decodificar(Buffer.concat(partes), resposta.cabecalhos['content-encoding'], maxBytes, atual);
    return {
      tipo: 'ok',
      ...base(),
      status: resposta.status,
      mime,
      etag: resposta.cabecalhos.etag ?? null,
      ultimaModificacao: resposta.cabecalhos['last-modified'] ?? null,
      corpo,
      sha256: sha256(corpo),
    };
  }
}
