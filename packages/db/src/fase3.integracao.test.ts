import { randomUUID } from 'node:crypto';
import { sha256, type NovoSnapshot } from '@lastro/ingest';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArquivoPostgres } from './arquivo-postgres.ts';
import { ClientesPostgres, criarCliente } from './clientes.ts';
import { configBanco, configS3 } from './config.ts';
import { ConsultasPostgres } from './consultas.ts';
import { CuradoriaPostgres, criarCurador, desativarCurador, ErroCuradoria } from './curadoria.ts';
import { FatosPostgres } from './fatos.ts';
import { prepararBanco } from './migrar.ts';
import { processarNormasPorRegras } from './normativo.ts';
import { processarPendentes } from './processamento.ts';
import { StorageWorm } from './storage.ts';
import { VerificacoesPostgres } from './verificacoes.ts';

const BANCO = 'lastro_teste';
const ambiente = { ...process.env, LASTRO_PG_BANCO: BANCO, LASTRO_S3_BUCKET: 'lastro-testes', LASTRO_S3_RETENCAO_DIAS: '1' };
const rodada = randomUUID();
const marca = `zq${rodada.slice(0, 8)}`;
const base = `https://www.cgibs.gov.br/teste-fase3/${rodada}`;
const EMISSOR = 'https://sso.lastro.example';
// why: número de ato exclusivo da rodada; o banco de teste é reaproveitado entre execuções e a chave canônica precisa ser única.
const numero = String(Number.parseInt(rodada.slice(0, 6), 16) % 900_000 + 100_000);

let admin: pg.Pool;
let coletor: pg.Pool;
let processador: pg.Pool;
let api: pg.Pool;
let curadoriaPool: pg.Pool;
let storage: StorageWorm;
let arquivo: ArquivoPostgres;
let curadoria: CuradoriaPostgres;
let fatos: FatosPostgres;
let verificacoes: VerificacoesPostgres;
const curadores: { ana: string; bia: string; chefe: string; inativo: string } = { ana: '', bia: '', chefe: '', inativo: '' };
let trechoRevogacao = '';
let trechoPrazo = '';
let docAntigo = '';
let docNovo = '';

function html(corpo: string, url: string): NovoSnapshot {
  const bytes = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><main>${corpo}</main></body></html>`);
  const sha = sha256(bytes);
  return { fonteId: 'cgibs', url, urlFinal: url, mime: 'text/html', etag: null, ultimaModificacao: null, corpo: bytes, sha256: sha, impressao: `html:${sha}` };
}

beforeAll(async () => {
  const servidor = new pg.Client({ ...configBanco('admin', process.env), database: 'postgres' });
  await servidor.connect();
  if ((await servidor.query('SELECT 1 FROM pg_database WHERE datname = $1', [BANCO])).rowCount === 0) await servidor.query(`CREATE DATABASE ${BANCO}`);
  await servidor.end();
  const senha = (p: Parameters<typeof configBanco>[0]) => configBanco(p, ambiente).password as string;
  await prepararBanco(configBanco('admin', ambiente), {
    coletor: senha('coletor'),
    leitor: senha('leitor'),
    notificador: senha('notificador'),
    processador: senha('processador'),
    api: senha('api'),
    curadoria: senha('curadoria'),
  });
  const s3 = configS3(ambiente);
  storage = StorageWorm.criar(s3);
  await storage.preparar(s3.retencaoDias);
  admin = new pg.Pool(configBanco('admin', ambiente));
  coletor = new pg.Pool(configBanco('coletor', ambiente));
  processador = new pg.Pool(configBanco('processador', ambiente));
  api = new pg.Pool(configBanco('api', ambiente));
  curadoriaPool = new pg.Pool(configBanco('curadoria', ambiente));
  arquivo = new ArquivoPostgres(coletor, storage);
  curadoria = new CuradoriaPostgres(curadoriaPool);
  fatos = new FatosPostgres(api);
  verificacoes = new VerificacoesPostgres(api, 30);

  await arquivo.gravarSnapshot(
    html(`<p>RESOLUÇÃO CGIBS Nº ${numero}, DE 10 DE MARÇO DE 2026</p><p>Art. 1º O emissor ${marca} passa a ser obrigatório em 01/09/2026.</p>`, `${base}/antiga.html`),
    new Date(Date.now() - 60_000),
  );
  await arquivo.gravarSnapshot(
    html(
      `<p>RESOLUÇÃO CGIBS Nº ${String(Number(numero) + 1)}, DE 4 DE AGOSTO DE 2026</p><p>Art. 1º Fica revogada a Resolução CGIBS nº ${numero}, de 10 de março de 2026.</p><p>Art. 2º A obrigatoriedade do emissor ${marca} passa a valer em 1º de novembro de 2026.</p>`,
      `${base}/nova.html`,
    ),
    new Date(),
  );
  const docs = await admin.query<{ id: string; url: string }>('SELECT id, url FROM documento WHERE url LIKE $1', [`${base}/%`]);
  docAntigo = docs.rows.find((d) => d.url.endsWith('/antiga.html'))?.id ?? '';
  docNovo = docs.rows.find((d) => d.url.endsWith('/nova.html'))?.id ?? '';
  await processarPendentes({ pool: processador, lerOriginal: (sha) => storage.ler(sha) }, { limite: 1000 });
  await processarNormasPorRegras(processador, { limite: 1000 });
  const t = await admin.query<{ id: string; texto: string }>('SELECT id, texto FROM trecho WHERE documento_id = $1 ORDER BY ordem', [docNovo]);
  trechoRevogacao = t.rows.find((x) => x.texto.includes('Fica revogada'))?.id ?? '';
  trechoPrazo = t.rows.find((x) => x.texto.includes('passa a valer em 1º de novembro de 2026'))?.id ?? '';
  if (docAntigo === '' || trechoRevogacao === '' || trechoPrazo === '') throw new Error('preparação da Fase 3 incompleta');

  curadores.ana = await criarCurador(admin, { emissor: EMISSOR, sujeito: `ana-${rodada}`, nome: 'Ana', papel: 'curador' });
  curadores.bia = await criarCurador(admin, { emissor: EMISSOR, sujeito: `bia-${rodada}`, nome: 'Bia', papel: 'curador' });
  curadores.chefe = await criarCurador(admin, { emissor: EMISSOR, sujeito: `chefe-${rodada}`, nome: 'Chefe', papel: 'supervisor' });
  curadores.inativo = await criarCurador(admin, { emissor: EMISSOR, sujeito: `ex-${rodada}`, nome: 'Ex', papel: 'curador' });
  await desativarCurador(admin, curadores.inativo);
});

afterAll(async () => {
  await Promise.all([admin.end(), coletor.end(), processador.end(), api.end(), curadoriaPool.end()]);
  storage.destruir();
});

async function proporPrazo(enunciado: string, por = curadores.ana): Promise<string> {
  return curadoria.proporFato(por, {
    tipo: 'prazo',
    tema: `teste-${marca}`,
    enunciado,
    publico: null,
    dataEfeito: '2026-11-01',
    evidenciaTrechoId: trechoPrazo,
    evidenciaTexto: 'passa a valer em 1º de novembro de 2026',
    substitui: null,
  });
}

describe('grafo normativo por regras', () => {
  it('identifica os dois atos e propõe a revogação, com destino resolvido pela chave', async () => {
    const atos = await admin.query<{ documento_id: string; chave: string }>('SELECT documento_id, chave FROM ato_vigente WHERE documento_id = ANY ($1)', [[docAntigo, docNovo]]);
    expect(atos.rows.map((a) => a.chave).sort()).toEqual([`resolucao-cgibs-${numero}-2026`, `resolucao-cgibs-${String(Number(numero) + 1)}-2026`].sort());
    const [rel] = (await curadoria.listarPropostas(curadores.ana, { tipo: 'relacao', situacao: 'proposto', limite: 500 })).filter((p) => p.url === `${base}/nova.html`);
    expect(rel?.titulo).toContain('revoga');
    const detalhe = await curadoria.obterProposta(curadores.ana, 'relacao', rel?.id ?? '');
    expect(detalhe?.relacao).toMatchObject({ tipo: 'revoga', destinoUrl: `${base}/antiga.html` });
  });
});

describe('curadoria com dupla aprovação (regras no banco)', () => {
  it('um voto não aprova; o mesmo curador não vota duas vezes; quem propôs não aprova', async () => {
    const id = await proporPrazo(`O emissor ${marca} é obrigatório a partir de 01/11/2026.`);
    await expect(curadoria.decidir(curadores.ana, 'fato', id, 'aprovar', null)).rejects.toThrow(/própria proposta/);
    await curadoria.decidir(curadores.bia, 'fato', id, 'aprovar', null);
    expect((await curadoria.obterProposta(curadores.bia, 'fato', id))?.situacao).toBe('proposto');
    await expect(curadoria.decidir(curadores.bia, 'fato', id, 'aprovar', null)).rejects.toBeInstanceOf(ErroCuradoria);
    expect(await fatos.obterFatos([id])).toEqual([]);
    await curadoria.decidir(curadores.chefe, 'fato', id, 'aprovar', null);
    const [publico] = await fatos.obterFatos([id]);
    expect(publico).toMatchObject({ situacao: 'aprovado', evidenciaAtual: true, evidencia: { trechoId: trechoPrazo, fonteId: 'cgibs' } });
    expect((await fatos.listarFatos({ consulta: `emissor ${marca}`, limite: 10 })).map((f) => f.id)).toContain(id);
    await expect(curadoria.decidir(curadores.ana, 'fato', id, 'rejeitar', 'tarde demais')).rejects.toMatchObject({ codigo: 'conflito' });
  });

  it('decisão em nome de outro curador, por inativo, ou proposta em nome alheio são recusadas', async () => {
    const id = await proporPrazo(`Prazo ${marca} para o teste de identidade de curador.`);
    const c = await curadoriaPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('lastro.curador_id', $1, true)", [curadores.bia]);
      await expect(c.query("INSERT INTO decisao_curadoria (fato_id, curador_id, decisao) VALUES ($1, $2, 'aprovar')", [id, curadores.chefe])).rejects.toThrow(/outro curador/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    await expect(curadoria.decidir(curadores.inativo, 'fato', id, 'aprovar', null)).rejects.toMatchObject({ codigo: 'nao-permitido' });
    const c2 = await curadoriaPool.connect();
    try {
      await c2.query('BEGIN');
      await c2.query("SELECT set_config('lastro.curador_id', $1, true)", [curadores.ana]);
      await expect(
        c2.query(
          "INSERT INTO fato (tipo, tema, enunciado, evidencia_trecho_id, evidencia_texto, extrator, proposto_por) VALUES ('prazo', 'x-y', 'Proposta em nome da Bia.', $1, 'passa a valer', 'curador', $2)",
          [trechoPrazo, curadores.bia],
        ),
      ).rejects.toThrow(/outro curador/);
    } finally {
      await c2.query('ROLLBACK');
      c2.release();
    }
  });

  it('evidência que não existe literalmente no trecho é recusada', async () => {
    await expect(
      curadoria.proporFato(curadores.ana, {
        tipo: 'prazo',
        tema: 'x-y',
        enunciado: 'Prazo inventado para 2030 sem lastro.',
        publico: null,
        dataEfeito: null,
        evidenciaTrechoId: trechoPrazo,
        evidenciaTexto: 'passa a valer em 2030',
        substitui: null,
      }),
    ).rejects.toThrow(/literalmente/);
  });

  it('recall: só supervisor, só do aprovado; vira evento no feed sem mascarar o estado do documento', async () => {
    const id = await proporPrazo(`Fato ${marca} que vai ser revogado pela curadoria.`);
    await curadoria.decidir(curadores.bia, 'fato', id, 'aprovar', null);
    await expect(curadoria.recall(curadores.chefe, id, 'ainda não aprovado')).rejects.toMatchObject({ codigo: 'conflito' });
    await curadoria.decidir(curadores.chefe, 'fato', id, 'aprovar', null);
    await expect(curadoria.recall(curadores.bia, id, 'curador comum')).rejects.toMatchObject({ codigo: 'nao-permitido' });

    const cliente = await criarCliente(admin, { nome: `Recall ${marca}` });
    await verificacoes.registrar(cliente, null, { canal: 'api', entrada: 'x', resultado: {}, fatos: [id], relacoes: [], trechos: [trechoPrazo] });
    expect(await curadoria.recall(curadores.chefe, id, 'enunciado errado')).toEqual({ verificacoes: 1, consultas: 0 });
    expect((await fatos.obterFatos([id]))[0]?.situacao).toBe('revogado');
    expect((await fatos.listarFatos({ consulta: `revogado ${marca}`, limite: 10 })).map((f) => f.id)).not.toContain(id);

    const ev = await admin.query<{ tipo: string; resumo: string }>("SELECT tipo, resumo FROM evento_mudanca WHERE documento_id = $1 AND tipo = 'fato-corrigido'", [docNovo]);
    expect(ev.rows[0]?.resumo).toContain('revogado pela curadoria');
    const consultas = new ConsultasPostgres(api);
    expect((await consultas.obterDocumento(docNovo))?.situacao).toBe('disponivel');
    expect((await arquivo.ultimoEvento(`${base}/nova.html`))?.tipo).not.toBe('fato-corrigido');
  });

  it('relação aprovada entra no grafo da API; pendente não', async () => {
    const [rel] = (await curadoria.listarPropostas(curadores.ana, { tipo: 'relacao', situacao: 'proposto', limite: 500 })).filter((p) => p.url === `${base}/nova.html`);
    const id = rel?.id ?? '';
    expect(await fatos.relacoesDosDocumentos([docAntigo])).toEqual([]);
    await curadoria.decidir(curadores.ana, 'relacao', id, 'aprovar', null);
    await curadoria.decidir(curadores.bia, 'relacao', id, 'aprovar', null);
    expect(await fatos.relacoesDosDocumentos([docAntigo])).toEqual([expect.objectContaining({ id, tipo: 'revoga', destinoDocumentoId: docAntigo, origemDocumentoId: docNovo })]);
  });
});

describe('verificações: isolamento (RLS) e link compartilhável', () => {
  it('cliente não vê verificação de outro; link público por token, revogável', async () => {
    const a = await criarCliente(admin, { nome: `VA ${marca}` });
    const b = await criarCliente(admin, { nome: `VB ${marca}` });
    const v = await verificacoes.registrar(a, null, { canal: 'api', entrada: 'texto sigiloso de A', resultado: { ok: true }, fatos: [], relacoes: [], trechos: [] });
    expect((await verificacoes.obter(a, v.id))?.entrada).toBe('texto sigiloso de A');
    expect(await verificacoes.obter(b, v.id)).toBeUndefined();
    expect(await verificacoes.compartilhar(b, v.id)).toBeUndefined();
    expect((await api.query('SELECT count(*)::int AS n FROM verificacao')).rows[0]).toEqual({ n: 0 });

    const token = await verificacoes.compartilhar(a, v.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const publica = await verificacoes.obterCompartilhada(token ?? '');
    expect(publica).toMatchObject({ id: v.id, resultado: { ok: true } });
    expect(publica).not.toHaveProperty('entrada');
    const outro = await verificacoes.compartilhar(a, v.id);
    expect(await verificacoes.obterCompartilhada(token ?? '')).toBeUndefined();
    expect(await verificacoes.revogarCompartilhamento(a, v.id)).toBe(true);
    expect(await verificacoes.obterCompartilhada(outro ?? '')).toBeUndefined();
    expect((await admin.query<{ compartilhamento: string | null }>('SELECT compartilhamento FROM verificacao WHERE id = $1', [v.id])).rows[0]?.compartilhamento).toBeNull();
  });
});

describe('privilégios mínimos da Fase 3', () => {
  it.each([
    ['api lê propostas pendentes', () => api.query('SELECT * FROM fato LIMIT 1'), /permission denied/],
    ['api lê curadores', () => api.query('SELECT * FROM curador LIMIT 1'), /permission denied/],
    ['api decide', () => api.query("INSERT INTO decisao_curadoria (fato_id, curador_id, decisao) VALUES (gen_random_uuid(), gen_random_uuid(), 'aprovar')"), /permission denied/],
    ['curadoria altera fato', () => curadoriaPool.query("UPDATE fato SET enunciado = 'adulterado'"), /permission denied/],
    ['curadoria apaga decisão', () => curadoriaPool.query('DELETE FROM decisao_curadoria'), /permission denied/],
    ['curadoria lê consultas de clientes', () => curadoriaPool.query('SELECT * FROM consulta_log LIMIT 1'), /permission denied/],
    ['processador decide', () => processador.query("INSERT INTO decisao_curadoria (fato_id, curador_id, decisao) VALUES (gen_random_uuid(), gen_random_uuid(), 'aprovar')"), /permission denied/],
    ['admin altera decisão (trigger)', () => admin.query("UPDATE decisao_curadoria SET decisao = 'aprovar' WHERE false OR true"), /aceita apenas inserção/],
    ['admin apaga fato (trigger)', () => admin.query('DELETE FROM fato WHERE false OR true'), /aceita apenas inserção/],
  ])('recusa: %s', async (_nome, operacao, erro) => {
    await expect(operacao()).rejects.toThrow(erro);
  });

  it('a API só lê clientes pelo caminho autenticado', async () => {
    const clientes = new ClientesPostgres(api, 30);
    expect(await clientes.autenticar('lastro_inexistente0_' + 'a'.repeat(43))).toBeUndefined();
  });
});
