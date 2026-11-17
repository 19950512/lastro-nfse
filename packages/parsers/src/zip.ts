import { crc32, inflateRawSync } from 'node:zlib';
import { ErroParser } from './erro.ts';

export interface LimitesZip {
  readonly maxArquivos: number;
  readonly maxBytesDescompactados: number;
  readonly maxBytesPorArquivo: number;
}

export const LIMITES_ZIP_PADRAO: LimitesZip = {
  maxArquivos: 2000,
  maxBytesDescompactados: 200 * 1024 * 1024,
  maxBytesPorArquivo: 50 * 1024 * 1024,
};

export interface EntradaZip {
  readonly nome: string;
  readonly conteudo: Buffer;
}

const ASSINATURA_FIM = 0x06054b50;
const ASSINATURA_LOCALIZADOR_ZIP64 = 0x07064b50;
const ASSINATURA_CENTRAL = 0x02014b50;
const ASSINATURA_LOCAL = 0x04034b50;
const TAMANHO_FIM = 22;
const MAX_COMENTARIO = 0xffff;

function localizarFim(corpo: Buffer): number {
  const inicioBusca = Math.max(0, corpo.length - TAMANHO_FIM - MAX_COMENTARIO);
  for (let i = corpo.length - TAMANHO_FIM; i >= inicioBusca; i--) {
    if (corpo.readUInt32LE(i) === ASSINATURA_FIM) return i;
  }
  throw new ErroParser('ZIP sem registro de fim do diretório central');
}

// hazard: o nome vem do arquivo baixado; mesmo sem gravar em disco, nomes que escapariam do
// diretório (zip slip) indicam arquivo forjado e são recusados (SEGURANCA.md §8).
function validarNome(nome: string): void {
  if (nome.length === 0) throw new ErroParser('ZIP com entrada sem nome');
  if (nome.includes('\0')) throw new ErroParser('ZIP com nome contendo NUL');
  if (nome.includes('\\')) throw new ErroParser(`ZIP com barra invertida no nome: ${nome}`);
  if (nome.startsWith('/')) throw new ErroParser(`ZIP com caminho absoluto: ${nome}`);
  if (/^[a-zA-Z]:/.test(nome)) throw new ErroParser(`ZIP com letra de unidade: ${nome}`);
  if (nome.split('/').some((parte) => parte === '..')) throw new ErroParser(`ZIP com ".." no caminho: ${nome}`);
}

function exigirIntervalo(corpo: Buffer, inicio: number, tamanho: number, contexto: string): void {
  if (inicio < 0 || tamanho < 0 || inicio + tamanho > corpo.length) throw new ErroParser(`ZIP corrompido: ${contexto} fora do arquivo`);
}

/**
 * Leitor ZIP mínimo, só em memória, com limites contra zip bomb.
 *
 * invariant: nenhum byte é descompactado além de min(limite por arquivo, orçamento total restante);
 * o `maxOutputLength` do zlib interrompe a descompressão no limite, mesmo que o cabeçalho minta.
 */
export function lerZip(corpo: Buffer, limites: LimitesZip = LIMITES_ZIP_PADRAO): EntradaZip[] {
  if (corpo.length < TAMANHO_FIM) throw new ErroParser('ZIP pequeno demais');
  const fim = localizarFim(corpo);
  if (fim >= 20 && corpo.readUInt32LE(fim - 20) === ASSINATURA_LOCALIZADOR_ZIP64) throw new ErroParser('ZIP64 não suportado');

  const disco = corpo.readUInt16LE(fim + 4);
  const discoCentral = corpo.readUInt16LE(fim + 6);
  const entradasDisco = corpo.readUInt16LE(fim + 8);
  const totalEntradas = corpo.readUInt16LE(fim + 10);
  const tamanhoCentral = corpo.readUInt32LE(fim + 12);
  const inicioCentral = corpo.readUInt32LE(fim + 16);
  if (totalEntradas === 0xffff || tamanhoCentral === 0xffffffff || inicioCentral === 0xffffffff) throw new ErroParser('ZIP64 não suportado');
  if (disco !== 0 || discoCentral !== 0 || entradasDisco !== totalEntradas) throw new ErroParser('ZIP multivolume não suportado');
  if (totalEntradas > limites.maxArquivos) throw new ErroParser(`ZIP com ${totalEntradas} entradas (limite ${limites.maxArquivos})`);
  exigirIntervalo(corpo, inicioCentral, tamanhoCentral, 'diretório central');

  const entradas: EntradaZip[] = [];
  let orcamento = limites.maxBytesDescompactados;
  let posicao = inicioCentral;
  for (let i = 0; i < totalEntradas; i++) {
    exigirIntervalo(corpo, posicao, 46, 'entrada do diretório central');
    if (corpo.readUInt32LE(posicao) !== ASSINATURA_CENTRAL) throw new ErroParser('ZIP corrompido: assinatura do diretório central');
    const flags = corpo.readUInt16LE(posicao + 8);
    const metodo = corpo.readUInt16LE(posicao + 10);
    const crcEsperado = corpo.readUInt32LE(posicao + 16);
    const compactado = corpo.readUInt32LE(posicao + 20);
    const descompactado = corpo.readUInt32LE(posicao + 24);
    const tamanhoNome = corpo.readUInt16LE(posicao + 28);
    const tamanhoExtra = corpo.readUInt16LE(posicao + 30);
    const tamanhoComentario = corpo.readUInt16LE(posicao + 32);
    const deslocamentoLocal = corpo.readUInt32LE(posicao + 42);
    exigirIntervalo(corpo, posicao + 46, tamanhoNome + tamanhoExtra + tamanhoComentario, 'nome da entrada');
    const bytesNome = corpo.subarray(posicao + 46, posicao + 46 + tamanhoNome);
    // why: o bit 11 indica nome em UTF-8; sem ele o padrão é CP437, aproximado aqui por latin1.
    const nome = bytesNome.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
    posicao += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;

    validarNome(nome);
    if ((flags & 0x1) !== 0) throw new ErroParser(`ZIP com entrada cifrada: ${nome}`);
    if (compactado === 0xffffffff || descompactado === 0xffffffff || deslocamentoLocal === 0xffffffff) throw new ErroParser('ZIP64 não suportado');
    if (nome.endsWith('/')) continue;

    const limite = Math.min(limites.maxBytesPorArquivo, orcamento);
    if (descompactado > limite) throw new ErroParser(`ZIP: ${nome} excede o limite de descompressão`);

    exigirIntervalo(corpo, deslocamentoLocal, 30, 'cabeçalho local');
    if (corpo.readUInt32LE(deslocamentoLocal) !== ASSINATURA_LOCAL) throw new ErroParser(`ZIP corrompido: cabeçalho local de ${nome}`);
    const inicioDados = deslocamentoLocal + 30 + corpo.readUInt16LE(deslocamentoLocal + 26) + corpo.readUInt16LE(deslocamentoLocal + 28);
    exigirIntervalo(corpo, inicioDados, compactado, `dados de ${nome}`);
    const dados = corpo.subarray(inicioDados, inicioDados + compactado);

    let conteudo: Buffer;
    if (metodo === 0) {
      conteudo = Buffer.from(dados);
    } else if (metodo === 8) {
      try {
        conteudo = inflateRawSync(dados, { maxOutputLength: Math.max(1, limite) });
      } catch (erro) {
        if (erro instanceof RangeError) throw new ErroParser(`ZIP: ${nome} excede o limite de descompressão`);
        throw new ErroParser(`ZIP: falha ao descompactar ${nome}`);
      }
    } else {
      throw new ErroParser(`ZIP: método de compressão ${metodo} não suportado (${nome})`);
    }
    if (conteudo.length > limite) throw new ErroParser(`ZIP: ${nome} excede o limite de descompressão`);
    if (conteudo.length !== descompactado) throw new ErroParser(`ZIP: tamanho divergente em ${nome}`);
    if (crc32(conteudo) !== crcEsperado) throw new ErroParser(`ZIP: CRC divergente em ${nome}`);
    orcamento -= conteudo.length;
    entradas.push({ nome, conteudo });
  }
  return entradas;
}
