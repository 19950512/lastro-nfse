import { randomUUID } from 'node:crypto';
import {
  ArquivoPostgres,
  ConsultasPostgres,
  configBanco,
  configS3,
  criarCliente,
  criarCurador,
  CuradoriaPostgres,
  prepararInfra,
  processarPendentes,
  StorageWorm,
} from '@lastro/db';
import { sha256, type NovoSnapshot } from '@lastro/ingest';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertasPostgres, ErroLimiteAlertas } from './alertas.ts';
import { ErroAssinatura } from './assinaturas.ts';
import { despachar } from './despacho.ts';
import type { Enviador } from './envio.ts';

const ambiente = { ...process.env, LASTRO_PG_BANCO: 'lastro_teste', LASTRO_S3_BUCKET: 'lastro-testes', LASTRO_S3_RETENCAO_DIAS: '1' };
const rodada = randomUUID();
const marca = `zq${rodada.slice(0, 8)}`;
const base = `https://www.cgibs.gov.br/teste-fase4/${rodada}`;
const URL_API = 'https://api.lastro.example';
const IP_PUBLICO = () => Promise.resolve(['200.152.38.155']);

let admin: pg.Pool;
let api: pg.Pool;
let notificador: pg.Pool;
let coletor: pg.Pool;
let processador: pg.Pool;
let curadoriaPool: pg.Pool;
let storage: StorageWorm;
let arquivo: ArquivoPostgres;
let alertas: AlertasPostgres;
let clienteA = '';
let clienteB = '';

function html(corpo: string, url: string): NovoSnapshot {
  const bytes = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><main>${corpo}</main></body></html>`);
  const sha = sha256(bytes);
  return { fonteId: 'cgibs', url, urlFinal: url, mime: 'text/html', etag: null, ultimaModificacao: null, corpo: bytes, sha256: sha, impressao: `html:${sha}` };
}

const enviados: { url: string; corpo: Record<string, unknown> }[] = [];
const enviador: Enviador = (url, corpo) => {
  enviados.push({ url, corpo: JSON.parse(corpo) as Record<string, unknown> });
  return Promise.resolve({ ok: true, status: 204, erro: null });
};
const recebidosPor = (id: string) => enviados.filter((e) => (e.corpo.alerta as { id?: string } | undefined)?.id === id);

beforeAll(async () => {
  const servidor = new pg.Client({ ...configBanco('admin', process.env), database: 'postgres' });
  await servidor.connect();
  if ((await servidor.query("SELECT 1 FROM pg_database WHERE datname = 'lastro_teste'")).rowCount === 0) await servidor.query('CREATE DATABASE lastro_teste');
  await servidor.end();
  await prepararInfra(ambiente);
  admin = new pg.Pool(configBanco('admin', ambiente));
  api = new pg.Pool(configBanco('api', ambiente));
  notificador = new pg.Pool(configBanco('notificador', ambiente));
  coletor = new pg.Pool(configBanco('coletor', ambiente));
  processador = new pg.Pool(configBanco('processador', ambiente));
  curadoriaPool = new pg.Pool(configBanco('curadoria', ambiente));
  storage = StorageWorm.criar(configS3(ambiente));
  arquivo = new ArquivoPostgres(coletor, storage);
  alertas = new AlertasPostgres(api, new Set(['cgibs', 'nfse-rtc']), IP_PUBLICO);
  clienteA = await criarCliente(admin, { nome: `Alertas A ${marca}`, maxAlertas: 3 });
  clienteB = await criarCliente(admin, { nome: `Alertas B ${marca}` });
});

afterAll(async () => {
  await Promise.all([admin.end(), api.end(), notificador.end(), coletor.end(), processador.end(), curadoriaPool.end()]);
  storage.destruir();
});

describe('alertas do cliente (RLS)', () => {
  it('cria, lista e remove só os próprios; segredo nunca é lido pela API; limite do plano vale', async () => {
    const criado = await alertas.criar(clienteA, { nome: 'Prazos', url: 'https://hooks.cliente.example/a', formato: 'lastro', termos: [' prazo ', 'prazo'] }, 3);
    expect(criado.segredo).toMatch(/^[0-9a-f]{64}$/);
    const lista = await alertas.listar(clienteA);
    expect(lista.map((a) => a.id)).toContain(criado.id);
    expect(lista.find((a) => a.id === criado.id)).toMatchObject({ nome: 'Prazos', termos: ['prazo'], temas: null, ativo: true });
    expect(await alertas.listar(clienteB)).toEqual([]);
    expect(await alertas.remover(clienteB, criado.id)).toBe(false);

    const c = await api.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('lastro.cliente_id', $1, true)", [clienteA]);
      await expect(c.query('SELECT segredo FROM webhook_assinatura')).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((await api.query('SELECT count(*)::int AS n FROM webhook_assinatura')).rows[0]).toEqual({ n: 0 });

    await alertas.criar(clienteA, { nome: 'Dois', url: 'https://hooks.cliente.example/b', formato: 'slack' }, 3);
    await alertas.criar(clienteA, { nome: 'Três', url: 'https://hooks.cliente.example/c', formato: 'lastro' }, 3);
    await expect(alertas.criar(clienteA, { nome: 'Quatro', url: 'https://hooks.cliente.example/d', formato: 'lastro' }, 3)).rejects.toBeInstanceOf(ErroLimiteAlertas);
    expect(await alertas.remover(clienteA, criado.id)).toBe(true);
    await alertas.criar(clienteA, { nome: 'Quatro', url: 'https://hooks.cliente.example/d', formato: 'lastro' }, 3);
    await admin.query("UPDATE webhook_assinatura SET ativa = false WHERE cliente_id = $1", [clienteA]);
  });

  it('valida destino, termos e temas antes de gravar', async () => {
    const novo = { nome: 'x', url: 'https://hooks.cliente.example/a', formato: 'lastro' as const };
    await expect(alertas.criar(clienteA, { ...novo, url: 'http://hooks.cliente.example/a' }, 3)).rejects.toBeInstanceOf(ErroAssinatura);
    await expect(new AlertasPostgres(api, new Set(), () => Promise.resolve(['10.0.0.8'])).criar(clienteA, novo, 3)).rejects.toThrow(/não público/);
    await expect(alertas.criar(clienteA, { ...novo, termos: ['x'] }, 3)).rejects.toThrow(/2 a 100/);
    await expect(alertas.criar(clienteA, { ...novo, temas: ['Tema Ruim'] }, 3)).rejects.toThrow(/tema/);
    await expect(alertas.criar(clienteA, { ...novo, fontes: ['fonte-desconhecida'] }, 3)).rejects.toThrow(/fontes desconhecidas/);
  });
});

describe('despacho de alertas por tema', () => {
  it('termo casa só com o texto que entrou na versão nova; tema casa com fato aprovado e com o documento que o sustenta', async () => {
    const urlDoc = `${base}/cronograma.html`;
    // why: com três artigos ou mais o texto é tratado como legal e cada artigo vira um trecho (comparação por artigo).
    const VIGOR = '<p>Art. 4º Esta resolução entra em vigor na data de sua publicação.</p>';
    const antes = new Date(Date.now() - 60_000);
    const v1 = await arquivo.gravarSnapshot(html(`<p>Art. 1º O emissor ${marca} vale para todos.</p><p>Art. 2º Disposição sobre cronograma antigo ${marca}.</p>${VIGOR}`, urlDoc), antes);
    await processarPendentes({ pool: processador, lerOriginal: (sha) => storage.ler(sha) }, { limite: 1000 });

    const porTermo = await alertas.criar(clienteB, { nome: 'Termo novo', url: 'https://hooks.cliente.example/t1', formato: 'lastro', termos: [`prazo ${marca}`] }, 10);
    const termoAntigo = await alertas.criar(clienteB, { nome: 'Termo antigo', url: 'https://hooks.cliente.example/t2', formato: 'lastro', termos: [`cronograma antigo ${marca}`] }, 10);
    await alertas.criar(clienteB, { nome: 'Tema', url: 'https://hooks.cliente.example/t3', formato: 'slack', temas: [`tema-${marca}`] }, 10);
    const outraFonte = await alertas.criar(clienteB, { nome: 'Outra fonte', url: 'https://hooks.cliente.example/t4', formato: 'lastro', fontes: ['nfse-rtc'], termos: [`prazo ${marca}`] }, 10);

    const v2 = await arquivo.gravarSnapshot(
      html(
        `<p>Art. 1º O emissor ${marca} vale para todos.</p><p>Art. 2º Disposição sobre cronograma antigo ${marca}.</p><p>Art. 3º O novo prazo ${marca} passa a valer em 1º de março de 2027.</p>${VIGOR}`,
        urlDoc,
      ),
      new Date(),
    );
    await arquivo.registrarEvento({
      tipo: 'nova-versao',
      fonteId: 'cgibs',
      url: urlDoc,
      snapshotAnterior: v1.id,
      snapshotNovo: v2.id,
      detectadoEm: new Date().toISOString(),
      resumo: 'teste',
      anomalia: null,
    });

    // invariant: antes de processar não há trechos da versão nova, então nenhum alerta por termo dispara ainda.
    await despachar(notificador, enviador, { urlPublicaApi: URL_API });
    expect(recebidosPor(porTermo.id)).toHaveLength(0);

    await processarPendentes({ pool: processador, lerOriginal: (sha) => storage.ler(sha) }, { limite: 1000 });
    await despachar(notificador, enviador, { urlPublicaApi: URL_API });
    expect(recebidosPor(porTermo.id)).toHaveLength(1);
    expect(recebidosPor(porTermo.id)[0]?.corpo).toMatchObject({ tipo: 'nova-versao', alerta: { nome: 'Termo novo' }, links: { documento: expect.stringContaining('/v1/documentos/') as string } });
    expect(recebidosPor(termoAntigo.id)).toHaveLength(0);
    expect(recebidosPor(outraFonte.id)).toHaveLength(0);
    expect(enviados.filter((e) => e.url === 'https://hooks.cliente.example/t3')).toHaveLength(0);

    const curadoria = new CuradoriaPostgres(curadoriaPool);
    const ana = await criarCurador(admin, { emissor: 'https://sso.lastro.example', sujeito: `ana4-${rodada}`, nome: 'Ana', papel: 'curador' });
    const bia = await criarCurador(admin, { emissor: 'https://sso.lastro.example', sujeito: `bia4-${rodada}`, nome: 'Bia', papel: 'curador' });
    const chefe = await criarCurador(admin, { emissor: 'https://sso.lastro.example', sujeito: `chefe4-${rodada}`, nome: 'Chefe', papel: 'supervisor' });
    const trecho = await admin.query<{ id: string }>('SELECT id FROM trecho WHERE snapshot_id = $1 AND texto LIKE $2', [v2.id, `%novo prazo ${marca}%`]);
    const fato = await curadoria.proporFato(ana, {
      tipo: 'prazo',
      tema: `tema-${marca}`,
      enunciado: `O novo prazo ${marca} começa em 01/03/2027.`,
      publico: null,
      dataEfeito: '2027-03-01',
      evidenciaTrechoId: trecho.rows[0]?.id ?? '',
      evidenciaTexto: `O novo prazo ${marca} passa a valer`,
      substitui: null,
    });
    await curadoria.decidir(bia, 'fato', fato, 'aprovar', null);
    expect((await admin.query("SELECT count(*)::int AS n FROM evento_mudanca WHERE fato_id = $1", [fato])).rows[0]).toEqual({ n: 0 });
    await curadoria.decidir(chefe, 'fato', fato, 'aprovar', null);
    const ev = await admin.query<{ tipo: string; resumo: string }>('SELECT tipo, resumo FROM evento_mudanca WHERE fato_id = $1', [fato]);
    expect(ev.rows).toEqual([{ tipo: 'fato-aprovado', resumo: expect.stringContaining(`tema-${marca}`) as string }]);

    const feed = await new ConsultasPostgres(api).listarMudancas({ tipos: ['fato-aprovado'], limite: 500 });
    expect(feed.itens.find((m) => m.fatoId === fato)).toMatchObject({ tipo: 'fato-aprovado', url: urlDoc });

    await despachar(notificador, enviador, { urlPublicaApi: URL_API });
    const doTema = enviados.filter((e) => e.url === 'https://hooks.cliente.example/t3').map((e) => String(e.corpo.text));
    expect(doTema).toHaveLength(1);
    expect(doTema[0]).toContain('[Tema] Fato aprovado pela curadoria');
    expect(doTema[0]).toContain(`/v1/fatos/${fato}`);
    expect(recebidosPor(porTermo.id).map((e) => e.corpo.tipo)).toEqual(['nova-versao', 'fato-aprovado']);
    expect(recebidosPor(porTermo.id)[1]?.corpo).toMatchObject({ fato_id: fato, links: { fato: `${URL_API}/v1/fatos/${fato}` } });

    const v3 = await arquivo.gravarSnapshot(html(`<p>Art. 1º O emissor ${marca} vale para todos, exceto MEI.</p><p>Art. 3º O novo prazo ${marca} passa a valer em 1º de março de 2027.</p>${VIGOR}`, urlDoc), new Date(Date.now() + 1000));
    await arquivo.registrarEvento({ tipo: 'nova-versao', fonteId: 'cgibs', url: urlDoc, snapshotAnterior: v2.id, snapshotNovo: v3.id, detectadoEm: new Date(Date.now() + 1000).toISOString(), resumo: 'teste', anomalia: null });
    await processarPendentes({ pool: processador, lerOriginal: (sha) => storage.ler(sha) }, { limite: 1000 });
    await despachar(notificador, enviador, { urlPublicaApi: URL_API });
    // why: a versão 3 muda um documento que sustenta fato aprovado do tema; o alerta do tema avisa mesmo sem o termo.
    expect(enviados.filter((e) => e.url === 'https://hooks.cliente.example/t3')).toHaveLength(2);
    expect(recebidosPor(porTermo.id)).toHaveLength(2);

    const doc = (await admin.query<{ id: string }>('SELECT id FROM documento WHERE url = $1', [urlDoc])).rows[0]?.id ?? '';
    expect((await new ConsultasPostgres(api).obterDocumento(doc))?.situacao).toBe('disponivel');
    await admin.query('UPDATE webhook_assinatura SET ativa = false WHERE cliente_id = $1', [clienteB]);
  });
});
