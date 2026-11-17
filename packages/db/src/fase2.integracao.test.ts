import { randomUUID } from 'node:crypto';
import { sha256, type NovoSnapshot } from '@lastro/ingest';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArquivoPostgres } from './arquivo-postgres.ts';
import { ClientesPostgres, criarChave, criarCliente, expurgarConsultas, revogarChave, type NovaConsulta } from './clientes.ts';
import { configBanco, configS3 } from './config.ts';
import { ConhecimentoPostgres } from './conhecimento.ts';
import { prepararBanco } from './migrar.ts';
import { processarPendentes } from './processamento.ts';
import { StorageWorm } from './storage.ts';

const BANCO = 'lastro_teste';
const ambiente = { ...process.env, LASTRO_PG_BANCO: BANCO, LASTRO_S3_BUCKET: 'lastro-testes', LASTRO_S3_RETENCAO_DIAS: '1' };
const rodada = randomUUID();
const marca = `zq${rodada.slice(0, 8)}`;
const base = `https://www.gov.br/nfse/teste-integracao/${rodada}`;

let admin: pg.Pool;
let coletor: pg.Pool;
let processador: pg.Pool;
let api: pg.Pool;
let storage: StorageWorm;
let arquivo: ArquivoPostgres;
let conhecimento: ConhecimentoPostgres;
let clientes: ClientesPostgres;

function html(corpo: string, url: string): NovoSnapshot {
  const bytes = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><main>${corpo}</main></body></html>`);
  const sha = sha256(bytes);
  return { fonteId: 'nfse-faq', url, urlFinal: url, mime: 'text/html', etag: null, ultimaModificacao: null, corpo: bytes, sha256: sha, impressao: `html:${sha}` };
}

const consulta = (pergunta: string, custoUsd = 0.01): NovaConsulta => ({
  canal: 'api',
  rota: 'prazo',
  situacao: 'respondida',
  pergunta,
  resposta: { resposta: pergunta },
  trechos: [],
  modelo: 'claude-opus-5-5',
  tokensEntrada: 10,
  tokensSaida: 5,
  custoUsd,
  latenciaMs: 1,
});

async function processar(): Promise<void> {
  await processarPendentes({ pool: processador, lerOriginal: (sha) => storage.ler(sha) }, { limite: 1000 });
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
  arquivo = new ArquivoPostgres(coletor, storage);
  conhecimento = new ConhecimentoPostgres(api);
  clientes = new ClientesPostgres(api, 30);
});

afterAll(async () => {
  await Promise.all([admin.end(), coletor.end(), processador.end(), api.end()]);
  storage.destruir();
});

describe('processamento e busca', () => {
  it('extrai trechos por artigo e a busca acha por termo e por identificador', async () => {
    await arquivo.gravarSnapshot(
      html(
        `<p>Art. 1º O emissor ${marca} passa a exigir o grupo IBSCBS.</p><p>Art. 2º O leiaute anterior deixa de ser aceito.</p><p>Art. 3º Esta resolução entra em vigor em 01/01/2027.</p>`,
        `${base}/resolucao.html`,
      ),
      new Date(),
    );
    await processar();
    const porTermo = await conhecimento.buscarTrechos({ consulta: `emissor ${marca}`, limite: 5 });
    expect(porTermo[0]).toMatchObject({ secao: 'Art. 1', fonteId: 'nfse-faq', url: `${base}/resolucao.html`, documentoIndisponivel: false });
    expect(porTermo[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const filtrada = await conhecimento.buscarTrechos({ consulta: `emissor ${marca}`, fontes: ['cgibs'], limite: 5 });
    expect(filtrada.some((t) => t.url.startsWith(base))).toBe(false);
  });

  it('versão anômala fica fora do índice até ser liberada; a anterior continua valendo', async () => {
    const url = `${base}/anomala.html`;
    const v1 = await arquivo.gravarSnapshot(html(`<p>Art. 1º Texto original ${marca}v1 confiável.</p>`, url), new Date(Date.now() - 60_000));
    const v2 = await arquivo.gravarSnapshot(html(`<p>Art. 1º Texto adulterado ${marca}v2.</p>`, url), new Date());
    const evento = await arquivo.registrarEvento({
      tipo: 'nova-versao',
      fonteId: 'nfse-faq',
      url,
      snapshotAnterior: v1.id,
      snapshotNovo: v2.id,
      detectadoEm: new Date().toISOString(),
      resumo: 'texto encolheu',
      anomalia: 'texto encolheu a menos de 30%',
    });
    await processar();
    expect((await conhecimento.buscarTrechos({ consulta: `${marca}v2`, limite: 5 })).length).toBe(0);
    expect((await conhecimento.buscarTrechos({ consulta: `${marca}v1`, limite: 5 }))[0]?.snapshotId).toBe(v1.id);

    await admin.query("INSERT INTO revisao_anomalia (evento_id, decisao, revisor, motivo) VALUES ($1, 'liberar', 'teste', 'conferido na fonte')", [evento.id]);
    await processar();
    expect((await conhecimento.buscarTrechos({ consulta: `${marca}v2`, limite: 5 }))[0]?.snapshotId).toBe(v2.id);
    expect((await conhecimento.buscarTrechos({ consulta: `${marca}v1`, limite: 5 })).length).toBe(0);
  });

  it('tabelas e campos só aparecem pela extração vigente', async () => {
    expect(await conhecimento.consultarReferencia('slug-que-nao-existe', '000001', 5)).toEqual([]);
    expect(await conhecimento.buscarCampos(`campo${marca}`, 5)).toEqual([]);
  });
});

describe('clientes, chaves e isolamento (RLS)', () => {
  it('autentica pela chave, recusa chave adulterada e revogada', async () => {
    const cliente = await criarCliente(admin, { nome: `Cliente ${marca}`, limitePorMinuto: 30 });
    const { id, chave } = await criarChave(admin, cliente, ['leitura', 'perguntas']);
    expect(await clientes.autenticar(chave)).toMatchObject({ clienteId: cliente, chaveId: id, escopos: ['leitura', 'perguntas'], limitePorMinuto: 30 });
    expect(await clientes.autenticar(`${chave.slice(0, -1)}${chave.endsWith('A') ? 'B' : 'A'}`)).toBeUndefined();
    expect(await revogarChave(admin, id)).toBe(true);
    expect(await clientes.autenticar(chave)).toBeUndefined();
  });

  it('cliente não vê consulta de outro, nem pelo id; sem cliente definido o banco não devolve nada', async () => {
    const a = await criarCliente(admin, { nome: `A ${marca}` });
    const b = await criarCliente(admin, { nome: `B ${marca}` });
    const idA = await clientes.registrarConsulta(a, null, consulta('pergunta sigilosa de A'));
    expect((await clientes.obterConsulta(a, idA))?.pergunta).toBe('pergunta sigilosa de A');
    expect(await clientes.obterConsulta(b, idA)).toBeUndefined();

    const semContexto = await api.query('SELECT count(*)::int AS n FROM consulta_log');
    expect(semContexto.rows[0]).toEqual({ n: 0 });

    const c = await api.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('lastro.cliente_id', $1, true)", [b]);
      expect((await c.query('SELECT count(*)::int AS n FROM consulta_log WHERE id = $1', [idA])).rows[0]).toEqual({ n: 0 });
      await expect(
        c.query("INSERT INTO consulta_log (cliente_id, canal, rota, situacao, pergunta, resposta, expira_em) VALUES ($1, 'api', 'x', 'x', 'x', '{}', now())", [a]),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('uso mensal por cliente e gasto global somam o que devem', async () => {
    const a = await criarCliente(admin, { nome: `Uso ${marca}`, cotaMensalPerguntas: 7, orcamentoMensalUsd: 3 });
    const antes = await clientes.gastoGlobalDesde(new Date(Date.now() - 3_600_000));
    await clientes.registrarConsulta(a, null, consulta('q1', 0.5));
    await clientes.registrarConsulta(a, null, consulta('q2', 0.25));
    expect(await clientes.usoMensal(a, new Date())).toEqual({ perguntas: 2, verificacoes: 0, gastoUsd: 0.75, cotaMensalPerguntas: 7, cotaMensalVerificacoes: 1000, orcamentoMensalUsd: 3 });
    expect((await clientes.gastoGlobalDesde(new Date(Date.now() - 3_600_000))) - antes).toBeCloseTo(0.75);
  });

  it('expurgo apaga só consultas vencidas', async () => {
    const a = await criarCliente(admin, { nome: `Expurgo ${marca}` });
    const vencida = await new ClientesPostgres(api, 1).registrarConsulta(a, null, consulta('vencida'));
    expect(await expurgarConsultas(admin, new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThanOrEqual(1);
    expect(await clientes.obterConsulta(a, vencida)).toBeUndefined();
  });
});

describe('privilégios mínimos', () => {
  it.each([
    ['api lê hashes de chave', () => api.query('SELECT hash FROM chave_api LIMIT 1'), /permission denied/],
    ['api apaga consulta', () => api.query('DELETE FROM consulta_log'), /permission denied/],
    ['api escreve trecho', () => api.query("INSERT INTO trecho (extracao_id, snapshot_id, documento_id, fonte_id, ordem, texto) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', 0, 'x')"), /permission denied/],
    ['processador altera trecho', () => processador.query("UPDATE trecho SET texto = 'adulterado'"), /permission denied/],
    ['processador lê clientes', () => processador.query('SELECT * FROM cliente'), /permission denied/],
    ['admin altera trecho (trigger)', () => admin.query("UPDATE trecho SET texto = 'adulterado' WHERE false OR true"), /aceita apenas inserção/],
    ['admin apaga revisão (trigger)', () => admin.query('DELETE FROM revisao_anomalia'), /aceita apenas inserção/],
  ])('recusa: %s', async (_nome, operacao, erro) => {
    await expect(operacao()).rejects.toThrow(erro);
  });
});
