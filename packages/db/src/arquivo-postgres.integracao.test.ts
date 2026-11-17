import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Fonte } from '@lastro/core';
import { CacheRobots, coletarFonte, LimitadorPorHost, sha256, type NovoSnapshot } from '@lastro/ingest';
import { criarTransporteFalso, type Rota } from '@lastro/ingest/testes';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArquivoPostgres } from './arquivo-postgres.ts';
import { configBanco, configS3 } from './config.ts';
import { ConsultasPostgres, ErroCursor } from './consultas.ts';
import { prepararBanco } from './migrar.ts';
import { StorageWorm } from './storage.ts';

const BANCO = 'lastro_teste';
const BUCKET = 'lastro-testes';
const ambiente = { ...process.env, LASTRO_PG_BANCO: BANCO, LASTRO_S3_BUCKET: BUCKET, LASTRO_S3_RETENCAO_DIAS: '1' };
const rodada = randomUUID();
const base = `https://www.gov.br/nfse/teste-integracao/${rodada}`;

let coletor: pg.Pool;
let leitor: pg.Pool;
let admin: pg.Pool;
let storage: StorageWorm;
let arquivo: ArquivoPostgres;
let s3: S3Client;

function novo(conteudo: string, url = `${base}/a.pdf`): NovoSnapshot {
  const corpo = Buffer.from(conteudo);
  const sha = sha256(corpo);
  return { fonteId: 'teste', url, urlFinal: url, mime: 'application/pdf', etag: null, ultimaModificacao: null, corpo, sha256: sha, impressao: sha };
}

beforeAll(async () => {
  const servidor = new pg.Client({ ...configBanco('admin', process.env), database: 'postgres' });
  await servidor.connect();
  const existe = await servidor.query('SELECT 1 FROM pg_database WHERE datname = $1', [BANCO]);
  if (existe.rowCount === 0) await servidor.query(`CREATE DATABASE ${servidor.escapeIdentifier(BANCO)}`);
  await servidor.end();

  await prepararBanco(configBanco('admin', ambiente), {
    coletor: configBanco('coletor', ambiente).password as string,
    leitor: configBanco('leitor', ambiente).password as string,
    notificador: configBanco('notificador', ambiente).password as string,
  });
  const cfgS3 = configS3(ambiente);
  storage = StorageWorm.criar(cfgS3);
  await storage.preparar(cfgS3.retencaoDias);
  s3 = new S3Client({
    endpoint: cfgS3.endpoint,
    region: cfgS3.regiao,
    forcePathStyle: true,
    credentials: { accessKeyId: cfgS3.accessKey, secretAccessKey: cfgS3.secretKey },
  });

  coletor = new pg.Pool(configBanco('coletor', ambiente));
  leitor = new pg.Pool(configBanco('leitor', ambiente));
  admin = new pg.Pool(configBanco('admin', ambiente));
  arquivo = new ArquivoPostgres(coletor, storage);
});

afterAll(async () => {
  await Promise.all([coletor.end(), leitor.end(), admin.end()]);
  storage.destruir();
  s3.destroy();
});

describe('ArquivoPostgres (Postgres + S3 WORM reais)', () => {
  it('grava, lê de volta e devolve o último snapshot', async () => {
    const v1 = await arquivo.gravarSnapshot(novo(`v1 ${rodada}`), new Date());
    const v2 = await arquivo.gravarSnapshot(novo(`v2 ${rodada}`), new Date(Date.now() + 1000));
    expect((await arquivo.ultimoSnapshot(`${base}/a.pdf`))?.id).toBe(v2.id);
    expect((await arquivo.lerConteudo(v1.sha256)).toString()).toBe(`v1 ${rodada}`);
  });

  it('mesmo conteúdo em duas URLs reutiliza o objeto já travado', async () => {
    const conteudo = `compartilhado ${rodada}`;
    await arquivo.gravarSnapshot(novo(conteudo, `${base}/x.pdf`), new Date());
    const segundo = await arquivo.gravarSnapshot(novo(conteudo, `${base}/y.pdf`), new Date());
    expect((await arquivo.lerConteudo(segundo.sha256)).toString()).toBe(conteudo);
  });

  it('recusa origem fora da lista antes de tocar storage ou banco', async () => {
    await expect(arquivo.gravarSnapshot(novo('x', 'https://blog.example/a.pdf'), new Date())).rejects.toThrow(/fora da lista/);
    const r = await leitor.query("SELECT count(*)::int AS n FROM documento WHERE url LIKE 'https://blog.example/%'");
    expect(r.rows[0]).toEqual({ n: 0 });
  });

  it('papel coletor não altera nem apaga histórico (privilégio)', async () => {
    await expect(coletor.query("UPDATE snapshot SET mime = 'x'")).rejects.toThrow(/permission denied/);
    await expect(coletor.query('DELETE FROM evento_mudanca')).rejects.toThrow(/permission denied/);
    await expect(coletor.query('TRUNCATE documento')).rejects.toThrow(/permission denied/);
  });

  it('nem o dono das tabelas altera histórico (trigger)', async () => {
    await expect(admin.query("UPDATE snapshot SET mime = 'x'")).rejects.toThrow(/apenas inserção/);
    await expect(admin.query('DELETE FROM documento')).rejects.toThrow(/apenas inserção/);
    await expect(admin.query('TRUNCATE verificacao_coleta')).rejects.toThrow(/apenas inserção/);
  });

  it('papel leitor só lê', async () => {
    await expect(leitor.query("INSERT INTO documento (fonte_id, url) VALUES ('x', 'https://www.gov.br/nfse/z')")).rejects.toThrow(
      /permission denied/,
    );
    await expect(leitor.query('SELECT count(*) FROM snapshot')).resolves.toBeDefined();
  });

  it('storage recusa sobrescrever e apagar objeto travado', async () => {
    const s = await arquivo.gravarSnapshot(novo(`worm ${rodada}`), new Date());
    const chave = storage.chave(s.sha256);
    await expect(
      s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: chave, Body: 'adulterado', IfNoneMatch: '*' })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    const versoes = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: chave }));
    const versao = versoes.Versions?.[0]?.VersionId;
    expect(versao).toBeDefined();
    await expect(s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: chave, VersionId: versao }))).rejects.toThrow(
      /retention|COMPLIANCE/i,
    );
    expect((await arquivo.lerConteudo(s.sha256)).toString()).toBe(`worm ${rodada}`);
  });

  it('guarda anomalia e devolve o último evento da URL', async () => {
    const url = `${base}/evento.pdf`;
    const comum = { fonteId: 'teste', url, snapshotAnterior: null, snapshotNovo: null, resumo: 'r' };
    await arquivo.registrarEvento({ ...comum, tipo: 'documento-novo', detectadoEm: '2026-11-16T10:00:00.000Z', anomalia: null });
    await arquivo.registrarEvento({
      ...comum,
      tipo: 'documento-indisponivel',
      detectadoEm: '2026-11-16T11:00:00.000Z',
      anomalia: 'texto encolheu',
    });
    const ultimo = await arquivo.ultimoEvento(url);
    expect(ultimo?.tipo).toBe('documento-indisponivel');
    expect(ultimo?.anomalia).toBe('texto encolheu');
    expect(await arquivo.ultimoEvento(`${base}/nunca-visto.pdf`)).toBeUndefined();
  });

  it('feed pagina por cursor sem perder nem repetir eventos com o mesmo horário', async () => {
    const fonteId = `pagina-${rodada.slice(0, 8)}`;
    const mesmoInstante = '2026-11-16T15:00:00.000Z';
    for (let i = 0; i < 7; i++) {
      await arquivo.registrarEvento({
        tipo: 'nova-versao',
        fonteId,
        url: `${base}/pagina-${String(i)}.pdf`,
        snapshotAnterior: null,
        snapshotNovo: null,
        detectadoEm: mesmoInstante,
        resumo: String(i),
        anomalia: i === 3 ? 'texto encolheu' : null,
      });
    }
    const consultas = new ConsultasPostgres(leitor);
    const vistos: string[] = [];
    let cursor: string | undefined;
    do {
      const pagina = await consultas.listarMudancas({ fonteId, limite: 3, cursor });
      vistos.push(...pagina.itens.map((m) => m.id));
      cursor = pagina.proximo ?? undefined;
    } while (cursor !== undefined);
    expect(vistos).toHaveLength(7);
    expect(new Set(vistos).size).toBe(7);

    const anomalas = await consultas.listarMudancas({ fonteId, anomalia: true, limite: 10 });
    expect(anomalas.itens.map((m) => m.resumo)).toEqual(['3']);
    await expect(consultas.listarMudancas({ limite: 1, cursor: 'nao-e-cursor' })).rejects.toThrow(ErroCursor);
  });

  it('coleta completa: segunda rodada sem mudança não gera evento', async () => {
    const semente = `${base}/pagina`;
    const fonte: Fonte = {
      id: 'teste-integracao',
      nome: 't',
      orgao: 't',
      nivel: 'N2',
      sementes: [semente],
      formatos: ['pdf'],
      colherDocumentos: true,
      frequenciaHoras: 1,
      slaHoras: 1,
      validadaNoCatalogo: true,
    };
    const rotas: Record<string, Rota> = {
      'https://www.gov.br/robots.txt': { status: 404 },
      [semente]: { cabecalhos: { 'content-type': 'text/html' }, corpo: `<main><a href="doc.pdf">doc</a> ${rodada}</main>` },
      [`${base}/doc.pdf`]: { cabecalhos: { 'content-type': 'application/pdf' }, corpo: `%PDF ${rodada}` },
    };
    const deps = () => {
      const { transporte } = criarTransporteFalso(rotas);
      return { transporte, arquivo, robots: new CacheRobots(transporte), limitador: new LimitadorPorHost(0) };
    };
    const primeira = await coletarFonte(fonte, deps());
    expect(primeira.eventos.map((e) => e.tipo)).toEqual(['documento-novo', 'documento-novo']);
    const segunda = await coletarFonte(fonte, deps());
    expect(segunda.eventos).toHaveLength(0);
    expect(segunda.urls.map((u) => u.situacao)).toEqual(['inalterado', 'inalterado']);

    const eventos = await arquivo.listarEventos(new Date(Date.now() - 60_000));
    expect(eventos.filter((e) => e.fonteId === 'teste-integracao' && e.url.startsWith(base))).toHaveLength(2);
  });
});
