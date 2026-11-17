import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atualizarCliente, ClientesPostgres, criarChave, criarCliente, expurgarConsultas, listarPlanos, relatorioUso, salvarPlano, type NovaConsulta } from './clientes.ts';
import { configBanco } from './config.ts';
import { prepararBanco } from './migrar.ts';

const BANCO = 'lastro_teste';
const ambiente = { ...process.env, LASTRO_PG_BANCO: BANCO };
const rodada = randomUUID().slice(0, 8);

let admin: pg.Pool;
let api: pg.Pool;
let clientes: ClientesPostgres;

const consulta = (rota: string, custo: number): NovaConsulta => ({
  canal: 'portal',
  rota,
  situacao: 'respondida',
  pergunta: 'p',
  resposta: {},
  trechos: [],
  modelo: null,
  tokensEntrada: 0,
  tokensSaida: 0,
  custoUsd: custo,
  latenciaMs: 1,
});

const hoje = (): string => new Date().toISOString().slice(0, 10);

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
  admin = new pg.Pool(configBanco('admin', ambiente));
  api = new pg.Pool(configBanco('api', ambiente));
  clientes = new ClientesPostgres(api, 1);
});

afterAll(async () => {
  await Promise.all([admin.end(), api.end()]);
});

describe('planos e limites efetivos', () => {
  it('cliente segue o plano; exceção do cliente vale sobre o plano; mudar o plano muda quem não tem exceção', async () => {
    const plano = `teste-${rodada}`;
    await salvarPlano(admin, { id: plano, nome: 'Teste', limitePorMinuto: 7, cotaMensalPerguntas: 70, cotaMensalVerificacoes: 7, orcamentoMensalUsd: 7, maxAlertas: 1 });
    const segue = await criarCliente(admin, { nome: `Segue ${rodada}`, plano });
    const excecao = await criarCliente(admin, { nome: `Exceção ${rodada}`, plano, cotaMensalPerguntas: 5 });
    expect(await clientes.limites(segue)).toEqual({
      planoId: plano,
      planoNome: 'Teste',
      limitePorMinuto: 7,
      cotaMensalPerguntas: 70,
      cotaMensalVerificacoes: 7,
      orcamentoMensalUsd: 7,
      maxAlertas: 1,
    });
    expect((await clientes.limites(excecao))?.cotaMensalPerguntas).toBe(5);

    await salvarPlano(admin, { id: plano, nome: 'Teste 2', limitePorMinuto: 9, cotaMensalPerguntas: 90, cotaMensalVerificacoes: 9, orcamentoMensalUsd: 9, maxAlertas: 3 });
    expect(await clientes.limites(segue)).toMatchObject({ planoNome: 'Teste 2', cotaMensalPerguntas: 90 });
    expect((await clientes.limites(excecao))?.cotaMensalPerguntas).toBe(5);

    const { chave } = await criarChave(admin, segue, ['leitura']);
    expect((await clientes.autenticar(chave))?.limitePorMinuto).toBe(9);

    expect(await atualizarCliente(admin, excecao, { cotaMensalPerguntas: null, limitePorMinuto: 2 })).toBe(true);
    expect(await clientes.limites(excecao)).toMatchObject({ cotaMensalPerguntas: 90, limitePorMinuto: 2 });
    expect(await atualizarCliente(admin, excecao, { plano: 'padrao' })).toBe(true);
    expect(await clientes.limites(excecao)).toMatchObject({ planoId: 'padrao', limitePorMinuto: 2, cotaMensalPerguntas: 1000 });
    await expect(atualizarCliente(admin, excecao, { plano: 'nao-existe' })).rejects.toThrow(/foreign key/);

    expect(await atualizarCliente(admin, segue, { ativo: false })).toBe(true);
    expect(await clientes.limites(segue)).toBeUndefined();
    expect(await clientes.autenticar(chave)).toBeUndefined();
    expect((await listarPlanos(admin)).map((p) => p.id)).toEqual(expect.arrayContaining(['padrao', 'portal-publico', plano]));
  });
});

describe('medição de uso', () => {
  it('perguntas e verificações têm cotas próprias; fora do escopo não conta; o expurgo LGPD não zera a cota', async () => {
    const c = await criarCliente(admin, { nome: `Medição ${rodada}` });
    await clientes.registrarConsulta(c, null, consulta('prazo', 0.5));
    await clientes.registrarConsulta(c, null, consulta('fora-do-escopo', 0));
    await clientes.registrarConsulta(c, null, consulta('verificacao', 0.25));
    const antes = await clientes.usoMensal(c, new Date());
    expect(antes).toMatchObject({ perguntas: 1, verificacoes: 1, gastoUsd: 0.75 });

    expect(await expurgarConsultas(admin, new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThanOrEqual(3);
    expect(await clientes.usoMensal(c, new Date())).toEqual(antes);

    const dias = await clientes.usoPorDia(c, hoje(), hoje());
    expect(dias.map((d) => [d.metrica, d.quantidade])).toEqual([
      ['perguntas', 1],
      ['perguntas-fora-do-escopo', 1],
      ['verificacoes', 1],
    ]);
  });

  it('requisições em lote somam por cliente e dia; cliente não vê a medição de outro', async () => {
    const a = await criarCliente(admin, { nome: `Req A ${rodada}` });
    const b = await criarCliente(admin, { nome: `Req B ${rodada}` });
    await clientes.registrarRequisicoes([
      { clienteId: a, dia: hoje(), quantidade: 3 },
      { clienteId: a, dia: hoje(), quantidade: 2 },
      { clienteId: b, dia: hoje(), quantidade: 1 },
      { clienteId: b, dia: hoje(), quantidade: 0 },
      { clienteId: 'nao-uuid', dia: hoje(), quantidade: 9 },
    ]);
    await clientes.registrarRequisicoes([{ clienteId: a, dia: hoje(), quantidade: 4 }]);
    expect(await clientes.usoPorDia(a, hoje(), hoje())).toEqual([{ dia: hoje(), metrica: 'requisicoes', quantidade: 9, custoUsd: 0 }]);
    expect((await clientes.usoPorDia(b, hoje(), hoje()))[0]?.quantidade).toBe(1);

    const semCliente = await api.query('SELECT count(*)::int AS n FROM uso_diario');
    expect(semCliente.rows[0]).toEqual({ n: 0 });

    const relatorio = await relatorioUso(admin, hoje(), new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
    expect(relatorio.find((l) => l.clienteId === a)).toMatchObject({ requisicoes: 9, perguntas: 0, planoId: 'padrao' });
  });

  it('a API não grava a medição direto, só pelas funções', async () => {
    const c = await criarCliente(admin, { nome: `Direto ${rodada}` });
    await expect(api.query("INSERT INTO uso_diario (cliente_id, dia, metrica, quantidade) VALUES ($1, current_date, 'requisicoes', 1)", [c])).rejects.toThrow(
      /permission denied/,
    );
    await expect(api.query('UPDATE uso_diario SET quantidade = 0')).rejects.toThrow(/permission denied/);
    await expect(api.query('DELETE FROM uso_diario')).rejects.toThrow(/permission denied/);
    await expect(api.query('UPDATE plano SET cota_mensal_perguntas = 1000000')).rejects.toThrow(/permission denied/);
  });
});

describe('canais', () => {
  it('canal do portal e do Slack ficam registrados; workspace do Slack resolve para um cliente ativo', async () => {
    const c = await criarCliente(admin, { nome: `Slack ${rodada}` });
    await clientes.registrarConsulta(c, null, { ...consulta('prazo', 0), canal: 'slack' });
    const team = `T${rodada.toUpperCase().replace(/[^A-Z0-9]/g, '0')}`;
    await admin.query('INSERT INTO canal_slack (team_id, cliente_id) VALUES ($1, $2)', [team, c]);
    const r = await api.query<{ id: string | null }>('SELECT cliente_do_slack($1) AS id', [team]);
    expect(r.rows[0]?.id).toBe(c);
    await atualizarCliente(admin, c, { ativo: false });
    expect((await api.query<{ id: string | null }>('SELECT cliente_do_slack($1) AS id', [team])).rows[0]?.id).toBeNull();
    await expect(api.query('SELECT * FROM canal_slack')).rejects.toThrow(/permission denied/);
  });
});
