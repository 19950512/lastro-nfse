import type { Fonte } from '@lastro/core';
import { ErroCursor, type ConsultasArquivo, type Mudanca, type SnapshotParaDownload } from '@lastro/db';
import { describe, expect, it } from 'vitest';
import { construirApp, type DependenciasApi, type OpcoesApi } from './app.ts';
import { alertasFalsos, autenticadorFalso, CHAVE_LEITURA, conhecimentoFalso, contasFalsas, fatosFalsos, perguntasFalsas, verificacoesFalsas } from './falsos.ts';
import type { InjectOptions } from 'fastify';
import { DetalheDocumento, ListaFontes, PaginaDocumentos, PaginaMudancas } from './esquemas.ts';

const DOC = '11111111-1111-4111-8111-111111111111';
const SNAP_PDF = '22222222-2222-4222-8222-222222222222';
const SNAP_HTML = '33333333-3333-4333-8333-333333333333';

const mudanca: Mudanca = {
  id: '44444444-4444-4444-8444-444444444444',
  tipo: 'nova-versao',
  fonteId: 'nfse-rtc',
  documentoId: DOC,
  url: 'https://www.gov.br/nfse/pt-br/rtc/nt-009.pdf',
  snapshotAnterior: null,
  snapshotNovo: SNAP_PDF,
  detectadoEm: '2026-11-16T12:00:00.000Z',
  resumo: 'Conteúdo mudou',
  anomalia: null,
  fatoId: null,
};

const snapshots: Record<string, SnapshotParaDownload> = {
  [SNAP_PDF]: { id: SNAP_PDF, documentoId: DOC, url: mudanca.url, sha256: 'a'.repeat(64), mime: 'application/pdf', bytes: 4, coletadoEm: '2026-11-16T12:00:00.000Z' },
  [SNAP_HTML]: { id: SNAP_HTML, documentoId: DOC, url: mudanca.url, sha256: 'b'.repeat(64), mime: 'text/html', bytes: 30, coletadoEm: '2026-11-16T12:00:00.000Z' },
};

const FONTES: Fonte[] = [
  { id: 'nfse-rtc', nome: 'RTC', orgao: 'SE/CGNFS-e', nivel: 'N2', sementes: ['https://www.gov.br/nfse/pt-br/rtc'], formatos: ['pdf'], colherDocumentos: true, frequenciaHoras: 3, slaHoras: 6, validadaNoCatalogo: true },
  { id: 'nfse-faq', nome: 'FAQ', orgao: 'CGNFS-e', nivel: 'N3', sementes: ['https://www.gov.br/nfse/pt-br/faq'], formatos: ['html'], colherDocumentos: false, frequenciaHoras: 24, slaHoras: 24, validadaNoCatalogo: true },
];

function consultas(sobrepor: Partial<ConsultasArquivo> = {}): ConsultasArquivo {
  return {
    listarMudancas: (f) => {
      if (f.cursor === 'ruim') throw new ErroCursor();
      return Promise.resolve({ itens: [mudanca], proximo: 'proximo-cursor' });
    },
    listarDocumentos: () =>
      Promise.resolve({
        itens: [{ id: DOC, fonteId: 'nfse-rtc', url: mudanca.url, versoes: 2, ultimaVersaoEm: mudanca.detectadoEm, ultimaVerificacaoEm: null, mime: 'application/pdf', situacao: 'disponivel' as const }],
        proximo: null,
      }),
    obterDocumento: (id) =>
      Promise.resolve(
        id === DOC
          ? {
              id: DOC,
              fonteId: 'nfse-rtc',
              url: mudanca.url,
              versoes: 1,
              ultimaVersaoEm: mudanca.detectadoEm,
              ultimaVerificacaoEm: null,
              mime: 'application/pdf',
              situacao: 'disponivel' as const,
              criadoEm: mudanca.detectadoEm,
              historico: [{ id: SNAP_PDF, coletadoEm: mudanca.detectadoEm, sha256: 'a'.repeat(64), bytes: 4, mime: 'application/pdf', urlFinal: mudanca.url }],
              eventos: [mudanca],
            }
          : undefined,
      ),
    obterSnapshot: (id) => Promise.resolve(snapshots[id]),
    resumoFontes: () =>
      Promise.resolve([{ fonteId: 'nfse-rtc', documentos: 21, ultimaVersaoEm: '2026-11-16T11:00:00.000Z', ultimaVerificacaoEm: null }]),
    ...sobrepor,
  };
}

function app(sobrepor: Partial<ConsultasArquivo> = {}, extras: Partial<DependenciasApi> = {}, opcoes: OpcoesApi = { painel: true }) {
  const instancia = construirApp(
    {
      consultas: consultas(sobrepor),
      lerOriginal: (sha) => Promise.resolve(Buffer.from(sha.startsWith('a') ? '%PDF' : '<script>alert(1)</script>')),
      fontes: FONTES,
      agora: () => new Date('2026-11-16T14:00:00.000Z'),
      autenticacao: autenticadorFalso,
      conhecimento: conhecimentoFalso,
      perguntas: perguntasFalsas,
      fatos: fatosFalsos,
      verificacoes: verificacoesFalsas,
      contas: contasFalsas,
      alertas: alertasFalsos,
      ...extras,
    },
    opcoes,
  );
  return {
    inject: (op: string | InjectOptions) =>
      instancia.inject(
        typeof op === 'string'
          ? { url: op, headers: { authorization: `Bearer ${CHAVE_LEITURA}` } }
          : { ...op, headers: { authorization: `Bearer ${CHAVE_LEITURA}`, ...op.headers } },
      ),
  };
}

describe('API /v1', () => {
  it('feed de mudanças segue o schema publicado', async () => {
    const r = await app().inject('/v1/mudancas?desde=2026-11-01&tipo=nova-versao,documento-indisponivel&limite=10');
    expect(r.statusCode).toBe(200);
    const corpo = PaginaMudancas.parse(r.json());
    expect(corpo.mudancas[0]?.links).toEqual({ documento: `/v1/documentos/${DOC}`, original: `/v1/snapshots/${SNAP_PDF}/original`, fato: null });
    expect(corpo.mudancas[0]?.fato_id).toBeNull();
    expect(corpo.proximo).toBe('proximo-cursor');
  });

  it('passa os filtros convertidos para a consulta', async () => {
    let recebido: unknown;
    const r = await app({
      listarMudancas: (f) => {
        recebido = f;
        return Promise.resolve({ itens: [], proximo: null });
      },
    }).inject('/v1/mudancas?desde=2026-11-01&fonte=cgibs&anomalia=true');
    expect(r.statusCode).toBe(200);
    expect(recebido).toMatchObject({ fonteId: 'cgibs', anomalia: true, limite: 100, desde: new Date('2026-11-01T03:00:00.000Z') });
  });

  it.each([
    ['/v1/mudancas?tipo=apagado', 'tipo'],
    ['/v1/mudancas?limite=1000', 'limite'],
    ['/v1/mudancas?desde=ontem', 'desde'],
    ['/v1/mudancas?fonte=../../etc', 'fonte'],
    ['/v1/mudancas?extra=1', '(consulta)'],
  ])('recusa %s', async (url, campo) => {
    const r = await app().inject(url);
    expect(r.statusCode).toBe(400);
    const campos = r.json<{ detalhes: { campo: string }[] }>().detalhes.map((d) => d.campo);
    expect(campos.some((c) => c === campo || c.startsWith(`${campo}.`))).toBe(true);
  });

  it('cursor adulterado vira 400', async () => {
    expect((await app().inject('/v1/mudancas?cursor=ruim')).statusCode).toBe(400);
  });

  it('erro interno não vaza mensagem', async () => {
    const r = await app({ resumoFontes: () => Promise.reject(new Error('senha=segredo no host db-interno')) }).inject('/v1/fontes');
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('segredo');
    expect(r.json()).toEqual({ erro: 'interno' });
  });

  it('fontes marcam atraso pelo SLA', async () => {
    const corpo = ListaFontes.parse((await app().inject('/v1/fontes')).json());
    expect(corpo.fontes.find((f) => f.id === 'nfse-rtc')?.atrasada).toBe(false);
    expect(corpo.fontes.find((f) => f.id === 'nfse-faq')?.atrasada).toBe(true);
  });

  it('documentos e detalhe seguem os schemas', async () => {
    PaginaDocumentos.parse((await app().inject('/v1/documentos?fonte=nfse-rtc')).json());
    const detalhe = DetalheDocumento.parse((await app().inject(`/v1/documentos/${DOC}`)).json());
    expect(detalhe.historico[0]?.original).toBe(`/v1/snapshots/${SNAP_PDF}/original`);
    expect((await app().inject('/v1/documentos/55555555-5555-4555-8555-555555555555')).statusCode).toBe(404);
    expect((await app().inject('/v1/documentos/nao-e-uuid')).statusCode).toBe(400);
  });

  it('cabeçalhos de segurança em toda resposta e nenhum CORS', async () => {
    const r = await app().inject('/v1/saude');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app().inject({ method: 'OPTIONS', url: '/v1/mudancas', headers: { origin: 'https://atacante.example' } });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('original em PDF sai como anexo com hash', async () => {
    const r = await app().inject(`/v1/snapshots/${SNAP_PDF}/original`);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="lastro-a{16}\.pdf"$/);
    expect(r.headers['x-lastro-sha256']).toBe('a'.repeat(64));
  });

  it('HTML arquivado nunca é servido como HTML (XSS armazenado)', async () => {
    const r = await app().inject(`/v1/snapshots/${SNAP_HTML}/original`);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment;/);
    expect(r.headers['content-security-policy']).toContain('sandbox');
  });

  it('não aceita métodos de escrita', async () => {
    expect((await app().inject({ method: 'POST', url: '/v1/mudancas' })).statusCode).toBe(404);
    expect((await app().inject({ method: 'DELETE', url: `/v1/documentos/${DOC}` })).statusCode).toBe(404);
  });

  it('publica OpenAPI com as rotas', async () => {
    const doc = (await app().inject('/v1/openapi.json')).json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/mudancas', '/v1/fontes', '/v1/documentos', '/v1/documentos/{id}', '/v1/snapshots/{id}/original']),
    );
  });
});

describe('painel', () => {
  it('escapa conteúdo vindo das fontes e não permite script', async () => {
    const malicioso: Mudanca = {
      ...mudanca,
      url: 'https://www.gov.br/nfse/"><script>alert(1)</script>',
      resumo: '<img src=x onerror=alert(1)>',
      anomalia: '<b>texto encolheu</b>',
    };
    const r = await app({ listarMudancas: () => Promise.resolve({ itens: [malicioso], proximo: null }) }).inject('/painel');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).not.toContain('script-src');
    expect(r.body).not.toContain('<script>alert');
    expect(r.body).not.toContain('<img src=x');
    expect(r.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(r.body).toContain('revisão: &lt;b&gt;texto encolheu&lt;/b&gt;');
  });

  it('mostra documento com versões e link de download', async () => {
    const r = await app().inject(`/painel/documentos/${DOC}`);
    expect(r.body).toContain(`/painel/snapshots/${SNAP_PDF}/original`);
    expect(r.headers['content-type']).toContain('text/html');
  });

  it('lista documentos e serve CSS', async () => {
    expect((await app().inject('/painel/documentos?fonte=nfse-rtc')).statusCode).toBe(200);
    expect((await app().inject('/painel/estilo.css')).headers['content-type']).toContain('text/css');
  });
});
