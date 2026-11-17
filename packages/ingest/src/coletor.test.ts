import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fonte } from '@lastro/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArquivoEmDisco } from './arquivo.ts';
import { coletarFonte, type DependenciasColeta } from './coletor.ts';
import { LimitadorPorHost } from './limitador.ts';
import { CacheRobots } from './robots.ts';
import { criarTransporteFalso, type Rota } from './transporte-falso.ts';

const SEMENTE = 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc';
const DOC_A = 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/a.pdf';
const DOC_B = 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/b.xlsx';
const ROBOTS = 'https://www.gov.br/robots.txt';

const FONTE: Fonte = {
  id: 'nfse-rtc',
  nome: 'teste',
  orgao: 'SE/CGNFS-e',
  nivel: 'N2',
  sementes: [SEMENTE],
  formatos: ['pdf'],
  colherDocumentos: true,
  frequenciaHoras: 1,
  slaHoras: 1,
  validadaNoCatalogo: true,
};

function html(links: string[]): Rota {
  return {
    cabecalhos: { 'content-type': 'text/html; charset=utf-8' },
    corpo: `<html><body>${links.map((l) => `<a href="${l}">doc</a>`).join('')}<a href="https://blog.example/x.pdf">fora</a></body></html>`,
  };
}

const pdf = (conteudo: string): Rota => ({ cabecalhos: { 'content-type': 'application/pdf' }, corpo: conteudo });
const xlsx = (conteudo: string): Rota => ({
  cabecalhos: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  corpo: conteudo,
});

let raiz: string;
beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'lastro-coletor-'));
});
afterEach(async () => {
  await rm(raiz, { recursive: true, force: true });
});

function montar(rotas: Record<string, Rota>): { deps: DependenciasColeta; chamadas: { url: string }[] } {
  const { transporte, chamadas } = criarTransporteFalso(rotas);
  const deps: DependenciasColeta = {
    transporte,
    arquivo: new ArquivoEmDisco(raiz),
    robots: new CacheRobots(transporte),
    limitador: new LimitadorPorHost(0),
  };
  return { deps, chamadas };
}

describe('coletarFonte', () => {
  it('primeira coleta, coleta sem mudança e coleta com mudança', async () => {
    const rotas: Record<string, Rota> = {
      [ROBOTS]: { cabecalhos: { 'content-type': 'text/plain' }, corpo: 'User-agent: *\nAllow: /\n' },
      [SEMENTE]: html(['rtc/a.pdf', 'rtc/b.xlsx']),
      [DOC_A]: pdf('A v1'),
      [DOC_B]: { cabecalhos: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, corpo: 'B' },
    };

    const primeira = await coletarFonte(FONTE, montar(rotas).deps);
    expect(primeira.urls.map((u) => [u.url, u.situacao])).toEqual([
      [SEMENTE, 'documento-novo'],
      [DOC_A, 'documento-novo'],
      [DOC_B, 'documento-novo'],
    ]);
    expect(primeira.eventos.map((e) => e.tipo)).toEqual(['documento-novo', 'documento-novo', 'documento-novo']);

    const segunda = await coletarFonte(FONTE, montar(rotas).deps);
    expect(segunda.urls.every((u) => u.situacao === 'inalterado')).toBe(true);
    expect(segunda.eventos).toHaveLength(0);

    rotas[SEMENTE] = html(['rtc/a.pdf']);
    rotas[DOC_A] = pdf('A v2');
    const terceira = await coletarFonte(FONTE, montar(rotas).deps);
    expect(terceira.urls.map((u) => [u.url, u.situacao])).toEqual([
      [SEMENTE, 'nova-versao'],
      [DOC_A, 'nova-versao'],
    ]);
    expect(terceira.eventos.map((e) => [e.tipo, e.url])).toEqual([
      ['nova-versao', SEMENTE],
      ['link-removido', DOC_B],
      ['nova-versao', DOC_A],
    ]);
    const novaVersao = terceira.eventos.find((e) => e.url === DOC_A);
    expect(novaVersao?.snapshotAnterior).toBe(primeira.eventos.find((e) => e.url === DOC_A)?.snapshotNovo);
  });

  it('HTML com bytes diferentes e mesmo conteúdo não gera versão nova', async () => {
    const pagina = (token: string): Rota => ({
      cabecalhos: { 'content-type': 'text/html' },
      corpo: `<html><body><main>NT 009</main><script>var t='${token}';</script></body></html>`,
    });
    const rotas: Record<string, Rota> = { [ROBOTS]: { status: 404 }, [SEMENTE]: pagina('AAA') };
    expect((await coletarFonte(FONTE, montar(rotas).deps)).eventos).toHaveLength(1);

    rotas[SEMENTE] = pagina('BBB');
    const segunda = await coletarFonte(FONTE, montar(rotas).deps);
    expect(segunda.urls[0]?.situacao).toBe('inalterado');
    expect(segunda.eventos).toHaveLength(0);
  });

  it('nunca requisita link de documento fora da lista oficial', async () => {
    const { deps, chamadas } = montar({
      [ROBOTS]: { status: 404 },
      [SEMENTE]: html([]),
    });
    await coletarFonte(FONTE, deps);
    expect(chamadas.map((c) => c.url)).not.toContain('https://blog.example/x.pdf');
  });

  it('respeita robots.txt sem requisitar a página bloqueada', async () => {
    const { deps, chamadas } = montar({
      [ROBOTS]: { cabecalhos: { 'content-type': 'text/plain' }, corpo: 'User-agent: *\nDisallow: /nfse/\n' },
      [SEMENTE]: html([]),
    });
    const r = await coletarFonte(FONTE, deps);
    expect(r.urls[0]?.situacao).toBe('bloqueado-robots');
    expect(chamadas.map((c) => c.url)).toEqual([ROBOTS]);
  });

  it('registra erro de coleta sem derrubar a rodada', async () => {
    const { deps } = montar({
      [ROBOTS]: { status: 404 },
      [SEMENTE]: html(['rtc/a.pdf', 'rtc/b.xlsx']),
      [DOC_A]: { status: 500 },
      [DOC_B]: xlsx('B'),
    });
    const r = await coletarFonte(FONTE, deps);
    expect(r.urls.map((u) => u.situacao)).toEqual(['documento-novo', 'erro', 'documento-novo']);
    expect(r.urls[1]?.detalhe).toContain('HTTP 500');
  });

  it('aplica o teto de documentos por rodada', async () => {
    const { deps } = montar({
      [ROBOTS]: { status: 404 },
      [SEMENTE]: html(['rtc/a.pdf', 'rtc/b.xlsx']),
      [DOC_A]: pdf('A'),
      [DOC_B]: pdf('B'),
    });
    const r = await coletarFonte(FONTE, deps, { maxDocumentos: 1 });
    expect(r.urls.map((u) => u.situacao)).toEqual(['documento-novo', 'documento-novo', 'erro']);
  });

  it('documento despublicado gera um evento de indisponível, e um de restabelecido quando volta', async () => {
    const rotas: Record<string, Rota> = {
      [ROBOTS]: { status: 404 },
      [SEMENTE]: html(['rtc/a.pdf']),
      [DOC_A]: pdf('A v1'),
    };
    await coletarFonte(FONTE, montar(rotas).deps);

    rotas[DOC_A] = { status: 302, cabecalhos: { location: `${SEMENTE}/login` } };
    rotas[`${SEMENTE}/login`] = { cabecalhos: { 'content-type': 'text/html' }, corpo: '<h2>Site Error</h2> Unauthorized' };
    const fora = await coletarFonte(FONTE, montar(rotas).deps);
    expect(fora.eventos.map((e) => [e.tipo, e.url])).toEqual([['documento-indisponivel', DOC_A]]);

    const aindaFora = await coletarFonte(FONTE, montar(rotas).deps);
    expect(aindaFora.eventos).toHaveLength(0);

    rotas[DOC_A] = pdf('A v1');
    const volta = await coletarFonte(FONTE, montar(rotas).deps);
    expect(volta.eventos.map((e) => e.tipo)).toEqual(['documento-restabelecido']);
  });

  it('erro 5xx é instabilidade, não indisponibilidade', async () => {
    const rotas: Record<string, Rota> = { [ROBOTS]: { status: 404 }, [SEMENTE]: html(['rtc/a.pdf']), [DOC_A]: pdf('A') };
    await coletarFonte(FONTE, montar(rotas).deps);
    rotas[DOC_A] = { status: 503 };
    expect((await coletarFonte(FONTE, montar(rotas).deps)).eventos).toHaveLength(0);
  });

  it('marca como anomalia a semente que vira página de manutenção', async () => {
    const docs = ['rtc/a.pdf', 'rtc/b.xlsx', 'rtc/c.pdf'];
    const conteudo = `<html><body><main><p>${'Documentação técnica da reforma. '.repeat(20)}</p>${docs.map((d) => `<a href="${d}">d</a>`).join('')}</main></body></html>`;
    const rotas: Record<string, Rota> = {
      [ROBOTS]: { status: 404 },
      [SEMENTE]: { cabecalhos: { 'content-type': 'text/html' }, corpo: conteudo },
    };
    await coletarFonte(FONTE, montar(rotas).deps, { colherDocumentos: false });

    rotas[SEMENTE] = { cabecalhos: { 'content-type': 'text/html' }, corpo: '<main>Sistema em Manutenção Programada</main>' };
    const r = await coletarFonte(FONTE, montar(rotas).deps, { colherDocumentos: false });
    const novaVersao = r.eventos.find((e) => e.tipo === 'nova-versao');
    expect(novaVersao?.anomalia).toContain('texto encolheu');
    expect(novaVersao?.anomalia).toContain('3 de 3 links');
  });

  it('página de manutenção (200 + HTML) no lugar do PDF não vira versão nova (caso real do INLABS)', async () => {
    const rotas: Record<string, Rota> = {
      [ROBOTS]: { status: 404 },
      [SEMENTE]: html(['rtc/a.pdf']),
      [DOC_A]: pdf('A v1'),
    };
    await coletarFonte(FONTE, montar(rotas).deps);

    rotas[DOC_A] = { cabecalhos: { 'content-type': 'text/html' }, corpo: '<h1>Sistema em Manutenção Programada</h1>' };
    const r = await coletarFonte(FONTE, montar(rotas).deps);
    expect(r.urls.find((u) => u.url === DOC_A)?.detalhe).toContain('mime-negado');
    expect(r.eventos.map((e) => e.tipo)).toEqual(['documento-indisponivel']);
  });
});
