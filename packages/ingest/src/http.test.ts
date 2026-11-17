import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buscarOficial, ErroColeta, sha256 } from './http.ts';
import { criarTransporteFalso } from './transporte-falso.ts';

const RTC = 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc';
const PDF = 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/nt-009.pdf';

async function erroDe(promessa: Promise<unknown>): Promise<ErroColeta> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof ErroColeta) return erro;
    throw erro;
  }
  throw new Error('esperava ErroColeta');
}

describe('buscarOficial', () => {
  it('devolve corpo, mime e sha256', async () => {
    const { transporte, chamadas } = criarTransporteFalso({
      [PDF]: { cabecalhos: { 'content-type': 'application/pdf' }, corpo: '%PDF-1.7 teste' },
    });
    const r = await buscarOficial(PDF, { transporte });
    expect(r.tipo).toBe('ok');
    if (r.tipo !== 'ok') return;
    expect(r.mime).toBe('application/pdf');
    expect(r.sha256).toBe(sha256(Buffer.from('%PDF-1.7 teste')));
    expect(chamadas[0]?.cabecalhos['accept-encoding']).toBe('identity');
    expect(chamadas[0]?.cabecalhos['user-agent']).toMatch(/^LastroBot\//);
  });

  it('recusa URL fora da lista sem fazer requisição', async () => {
    const { transporte, chamadas } = criarTransporteFalso({});
    const erro = await erroDe(buscarOficial('https://exemplo.com/x.pdf', { transporte }));
    expect(erro.codigo).toBe('origem-negada');
    expect(chamadas).toHaveLength(0);
  });

  it('segue redirecionamento dentro da lista', async () => {
    const destino = `${RTC}/nova`;
    const { transporte } = criarTransporteFalso({
      [RTC]: { status: 301, cabecalhos: { location: '/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/nova' } },
      [destino]: { cabecalhos: { 'content-type': 'text/html; charset=utf-8' }, corpo: '<html></html>' },
    });
    const r = await buscarOficial(RTC, { transporte });
    expect(r.urlFinal).toBe(destino);
    expect(r.saltos).toEqual([destino]);
  });

  it.each([
    'https://atacante.example/',
    'http://www.gov.br/nfse/pt-br',
    'https://169.254.169.254/latest/meta-data/',
    'https://www.gov.br/mre/pt-br',
  ])('recusa redirecionamento para %s antes de requisitar', async (destino) => {
    const { transporte, chamadas } = criarTransporteFalso({
      [RTC]: { status: 302, cabecalhos: { location: destino } },
    });
    const erro = await erroDe(buscarOficial(RTC, { transporte }));
    expect(erro.codigo).toBe('origem-negada');
    expect(chamadas).toHaveLength(1);
  });

  it('limita o número de redirecionamentos', async () => {
    const { transporte } = criarTransporteFalso({ [RTC]: { status: 302, cabecalhos: { location: RTC } } });
    const erro = await erroDe(buscarOficial(RTC, { transporte, maxRedirecionamentos: 3 }));
    expect(erro.codigo).toBe('redirecionamento');
  });

  it('recusa MIME fora da lista', async () => {
    const { transporte } = criarTransporteFalso({
      [PDF]: { cabecalhos: { 'content-type': 'application/x-msdownload' }, corpo: 'MZ' },
    });
    expect((await erroDe(buscarOficial(PDF, { transporte }))).codigo).toBe('mime-negado');
  });

  it('recusa content-length acima do limite', async () => {
    const { transporte } = criarTransporteFalso({
      [PDF]: { cabecalhos: { 'content-type': 'application/pdf', 'content-length': '999999999' }, corpo: 'x' },
    });
    expect((await erroDe(buscarOficial(PDF, { transporte, maxBytes: 1000 }))).codigo).toBe('tamanho-excedido');
  });

  it('interrompe o streaming quando o corpo passa do limite sem content-length', async () => {
    const { transporte } = criarTransporteFalso({
      [PDF]: { cabecalhos: { 'content-type': 'application/pdf' }, corpo: Buffer.alloc(10_000) },
    });
    expect((await erroDe(buscarOficial(PDF, { transporte, maxBytes: 4000 }))).codigo).toBe('tamanho-excedido');
  });

  it('descomprime gzip com teto de saída (bomba de descompressão)', async () => {
    const bomba = gzipSync(Buffer.alloc(5_000_000));
    const { transporte } = criarTransporteFalso({
      [PDF]: { cabecalhos: { 'content-type': 'application/pdf', 'content-encoding': 'gzip' }, corpo: bomba },
    });
    expect(bomba.length).toBeLessThan(100_000);
    expect((await erroDe(buscarOficial(PDF, { transporte, maxBytes: 100_000 }))).codigo).toBe('tamanho-excedido');
  });

  it('descomprime gzip legítimo e calcula o hash do conteúdo original', async () => {
    const { transporte } = criarTransporteFalso({
      [PDF]: { cabecalhos: { 'content-type': 'application/pdf', 'content-encoding': 'gzip' }, corpo: gzipSync('%PDF') },
    });
    const r = await buscarOficial(PDF, { transporte });
    expect(r.tipo === 'ok' && r.sha256).toBe(sha256(Buffer.from('%PDF')));
  });

  it('envia validadores e reconhece 304', async () => {
    const { transporte, chamadas } = criarTransporteFalso({
      [PDF]: (cab) => (cab['if-none-match'] === '"v1"' ? { status: 304 } : { status: 200 }),
    });
    const r = await buscarOficial(PDF, { transporte, condicional: { etag: '"v1"', ultimaModificacao: null } });
    expect(r.tipo).toBe('nao-modificado');
    expect(chamadas[0]?.cabecalhos['if-modified-since']).toBeUndefined();
  });

  it('transforma status de erro em ErroColeta com o status', async () => {
    const { transporte } = criarTransporteFalso({ [PDF]: { status: 403 } });
    const erro = await erroDe(buscarOficial(PDF, { transporte }));
    expect(erro.codigo).toBe('status-http');
    expect(erro.status).toBe(403);
  });
});
