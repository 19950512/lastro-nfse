import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

export const ESCOPOS = ['leitura', 'perguntas', 'verificacoes', 'alertas'] as const;
export type Escopo = (typeof ESCOPOS)[number];

export interface Credencial {
  readonly chaveId: string;
  readonly clienteId: string;
  readonly escopos: readonly Escopo[];
  readonly limitePorMinuto: number;
}

export const CANAIS = ['api', 'mcp', 'portal', 'slack'] as const;
export type Canal = (typeof CANAIS)[number];

export interface NovaConsulta {
  readonly canal: Canal;
  readonly rota: string;
  readonly situacao: string;
  readonly pergunta: string;
  readonly resposta: unknown;
  readonly trechos: readonly string[];
  readonly modelo: string | null;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly custoUsd: number;
  readonly latenciaMs: number;
}

export interface ConsultaRegistrada {
  readonly id: string;
  readonly criadaEm: string;
  readonly rota: string;
  readonly situacao: string;
  readonly pergunta: string;
  readonly resposta: unknown;
}

/** Limites efetivos do cliente: exceção do cliente quando houver, senão o valor do plano. */
export interface LimitesCliente {
  readonly planoId: string;
  readonly planoNome: string;
  readonly limitePorMinuto: number;
  readonly cotaMensalPerguntas: number;
  readonly cotaMensalVerificacoes: number;
  readonly orcamentoMensalUsd: number;
  readonly maxAlertas: number;
}

export interface UsoMensal {
  readonly perguntas: number;
  readonly verificacoes: number;
  readonly gastoUsd: number;
  readonly cotaMensalPerguntas: number;
  readonly cotaMensalVerificacoes: number;
  readonly orcamentoMensalUsd: number;
}

export const METRICAS_USO = ['requisicoes', 'perguntas', 'perguntas-fora-do-escopo', 'verificacoes'] as const;
export type MetricaUso = (typeof METRICAS_USO)[number];

export interface UsoDiario {
  readonly dia: string;
  readonly metrica: MetricaUso;
  readonly quantidade: number;
  readonly custoUsd: number;
}

/** Requisições contadas em memória pela API, gravadas em lote (dia em UTC, AAAA-MM-DD). */
export interface ContagemRequisicoes {
  readonly clienteId: string;
  readonly dia: string;
  readonly quantidade: number;
}

/** Operações com o cliente autenticado (papel `lastro_api`, sujeito a RLS em `consulta_log`). */
export interface RepositorioClientes {
  autenticar(chave: string): Promise<Credencial | undefined>;
  registrarConsulta(clienteId: string, chaveId: string | null, consulta: NovaConsulta): Promise<string>;
  obterConsulta(clienteId: string, id: string): Promise<ConsultaRegistrada | undefined>;
  usoMensal(clienteId: string, agora: Date): Promise<UsoMensal | undefined>;
  gastoGlobalDesde(desde: Date): Promise<number>;
  limites(clienteId: string): Promise<LimitesCliente | undefined>;
  /** Medição diária do próprio cliente (RLS), datas em UTC inclusivas. */
  usoPorDia(clienteId: string, desde: string, ate: string): Promise<UsoDiario[]>;
  registrarRequisicoes(contagens: readonly ContagemRequisicoes[]): Promise<void>;
}

const FORMATO_CHAVE = /^lastro_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALFABETO_PREFIXO = 'abcdefghijklmnopqrstuvwxyz0123456789';

const hashChave = (chave: string): string => createHash('sha256').update(chave).digest('hex');

function gerarPrefixo(): string {
  // why: rejeição de bytes ≥ 252 evita viés de módulo (252 = 7 × 36).
  let prefixo = '';
  while (prefixo.length < 12) {
    for (const b of randomBytes(16)) if (b < 252 && prefixo.length < 12) prefixo += ALFABETO_PREFIXO[b % 36] ?? '';
  }
  return prefixo;
}

export function retencaoConsultasDias(ambiente: NodeJS.ProcessEnv = process.env): number {
  const dias = Number(ambiente.LASTRO_RETENCAO_CONSULTAS_DIAS ?? 30);
  // why: LGPD (SEGURANCA.md §14) — retenção curta; acima de 1 ano exige decisão explícita fora daqui.
  if (!Number.isInteger(dias) || dias < 1 || dias > 365) throw new Error('LASTRO_RETENCAO_CONSULTAS_DIAS deve ser inteiro entre 1 e 365');
  return dias;
}

export interface ExcecoesCliente {
  readonly limitePorMinuto?: number | undefined;
  readonly cotaMensalPerguntas?: number | undefined;
  readonly cotaMensalVerificacoes?: number | undefined;
  readonly orcamentoMensalUsd?: number | undefined;
  readonly maxAlertas?: number | undefined;
}

/** Cria o cliente no plano indicado (padrão: "padrao"); limite informado aqui vira exceção ao plano. */
export async function criarCliente(admin: pg.Pool, dados: { nome: string; plano?: string | undefined } & ExcecoesCliente): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO cliente (nome, plano_id, limite_por_minuto, cota_mensal_perguntas, cota_mensal_verificacoes, orcamento_mensal_usd, max_alertas)
     VALUES ($1, coalesce($2, 'padrao'), $3, $4, $5, $6, $7) RETURNING id`,
    [
      dados.nome,
      dados.plano ?? null,
      dados.limitePorMinuto ?? null,
      dados.cotaMensalPerguntas ?? null,
      dados.cotaMensalVerificacoes ?? null,
      dados.orcamentoMensalUsd ?? null,
      dados.maxAlertas ?? null,
    ],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('INSERT de cliente sem retorno');
  return id;
}

export interface Plano {
  readonly id: string;
  readonly nome: string;
  readonly limitePorMinuto: number;
  readonly cotaMensalPerguntas: number;
  readonly cotaMensalVerificacoes: number;
  readonly orcamentoMensalUsd: number;
  readonly maxAlertas: number;
  readonly clientes: number;
}

const FORMATO_PLANO = /^[a-z0-9-]{2,40}$/;

/** Cria ou atualiza um plano; todos os clientes do plano sem exceção passam a ter os novos limites. */
export async function salvarPlano(admin: pg.Pool, plano: Omit<Plano, 'clientes'>): Promise<void> {
  if (!FORMATO_PLANO.test(plano.id)) throw new Error('id do plano: minúsculas, dígitos e hífen (2 a 40)');
  await admin.query(
    `INSERT INTO plano (id, nome, limite_por_minuto, cota_mensal_perguntas, cota_mensal_verificacoes, orcamento_mensal_usd, max_alertas)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, limite_por_minuto = EXCLUDED.limite_por_minuto,
       cota_mensal_perguntas = EXCLUDED.cota_mensal_perguntas, cota_mensal_verificacoes = EXCLUDED.cota_mensal_verificacoes,
       orcamento_mensal_usd = EXCLUDED.orcamento_mensal_usd, max_alertas = EXCLUDED.max_alertas`,
    [plano.id, plano.nome, plano.limitePorMinuto, plano.cotaMensalPerguntas, plano.cotaMensalVerificacoes, plano.orcamentoMensalUsd, plano.maxAlertas],
  );
}

export async function listarPlanos(admin: pg.Pool): Promise<Plano[]> {
  const r = await admin.query<{
    id: string;
    nome: string;
    limite_por_minuto: number;
    cota_mensal_perguntas: number;
    cota_mensal_verificacoes: number;
    orcamento_mensal_usd: string;
    max_alertas: number;
    clientes: number;
  }>(`SELECT p.*, (SELECT count(*)::int FROM cliente c WHERE c.plano_id = p.id AND c.ativo) AS clientes FROM plano p ORDER BY p.criado_em, p.id`);
  return r.rows.map((l) => ({
    id: l.id,
    nome: l.nome,
    limitePorMinuto: l.limite_por_minuto,
    cotaMensalPerguntas: l.cota_mensal_perguntas,
    cotaMensalVerificacoes: l.cota_mensal_verificacoes,
    orcamentoMensalUsd: Number(l.orcamento_mensal_usd),
    maxAlertas: l.max_alertas,
    clientes: l.clientes,
  }));
}

export type AlteracaoCliente = { plano?: string | undefined; ativo?: boolean | undefined } & {
  [K in keyof ExcecoesCliente]?: number | null | undefined;
};

/**
 * Muda o plano do cliente e, opcionalmente, as exceções. `null` numa exceção remove a exceção (volta a valer o
 * plano); ausente mantém como está.
 */
export async function atualizarCliente(admin: pg.Pool, id: string, dados: AlteracaoCliente): Promise<boolean> {
  if (!UUID.test(id)) return false;
  // invariant: nomes de coluna vêm desta lista fixa; só os valores vão como parâmetro.
  const colunas: [string, unknown][] = [
    ['plano_id', dados.plano],
    ['ativo', dados.ativo],
    ['limite_por_minuto', dados.limitePorMinuto],
    ['cota_mensal_perguntas', dados.cotaMensalPerguntas],
    ['cota_mensal_verificacoes', dados.cotaMensalVerificacoes],
    ['orcamento_mensal_usd', dados.orcamentoMensalUsd],
    ['max_alertas', dados.maxAlertas],
  ];
  const definidas = colunas.filter(([, v]) => v !== undefined);
  if (definidas.length === 0) return false;
  const r = await admin.query(`UPDATE cliente SET ${definidas.map(([c], i) => `${c} = $${String(i + 2)}`).join(', ')} WHERE id = $1`, [
    id,
    ...definidas.map(([, v]) => v),
  ]);
  return r.rowCount === 1;
}

export interface LinhaRelatorioUso {
  readonly clienteId: string;
  readonly nome: string;
  readonly planoId: string;
  readonly requisicoes: number;
  readonly perguntas: number;
  readonly verificacoes: number;
  readonly custoUsd: number;
}

/** Uso de todos os clientes nos dias UTC [desde, ate), base da cobrança. Papel admin. */
export async function relatorioUso(admin: pg.Pool, desde: string, ate: string): Promise<LinhaRelatorioUso[]> {
  const r = await admin.query<{ cliente_id: string; nome: string; plano_id: string; requisicoes: string; perguntas: string; verificacoes: string; custo: string }>(
    `SELECT c.id AS cliente_id, c.nome, c.plano_id,
            coalesce(sum(u.quantidade) FILTER (WHERE u.metrica = 'requisicoes'), 0) AS requisicoes,
            coalesce(sum(u.quantidade) FILTER (WHERE u.metrica = 'perguntas'), 0) AS perguntas,
            coalesce(sum(u.quantidade) FILTER (WHERE u.metrica = 'verificacoes'), 0) AS verificacoes,
            coalesce(sum(u.custo_usd), 0) AS custo
       FROM cliente c JOIN uso_diario u ON u.cliente_id = c.id AND u.dia >= $1::date AND u.dia < $2::date
      GROUP BY c.id ORDER BY c.nome`,
    [desde, ate],
  );
  return r.rows.map((l) => ({
    clienteId: l.cliente_id,
    nome: l.nome,
    planoId: l.plano_id,
    requisicoes: Number(l.requisicoes),
    perguntas: Number(l.perguntas),
    verificacoes: Number(l.verificacoes),
    custoUsd: Number(l.custo),
  }));
}

/** Cria uma chave e devolve o segredo, que não fica guardado em lugar nenhum. */
export async function criarChave(
  admin: pg.Pool,
  clienteId: string,
  escopos: readonly Escopo[],
  descricao: string | null = null,
): Promise<{ id: string; chave: string }> {
  if (!UUID.test(clienteId)) throw new Error('cliente inválido');
  if (escopos.length === 0 || escopos.some((e) => !ESCOPOS.includes(e))) throw new Error(`escopos válidos: ${ESCOPOS.join(', ')}`);
  const chave = `lastro_${gerarPrefixo()}_${randomBytes(32).toString('base64url')}`;
  const prefixo = FORMATO_CHAVE.exec(chave)?.[1];
  if (prefixo === undefined) throw new Error('chave gerada fora do formato');
  const r = await admin.query<{ id: string }>(
    'INSERT INTO chave_api (cliente_id, prefixo, hash, escopos, descricao) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [clienteId, prefixo, hashChave(chave), [...new Set(escopos)], descricao],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('INSERT de chave sem retorno');
  return { id, chave };
}

export async function revogarChave(admin: pg.Pool, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const r = await admin.query('UPDATE chave_api SET revogada_em = now() WHERE id = $1 AND revogada_em IS NULL', [id]);
  return r.rowCount === 1;
}

export async function listarClientes(admin: pg.Pool): Promise<{ id: string; nome: string; ativo: boolean; planoId: string; chavesAtivas: number }[]> {
  const r = await admin.query<{ id: string; nome: string; ativo: boolean; plano_id: string; chaves_ativas: number }>(
    `SELECT c.id, c.nome, c.ativo, c.plano_id, (SELECT count(*)::int FROM chave_api k WHERE k.cliente_id = c.id AND k.revogada_em IS NULL) AS chaves_ativas
       FROM cliente c ORDER BY c.criado_em`,
  );
  return r.rows.map((l) => ({ id: l.id, nome: l.nome, ativo: l.ativo, planoId: l.plano_id, chavesAtivas: l.chaves_ativas }));
}

/** Apaga consultas vencidas (LGPD: retenção curta). Roda com o papel admin; a API não tem DELETE. */
export async function expurgarConsultas(admin: pg.Pool, agora: Date = new Date()): Promise<number> {
  const r = await admin.query('DELETE FROM consulta_log WHERE expira_em <= $1', [agora]);
  return r.rowCount ?? 0;
}

export async function comCliente<T>(pool: pg.Pool, clienteId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // invariant: set_config(..., true) vale só nesta transação; a conexão volta ao pool sem cliente definido.
    await c.query("SELECT set_config('lastro.cliente_id', $1, true)", [clienteId]);
    const resultado = await fn(c);
    await c.query('COMMIT');
    return resultado;
  } catch (erro) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    c.release();
  }
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const diaUtc = (d: Date): string => d.toISOString().slice(0, 10);

function inicioDoMes(agora: Date): Date {
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
}

export class ClientesPostgres implements RepositorioClientes {
  private readonly pool: pg.Pool;
  private readonly retencaoDias: number;

  constructor(pool: pg.Pool, retencaoDias = 30) {
    this.pool = pool;
    this.retencaoDias = retencaoDias;
  }

  async autenticar(chave: string): Promise<Credencial | undefined> {
    const partes = FORMATO_CHAVE.exec(chave);
    if (partes?.[1] === undefined) return undefined;
    const r = await this.pool.query<{ chave_id: string; cliente_id: string; hash: string; escopos: string[]; limite_por_minuto: number }>(
      'SELECT * FROM autenticar_chave($1)',
      [partes[1]],
    );
    const linha = r.rows[0];
    if (linha === undefined) return undefined;
    // hazard: comparação em tempo constante; comparar strings com === vazaria o hash por tempo de resposta.
    if (!timingSafeEqual(Buffer.from(hashChave(chave), 'hex'), Buffer.from(linha.hash, 'hex'))) return undefined;
    return {
      chaveId: linha.chave_id,
      clienteId: linha.cliente_id,
      escopos: linha.escopos.filter((e): e is Escopo => (ESCOPOS as readonly string[]).includes(e)),
      limitePorMinuto: linha.limite_por_minuto,
    };
  }

  registrarConsulta(clienteId: string, chaveId: string | null, consulta: NovaConsulta): Promise<string> {
    return comCliente(this.pool, clienteId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO consulta_log (cliente_id, chave_id, canal, rota, situacao, pergunta, resposta, trechos, modelo,
                                   tokens_entrada, tokens_saida, custo_usd, latencia_ms, expira_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + make_interval(days => $14)) RETURNING id`,
        [
          clienteId,
          chaveId,
          consulta.canal,
          consulta.rota,
          consulta.situacao,
          consulta.pergunta,
          JSON.stringify(consulta.resposta),
          [...consulta.trechos],
          consulta.modelo,
          consulta.tokensEntrada,
          consulta.tokensSaida,
          consulta.custoUsd,
          consulta.latenciaMs,
          this.retencaoDias,
        ],
      );
      const id = r.rows[0]?.id;
      if (id === undefined) throw new Error('INSERT de consulta sem retorno');
      return id;
    });
  }

  async obterConsulta(clienteId: string, id: string): Promise<ConsultaRegistrada | undefined> {
    if (!UUID.test(id)) return undefined;
    return comCliente(this.pool, clienteId, async (c) => {
      const r = await c.query<{ id: string; criada_em: Date; rota: string; situacao: string; pergunta: string; resposta: unknown }>(
        'SELECT id, criada_em, rota, situacao, pergunta, resposta FROM consulta_log WHERE id = $1 AND cliente_id = $2',
        [id, clienteId],
      );
      const l = r.rows[0];
      return l === undefined
        ? undefined
        : { id: l.id, criadaEm: l.criada_em.toISOString(), rota: l.rota, situacao: l.situacao, pergunta: l.pergunta, resposta: l.resposta };
    });
  }

  async limites(clienteId: string): Promise<LimitesCliente | undefined> {
    if (!UUID.test(clienteId)) return undefined;
    const r = await this.pool.query<{
      plano_id: string;
      plano_nome: string;
      limite_por_minuto: number;
      cota_mensal_perguntas: number;
      cota_mensal_verificacoes: number;
      orcamento_mensal_usd: string;
      max_alertas: number;
    }>('SELECT * FROM limites_cliente($1)', [clienteId]);
    const l = r.rows[0];
    return l === undefined
      ? undefined
      : {
          planoId: l.plano_id,
          planoNome: l.plano_nome,
          limitePorMinuto: l.limite_por_minuto,
          cotaMensalPerguntas: l.cota_mensal_perguntas,
          cotaMensalVerificacoes: l.cota_mensal_verificacoes,
          orcamentoMensalUsd: Number(l.orcamento_mensal_usd),
          maxAlertas: l.max_alertas,
        };
  }

  async usoMensal(clienteId: string, agora: Date): Promise<UsoMensal | undefined> {
    const limites = await this.limites(clienteId);
    if (limites === undefined) return undefined;
    // invariant: a cota vem da medição diária, que não some com o expurgo de consulta_log (retenção LGPD).
    const uso = await comCliente(this.pool, clienteId, async (c) =>
      (
        await c.query<{ perguntas: string; verificacoes: string; gasto: string }>(
          `SELECT coalesce(sum(quantidade) FILTER (WHERE metrica = 'perguntas'), 0) AS perguntas,
                  coalesce(sum(quantidade) FILTER (WHERE metrica = 'verificacoes'), 0) AS verificacoes,
                  coalesce(sum(custo_usd), 0) AS gasto
             FROM uso_diario WHERE cliente_id = $1 AND dia >= $2::date`,
          [clienteId, diaUtc(inicioDoMes(agora))],
        )
      ).rows[0],
    );
    return {
      perguntas: Number(uso?.perguntas ?? 0),
      verificacoes: Number(uso?.verificacoes ?? 0),
      gastoUsd: Number(uso?.gasto ?? 0),
      cotaMensalPerguntas: limites.cotaMensalPerguntas,
      cotaMensalVerificacoes: limites.cotaMensalVerificacoes,
      orcamentoMensalUsd: limites.orcamentoMensalUsd,
    };
  }

  async usoPorDia(clienteId: string, desde: string, ate: string): Promise<UsoDiario[]> {
    if (!UUID.test(clienteId)) return [];
    return comCliente(this.pool, clienteId, async (c) => {
      const r = await c.query<{ dia: string; metrica: MetricaUso; quantidade: string; custo_usd: string }>(
        `SELECT to_char(dia, 'YYYY-MM-DD') AS dia, metrica, quantidade, custo_usd
           FROM uso_diario WHERE cliente_id = $1 AND dia >= $2::date AND dia <= $3::date ORDER BY dia, metrica`,
        [clienteId, desde, ate],
      );
      return r.rows.map((l) => ({ dia: l.dia, metrica: l.metrica, quantidade: Number(l.quantidade), custoUsd: Number(l.custo_usd) }));
    });
  }

  async registrarRequisicoes(contagens: readonly ContagemRequisicoes[]): Promise<void> {
    const validas = contagens.filter((c) => UUID.test(c.clienteId) && DIA.test(c.dia) && Number.isInteger(c.quantidade) && c.quantidade > 0);
    if (validas.length === 0) return;
    await this.pool.query('SELECT registrar_requisicoes($1::jsonb)', [
      JSON.stringify(validas.map((c) => ({ cliente_id: c.clienteId, dia: c.dia, quantidade: c.quantidade }))),
    ]);
  }

  async gastoGlobalDesde(desde: Date): Promise<number> {
    const r = await this.pool.query<{ gasto: string }>('SELECT gasto_llm_global($1) AS gasto', [desde]);
    return Number(r.rows[0]?.gasto ?? 0);
  }
}

const TEAM_SLACK = /^T[A-Z0-9]{2,30}$/;

/** Cliente vinculado a um workspace do Slack (papel `lastro_api`, só pela função; a tabela não é legível). */
export async function clienteDoSlack(pool: pg.Pool, teamId: string): Promise<string | undefined> {
  if (!TEAM_SLACK.test(teamId)) return undefined;
  const r = await pool.query<{ id: string | null }>('SELECT cliente_do_slack($1) AS id', [teamId]);
  return r.rows[0]?.id ?? undefined;
}

/** Vincula (ou revincula) um workspace do Slack a um cliente. Papel admin. */
export async function vincularSlack(admin: pg.Pool, teamId: string, clienteId: string): Promise<void> {
  if (!TEAM_SLACK.test(teamId)) throw new Error('team_id do Slack inválido (ex.: T0123ABCD)');
  if (!UUID.test(clienteId)) throw new Error('cliente inválido');
  await admin.query(
    `INSERT INTO canal_slack (team_id, cliente_id) VALUES ($1, $2)
     ON CONFLICT (team_id) DO UPDATE SET cliente_id = EXCLUDED.cliente_id, ativo = true`,
    [teamId, clienteId],
  );
}

export async function desvincularSlack(admin: pg.Pool, teamId: string): Promise<boolean> {
  const r = await admin.query('UPDATE canal_slack SET ativo = false WHERE team_id = $1 AND ativo', [teamId]);
  return r.rowCount === 1;
}

export async function listarSlack(admin: pg.Pool): Promise<{ teamId: string; clienteId: string; nome: string; ativo: boolean }[]> {
  const r = await admin.query<{ team_id: string; cliente_id: string; nome: string; ativo: boolean }>(
    'SELECT s.team_id, s.cliente_id, c.nome, s.ativo FROM canal_slack s JOIN cliente c ON c.id = s.cliente_id ORDER BY s.criado_em',
  );
  return r.rows.map((l) => ({ teamId: l.team_id, clienteId: l.cliente_id, nome: l.nome, ativo: l.ativo }));
}
