import { crc32, deflateRawSync } from 'node:zlib';

export interface EntradaParaTeste {
  readonly nome: string;
  readonly conteudo: Buffer | string;
  readonly metodo?: 0 | 8;
  readonly flags?: number;
  readonly crc?: number;
  readonly tamanhoDeclarado?: number;
}

/** Monta um ZIP mínimo em memória, com campos manipuláveis para testar os limites do leitor. */
export function criarZip(entradas: readonly EntradaParaTeste[]): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;
  for (const e of entradas) {
    const dados = Buffer.isBuffer(e.conteudo) ? e.conteudo : Buffer.from(e.conteudo, 'utf8');
    const metodo = e.metodo ?? 8;
    const compactado = metodo === 8 ? deflateRawSync(dados) : dados;
    const nome = Buffer.from(e.nome, 'utf8');
    const flags = (e.flags ?? 0) | 0x800;
    const crc = e.crc ?? crc32(dados);
    const tamanho = e.tamanhoDeclarado ?? dados.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compactado.length, 18);
    local.writeUInt32LE(tamanho, 22);
    local.writeUInt16LE(nome.length, 26);
    locais.push(local, nome, compactado);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compactado.length, 20);
    central.writeUInt32LE(tamanho, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nome);
    deslocamento += local.length + nome.length + compactado.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, diretorio, fim]);
}
