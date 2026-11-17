import { describe, expect, it } from 'vitest';
import { ErroParser } from './erro.ts';
import { LIMITES_ZIP_PADRAO, lerZip } from './zip.ts';
import { criarZip } from './zip-para-teste.ts';

const limites = (sobrepor: Partial<typeof LIMITES_ZIP_PADRAO>) => ({ ...LIMITES_ZIP_PADRAO, ...sobrepor });

describe('lerZip', () => {
  it('lê entradas armazenadas e comprimidas e ignora diretórios', () => {
    const zip = criarZip([
      { nome: 'pasta/', conteudo: '', metodo: 0 },
      { nome: 'pasta/a.xsd', conteudo: '<a/>', metodo: 0 },
      { nome: 'b.txt', conteudo: 'olá '.repeat(100) },
    ]);
    const entradas = lerZip(zip);
    expect(entradas.map((e) => e.nome)).toEqual(['pasta/a.xsd', 'b.txt']);
    expect(entradas[1]?.conteudo.toString('utf8')).toBe('olá '.repeat(100));
  });

  it('recusa zip bomb acima do limite por arquivo', () => {
    const zip = criarZip([{ nome: 'bomba.xml', conteudo: Buffer.alloc(20 * 1024 * 1024) }]);
    expect(zip.length).toBeLessThan(100_000);
    expect(() => lerZip(zip, limites({ maxBytesPorArquivo: 1024 * 1024 }))).toThrow(ErroParser);
  });

  it('recusa zip bomb que mente o tamanho no cabeçalho, interrompendo a descompressão no limite', () => {
    const zip = criarZip([{ nome: 'bomba.xml', conteudo: Buffer.alloc(20 * 1024 * 1024), tamanhoDeclarado: 10 }]);
    expect(() => lerZip(zip, limites({ maxBytesPorArquivo: 1024 * 1024 }))).toThrow(/limite de descompressão/);
  });

  it('aplica o orçamento total somando todas as entradas', () => {
    const zip = criarZip([
      { nome: 'a', conteudo: Buffer.alloc(600_000) },
      { nome: 'b', conteudo: Buffer.alloc(600_000) },
    ]);
    expect(() => lerZip(zip, limites({ maxBytesDescompactados: 1_000_000 }))).toThrow(ErroParser);
    expect(lerZip(zip, limites({ maxBytesDescompactados: 1_200_000 }))).toHaveLength(2);
  });

  it.each(['../fora.xsd', 'a/../../fora.xsd', '/etc/passwd', 'C:/Windows/x', 'a\\..\\b', 'nul\0x'])('recusa nome perigoso (zip slip): %j', (nome) => {
    expect(() => lerZip(criarZip([{ nome, conteudo: 'x' }]))).toThrow(ErroParser);
  });

  it('recusa mais entradas que o limite', () => {
    const zip = criarZip(Array.from({ length: 5 }, (_, i) => ({ nome: `f${i}`, conteudo: 'x' })));
    expect(() => lerZip(zip, limites({ maxArquivos: 4 }))).toThrow(/entradas/);
  });

  it('recusa CRC divergente', () => {
    expect(() => lerZip(criarZip([{ nome: 'a', conteudo: 'abc', crc: 123 }]))).toThrow(/CRC/);
  });

  it('recusa entrada cifrada', () => {
    expect(() => lerZip(criarZip([{ nome: 'a', conteudo: 'abc', flags: 0x1 }]))).toThrow(/cifrada/);
  });

  it('recusa arquivo que não é ZIP ou está truncado', () => {
    expect(() => lerZip(Buffer.from('isto não é um zip, só texto qualquer'))).toThrow(ErroParser);
    const zip = criarZip([{ nome: 'a', conteudo: 'abc'.repeat(100) }]);
    const truncado = Buffer.concat([zip.subarray(0, 20), zip.subarray(zip.length - 22)]);
    expect(() => lerZip(truncado)).toThrow(ErroParser);
  });
});
