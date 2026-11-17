import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buscarFonte, FONTES, type Fonte } from '@lastro/core';
import {
  abrirArquivoPostgres,
  abrirPool,
  atualizarCliente,
  criarChave,
  criarCliente,
  desvincularSlack,
  listarPlanos,
  listarSlack,
  relatorioUso,
  salvarPlano,
  vincularSlack,
  ESCOPOS,
  expurgarConsultas,
  expurgarVerificacoes,
  criarCurador,
  desativarCurador,
  gravarNormativo,
  listarCuradores,
  listarPendentesNormativos,
  processarNormasComPapel,
  listarClientes,
  prepararInfra,
  processarComPapel,
  revogarChave,
  type ArquivoAberto,
  type Escopo,
} from '@lastro/db';
import { criarModeloAnthropic, custoUsd, extratorFatos, modeloConfigurado, proporFatosComModelo } from '@lastro/llm';
import { criarAssinatura, criarEnviadorHttps, desativarAssinatura, despachar, listarAssinaturas } from '@lastro/webhooks';
import {
  ArquivoEmDisco,
  CacheRobots,
  coletarFonte,
  criarTransporteHttps,
  LimitadorPorHost,
  USER_AGENT_PADRAO,
} from '@lastro/ingest';
import { gerarRelatorio } from './relatorio.ts';
import { sondar } from './sondagem.ts';

const AJUDA = `Uso: pnpm lastro <comando> [opções]

Comandos:
  preparar   Cria papéis, aplica migrações e configura o bucket com Object Lock
  sondar     Fase 0: valida cada semente do catálogo e gera relatório
             --fonte <id>        (repetível) só estas fontes
             --saida-md <arq>    padrão: docs/SONDAGEM-FASE-0.md
             --saida-json <arq>  padrão: dados/sondagem/<data>.json
  coletar    Coleta as fontes e grava snapshots versionados
             --dados <dir>       arquivo em disco; padrão: dados/arquivo
             --fonte <id>        (repetível) só estas fontes
             --sem-documentos    não segue links de documentos
             --max-documentos <n>
  mudancas   Lista eventos de mudança
             --dados <dir>       arquivo em disco; padrão: dados/arquivo
             --desde <AAAA-MM-DD>
  webhook    adicionar --url https://... [--formato lastro|slack] [--fonte id]... [--tipo t]...
             listar
             remover --id <uuid> [--motivo texto]
  notificar  Envia aos assinantes os eventos pendentes (papel lastro_notificador)
  processar  Extrai trechos, tabelas e leiaute dos snapshots ainda não processados (papel lastro_processador)
             --limite <n>        padrão: 1000
  anomalia   listar                          mudanças anômalas aguardando revisão humana
             liberar|bloquear --evento <uuid> --revisor <nome> --motivo <texto>
  cliente    criar --nome <nome> [--plano id] [--limite-minuto n] [--cota-mensal n] [--cota-verificacoes n]
                   [--orcamento-mensal usd] [--max-alertas n]   (limite informado vira exceção ao plano)
             atualizar --id <uuid> [--plano id] [--ativo sim|nao] [mesmos limites; "plano" remove a exceção]
             listar
  plano      salvar --id <id> --nome <nome> --limite-minuto n --cota-mensal n --cota-verificacoes n
                    --orcamento-mensal usd --max-alertas n      (cria ou altera; vale para quem não tem exceção)
             listar
  uso        [--mes AAAA-MM]  uso medido por cliente no mês (UTC), base da cobrança
  slack      vincular --team <T…> --cliente <uuid> | desvincular --team <T…> | listar
  chave      criar --cliente <uuid> [--escopo leitura|perguntas|verificacoes|alertas]... [--descricao texto]
             revogar --id <uuid>
  expurgar   Apaga consultas e verificações com retenção vencida (LGPD)
  normas     Grafo normativo por regras (sem LLM): identifica cada ato e propõe relações (altera, revoga…)
             --limite <n>        padrão: 1000
  fatos      propor [--limite n] [--fonte id]...  propõe fatos (prazos, obrigações) com o Claude;
             padrão: 5 documentos das fontes N1/N2. Tudo entra como proposta para dupla aprovação
  curador    criar --emissor https://... --sujeito <sub do SSO> --nome <nome> [--papel curador|supervisor]
             listar
             desativar --id <uuid>

Ambiente (.env):
  LASTRO_ARQUIVO       disco (padrão) | postgres
  LASTRO_INTERVALO_MS  intervalo mínimo por host (padrão 2000)`;

function selecionarFontes(ids: readonly string[] | undefined): Fonte[] {
  if (ids === undefined || ids.length === 0) return [...FONTES];
  return ids.map((id) => {
    const fonte = buscarFonte(id);
    if (fonte === undefined) throw new Error(`fonte desconhecida: ${id}`);
    return fonte;
  });
}

function intervaloMs(): number {
  const valor = Number(process.env.LASTRO_INTERVALO_MS ?? 2000);
  // why: abaixo de 1 s por host a coleta deixa de ser "respeitosa" (ARQUITETURA.md §2.1).
  return Number.isFinite(valor) && valor >= 1000 ? valor : 2000;
}

async function abrirArquivo(papel: 'coletor' | 'leitor', dados: string): Promise<ArquivoAberto & { descricao: string }> {
  const tipo = process.env.LASTRO_ARQUIVO ?? 'disco';
  if (tipo === 'disco') {
    return { arquivo: new ArquivoEmDisco(resolve(dados)), descricao: `disco (${dados})`, fechar: () => Promise.resolve() };
  }
  if (tipo === 'postgres') return { ...(await abrirArquivoPostgres(papel)), descricao: `postgres + S3 WORM (papel ${papel})` };
  throw new Error(`LASTRO_ARQUIVO inválido: ${tipo}`);
}

async function comandoPreparar(): Promise<void> {
  const { migracoes } = await prepararInfra();
  console.log(migracoes.length === 0 ? 'Banco já atualizado.' : `Migrações aplicadas: ${migracoes.join(', ')}`);
  console.log('Bucket com Object Lock COMPLIANCE verificado.');
}

async function comandoSondar(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      fonte: { type: 'string', multiple: true },
      'saida-md': { type: 'string', default: 'docs/SONDAGEM-FASE-0.md' },
      'saida-json': { type: 'string' },
    },
  });
  const transporte = criarTransporteHttps();
  const sondagem = await sondar(selecionarFontes(values.fonte), {
    transporte,
    robots: new CacheRobots(transporte, USER_AGENT_PADRAO),
    limitador: new LimitadorPorHost(intervaloMs()),
    userAgent: USER_AGENT_PADRAO,
    timeoutMs: 30_000,
    aoProgredir: (m) => {
      console.error(m);
    },
  });
  const carimbo = sondagem.executadaEm.replace(/[:.]/g, '-');
  const saidaJson = resolve(values['saida-json'] ?? `dados/sondagem/${carimbo}.json`);
  const saidaMd = resolve(values['saida-md']);
  await mkdir(dirname(saidaJson), { recursive: true });
  await mkdir(dirname(saidaMd), { recursive: true });
  await writeFile(saidaJson, `${JSON.stringify(sondagem, null, 2)}\n`);
  await writeFile(saidaMd, gerarRelatorio(sondagem));
  console.log(`JSON: ${saidaJson}\nRelatório: ${saidaMd}`);
}

async function comandoColetar(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dados: { type: 'string', default: 'dados/arquivo' },
      fonte: { type: 'string', multiple: true },
      'sem-documentos': { type: 'boolean', default: false },
      'max-documentos': { type: 'string' },
    },
  });
  const fontes = selecionarFontes(values.fonte);
  const aberto = await abrirArquivo('coletor', values.dados);
  console.error(`Arquivo: ${aberto.descricao}`);
  const transporte = criarTransporteHttps();
  const deps = {
    transporte,
    arquivo: aberto.arquivo,
    robots: new CacheRobots(transporte, USER_AGENT_PADRAO),
    limitador: new LimitadorPorHost(intervaloMs()),
    timeoutMs: 60_000,
  };
  const maxDocumentos = values['max-documentos'] === undefined ? undefined : Number(values['max-documentos']);
  let falhas = 0;
  try {
    for (const fonte of fontes) {
      const resultado = await coletarFonte(fonte, deps, {
        ...(values['sem-documentos'] ? { colherDocumentos: false } : {}),
        ...(maxDocumentos === undefined ? {} : { maxDocumentos }),
      });
      for (const url of resultado.urls) {
        if (url.situacao === 'erro' || url.situacao === 'bloqueado-robots') falhas++;
        console.log(`${fonte.id.padEnd(24)} ${url.situacao.padEnd(16)} ${url.url}${url.situacao === 'erro' ? ` — ${url.detalhe ?? ''}` : ''}`);
      }
      console.error(`${fonte.id}: ${resultado.urls.length} URLs, ${resultado.eventos.length} eventos`);
    }
  } finally {
    await aberto.fechar();
  }
  // why: falha de coleta precisa virar alerta (SEGURANCA.md §13); código de saída ≠ 0 é o gancho para o agendador.
  if (falhas > 0) process.exitCode = 2;
}

async function comandoMudancas(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { dados: { type: 'string', default: 'dados/arquivo' }, desde: { type: 'string' } },
  });
  const desde = values.desde === undefined ? undefined : new Date(`${values.desde}T00:00:00-03:00`);
  if (desde !== undefined && Number.isNaN(desde.getTime())) throw new Error(`data inválida: ${values.desde ?? ''}`);
  const aberto = await abrirArquivo('leitor', values.dados);
  try {
    const eventos = await aberto.arquivo.listarEventos(desde);
    for (const e of eventos) console.log(`${e.detectadoEm}  ${e.tipo.padEnd(15)} ${e.fonteId.padEnd(24)} ${e.url}`);
    console.error(`${eventos.length} eventos (${aberto.descricao})`);
  } finally {
    await aberto.fechar();
  }
}

async function comandoWebhook(args: string[]): Promise<void> {
  const [acao, ...resto] = args;
  const { values } = parseArgs({
    args: resto,
    options: {
      url: { type: 'string' },
      formato: { type: 'string', default: 'lastro' },
      fonte: { type: 'string', multiple: true },
      tipo: { type: 'string', multiple: true },
      id: { type: 'string' },
      motivo: { type: 'string', default: 'removida pelo operador' },
    },
  });
  const pool = abrirPool('admin');
  try {
    if (acao === 'adicionar') {
      if (values.url === undefined) throw new Error('informe --url');
      if (values.formato !== 'lastro' && values.formato !== 'slack') throw new Error('--formato deve ser lastro ou slack');
      const { id, segredo } = await criarAssinatura(
        pool,
        { url: values.url, formato: values.formato, fontes: values.fonte, tipos: values.tipo },
        new Set(FONTES.map((f) => f.id)),
      );
      console.log(`Assinatura ${id} criada.`);
      console.log(`Segredo HMAC (mostrado só agora; guarde no receptor): ${segredo}`);
      return;
    }
    if (acao === 'listar') {
      for (const a of await listarAssinaturas(pool)) {
        console.log(
          `${a.id}  ${a.ativa ? 'ativa   ' : 'inativa '} ${a.formato.padEnd(6)} entregues=${String(a.entregues)} pendentes=${String(a.pendentes)} falhas=${String(a.falhasConsecutivas)}  ${a.url}${a.motivoDesativacao === null ? '' : `  (${a.motivoDesativacao})`}`,
        );
      }
      return;
    }
    if (acao === 'remover') {
      if (values.id === undefined) throw new Error('informe --id');
      console.log((await desativarAssinatura(pool, values.id, values.motivo)) ? 'Assinatura desativada.' : 'Nenhuma assinatura ativa com esse id.');
      return;
    }
    throw new Error('ação de webhook: adicionar | listar | remover');
  } finally {
    await pool.end();
  }
}

async function comandoNotificar(): Promise<void> {
  const pool = abrirPool('notificador');
  try {
    const r = await despachar(pool, criarEnviadorHttps(), {
      urlPublicaApi: process.env.LASTRO_API_URL_PUBLICA ?? 'http://127.0.0.1:8080',
    });
    if (r.emAndamento) {
      console.error('Outro despacho está em andamento; nada feito.');
      return;
    }
    console.log(
      `enfileiradas=${String(r.enfileiradas)} entregues=${String(r.entregues)} falhas=${String(r.falhas)} desistencias=${String(r.desistencias)} desativadas=${String(r.desativadas)}`,
    );
    if (r.falhas > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

async function comandoProcessar(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { limite: { type: 'string', default: '1000' } } });
  const limite = Number(values.limite);
  if (!Number.isInteger(limite) || limite < 1) throw new Error('--limite deve ser inteiro positivo');
  const contagem = new Map<string, number>();
  const resultados = await processarComPapel({
    limite,
    aoProcessar: (r) => {
      contagem.set(r.tipo, (contagem.get(r.tipo) ?? 0) + 1);
      console.log(`${r.tipo.padEnd(8)} ${String(r.itens).padStart(6)}  ${r.url}${r.detalhe === null ? '' : ` — ${r.detalhe}`}`);
    },
  });
  console.error(`${resultados.length} snapshots: ${[...contagem].map(([t, n]) => `${t}=${n}`).join(' ') || 'nada pendente'}`);
  // why: falha de extração precisa virar alerta, como a falha de coleta (SEGURANCA.md §13).
  if ((contagem.get('falha') ?? 0) > 0) process.exitCode = 2;
}

async function comandoAnomalia(args: string[]): Promise<void> {
  const [acao, ...resto] = args;
  const { values } = parseArgs({
    args: resto,
    options: { evento: { type: 'string' }, revisor: { type: 'string' }, motivo: { type: 'string' } },
  });
  const pool = abrirPool('admin');
  try {
    if (acao === 'listar') {
      const r = await pool.query<{ id: string; detectado_em: Date; fonte_id: string; url: string; anomalia: string }>(
        `SELECT e.id, e.detectado_em, e.fonte_id, d.url, e.anomalia
           FROM evento_mudanca e JOIN documento d ON d.id = e.documento_id
          WHERE e.anomalia IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisao_anomalia r WHERE r.evento_id = e.id)
          ORDER BY e.detectado_em`,
      );
      for (const l of r.rows) console.log(`${l.id}  ${l.detectado_em.toISOString()}  ${l.fonte_id.padEnd(24)} ${l.url}\n    ${l.anomalia}`);
      console.error(`${r.rows.length} anomalias aguardando revisão (fora do índice até serem liberadas)`);
      return;
    }
    if (acao !== 'liberar' && acao !== 'bloquear') throw new Error('ação de anomalia: listar | liberar | bloquear');
    if (values.evento === undefined || values.revisor === undefined || values.motivo === undefined) throw new Error('informe --evento, --revisor e --motivo');
    await pool.query('INSERT INTO revisao_anomalia (evento_id, decisao, revisor, motivo) VALUES ($1, $2, $3, $4)', [
      values.evento,
      acao,
      values.revisor,
      values.motivo,
    ]);
    console.log(acao === 'liberar' ? 'Liberada: entra no índice na próxima rodada de processar.' : 'Bloqueada: a versão anterior continua no índice.');
  } finally {
    await pool.end();
  }
}

const OPCOES_LIMITES = {
  'limite-minuto': { type: 'string' },
  'cota-mensal': { type: 'string' },
  'cota-verificacoes': { type: 'string' },
  'orcamento-mensal': { type: 'string' },
  'max-alertas': { type: 'string' },
} as const;

function numero(nome: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${nome} deve ser número não negativo`);
  return n;
}

/** why: em `cliente atualizar`, o valor "plano" remove a exceção e devolve o limite ao valor do plano. */
function excecao(nome: string, v: string | undefined): number | null | undefined {
  return v === 'plano' ? null : numero(nome, v);
}

async function comandoCliente(args: string[]): Promise<void> {
  const [acao, ...resto] = args;
  const { values } = parseArgs({
    args: resto,
    options: { nome: { type: 'string' }, id: { type: 'string' }, plano: { type: 'string' }, ativo: { type: 'string' }, ...OPCOES_LIMITES },
  });
  const pool = abrirPool('admin');
  try {
    if (acao === 'criar') {
      if (values.nome === undefined) throw new Error('informe --nome');
      const id = await criarCliente(pool, {
        nome: values.nome,
        plano: values.plano,
        limitePorMinuto: numero('limite-minuto', values['limite-minuto']),
        cotaMensalPerguntas: numero('cota-mensal', values['cota-mensal']),
        cotaMensalVerificacoes: numero('cota-verificacoes', values['cota-verificacoes']),
        orcamentoMensalUsd: numero('orcamento-mensal', values['orcamento-mensal']),
        maxAlertas: numero('max-alertas', values['max-alertas']),
      });
      console.log(`Cliente ${id} criado (plano ${values.plano ?? 'padrao'}). Crie uma chave com: pnpm lastro chave criar --cliente ${id} --escopo leitura --escopo perguntas`);
      return;
    }
    if (acao === 'atualizar') {
      if (values.id === undefined) throw new Error('informe --id');
      if (values.ativo !== undefined && values.ativo !== 'sim' && values.ativo !== 'nao') throw new Error('--ativo deve ser sim ou nao');
      const ok = await atualizarCliente(pool, values.id, {
        plano: values.plano,
        ativo: values.ativo === undefined ? undefined : values.ativo === 'sim',
        limitePorMinuto: excecao('limite-minuto', values['limite-minuto']),
        cotaMensalPerguntas: excecao('cota-mensal', values['cota-mensal']),
        cotaMensalVerificacoes: excecao('cota-verificacoes', values['cota-verificacoes']),
        orcamentoMensalUsd: excecao('orcamento-mensal', values['orcamento-mensal']),
        maxAlertas: excecao('max-alertas', values['max-alertas']),
      });
      console.log(ok ? 'Cliente atualizado.' : 'Nada alterado (cliente inexistente ou nenhuma opção informada).');
      return;
    }
    if (acao === 'listar') {
      for (const c of await listarClientes(pool)) console.log(`${c.id}  ${c.ativo ? 'ativo  ' : 'inativo'}  ${c.planoId.padEnd(16)} chaves=${String(c.chavesAtivas)}  ${c.nome}`);
      return;
    }
    throw new Error('ação de cliente: criar | atualizar | listar');
  } finally {
    await pool.end();
  }
}

async function comandoPlano(args: string[]): Promise<void> {
  const [acao, ...resto] = args;
  const { values } = parseArgs({ args: resto, options: { id: { type: 'string' }, nome: { type: 'string' }, ...OPCOES_LIMITES } });
  const pool = abrirPool('admin');
  try {
    if (acao === 'salvar') {
      const exigido = (nome: keyof typeof OPCOES_LIMITES): number => {
        const v = numero(nome, values[nome]);
        if (v === undefined) throw new Error(`informe --${nome}`);
        return v;
      };
      if (values.id === undefined || values.nome === undefined) throw new Error('informe --id e --nome');
      await salvarPlano(pool, {
        id: values.id,
        nome: values.nome,
        limitePorMinuto: exigido('limite-minuto'),
        cotaMensalPerguntas: exigido('cota-mensal'),
        cotaMensalVerificacoes: exigido('cota-verificacoes'),
        orcamentoMensalUsd: exigido('orcamento-mensal'),
        maxAlertas: exigido('max-alertas'),
      });
      console.log(`Plano ${values.id} salvo; vale para todos os clientes do plano sem exceção.`);
      return;
    }
    if (acao === 'listar') {
      for (const p of await listarPlanos(pool)) {
        console.log(
          `${p.id.padEnd(16)} ${String(p.limitePorMinuto).padStart(6)}/min  perguntas=${String(p.cotaMensalPerguntas)}  verificações=${String(p.cotaMensalVerificacoes)}  US$ ${p.orcamentoMensalUsd.toFixed(2)}/mês  alertas=${String(p.maxAlertas)}  clientes=${String(p.clientes)}  ${p.nome}`,
        );
      }
      return;
    }
    throw new Error('ação de plano: salvar | listar');
  } finally {
    await pool.end();
  }
}

async function comandoUso(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { mes: { type: 'string' } } });
  const mes = values.mes ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new Error('--mes no formato AAAA-MM');
  const inicio = new Date(`${mes}-01T00:00:00Z`);
  const fim = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, 1));
  const pool = abrirPool('admin');
  try {
    const linhas = await relatorioUso(pool, `${mes}-01`, fim.toISOString().slice(0, 10));
    for (const l of linhas) {
      console.log(
        `${l.clienteId}  ${l.planoId.padEnd(16)} req=${String(l.requisicoes).padStart(8)}  perguntas=${String(l.perguntas).padStart(6)}  verificações=${String(l.verificacoes).padStart(6)}  US$ ${l.custoUsd.toFixed(4)}  ${l.nome}`,
      );
    }
    console.error(`${String(linhas.length)} clientes com uso em ${mes} (UTC).`);
  } finally {
    await pool.end();
  }
}

async function comandoSlack(args: string[]): Promise<void> {
  const [acao, ...resto] = args;
  const { values } = parseArgs({ args: resto, options: { team: { type: 'string' }, cliente: { type: 'string' } } });
  const pool = abrirPool('admin');
  try {
    if (acao === 'vincular') {
      if (values.team === undefined || values.cliente === undefined) throw new Error('informe --team e --cliente');
      await vincularSlack(pool, values.team, values.cliente);
      console.log(`Workspace ${values.team} vinculado ao cliente ${values.cliente}; /lastro passa a consumir a cota desse cliente.`);
      return;
    }
    if (acao === 'desvincular') {
      if (values.team === undefined) throw new Error('informe --team');
      console.log((await desvincularSlack(pool, values.team)) ? 'Workspace desvinculado.' : 'Nenhum vínculo ativo com esse team_id.');
      return;
    }
    if (acao === 'listar') {
      for (const s of await listarSlack(pool)) console.log(`${s.teamId.padEnd(14)} ${s.ativo ? 'ativo  ' : 'inativo'}  ${s.clienteId}  ${s.nome}`);
      return;
    }
    throw new Error('ação de slack: vincular | desvincular | listar');
  } finally {
    await pool.end();
  }
}

async function comandoChave(args: string[]): Promise<void> {
  const [acao, ...resto] = args;
  const { values } = parseArgs({
    args: resto,
    options: { cliente: { type: 'string' }, escopo: { type: 'string', multiple: true }, descricao: { type: 'string' }, id: { type: 'string' } },
  });
  const pool = abrirPool('admin');
  try {
    if (acao === 'criar') {
      if (values.cliente === undefined) throw new Error('informe --cliente');
      const escopos = (values.escopo ?? ['leitura']).map((e) => {
        if (!(ESCOPOS as readonly string[]).includes(e)) throw new Error(`escopo inválido: ${e}`);
        return e as Escopo;
      });
      const { id, chave } = await criarChave(pool, values.cliente, escopos, values.descricao ?? null);
      console.log(`Chave ${id} criada (escopos: ${escopos.join(', ')}).`);
      console.log(`Segredo (mostrado só agora; o banco guarda apenas o hash): ${chave}`);
      return;
    }
    if (acao === 'revogar') {
      if (values.id === undefined) throw new Error('informe --id');
      console.log((await revogarChave(pool, values.id)) ? 'Chave revogada.' : 'Nenhuma chave ativa com esse id.');
      return;
    }
    throw new Error('ação de chave: criar | revogar');
  } finally {
    await pool.end();
  }
}

async function comandoNormas(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { limite: { type: 'string', default: '1000' } } });
  const limite = Number(values.limite);
  if (!Number.isInteger(limite) || limite < 1) throw new Error('--limite deve ser inteiro positivo');
  const r = await processarNormasComPapel({
    limite,
    aoProcessar: (x) => {
      if (x.chave !== null) console.log(`${x.chave.padEnd(48)} relações=${String(x.relacoes).padStart(3)} gravadas=${String(x.itensGravados).padStart(3)}  ${x.url}`);
    },
  });
  console.error(`${r.length} versões analisadas; ${r.filter((x) => x.chave !== null).length} atos identificados; propostas aguardam curadoria (pnpm admin).`);
}

async function comandoFatos(args: string[]): Promise<void> {
  const [acao, ...resto] = args;
  if (acao !== 'propor') throw new Error('ação de fatos: propor');
  const { values } = parseArgs({ args: resto, options: { limite: { type: 'string', default: '5' }, fonte: { type: 'string', multiple: true } } });
  const limite = Number(values.limite);
  if (!Number.isInteger(limite) || limite < 1 || limite > 200) throw new Error('--limite deve ser inteiro entre 1 e 200');
  // why: fato de prazo ou obrigação só sustenta veredito com evidência N1/N2; propor a partir de N3 só gastaria curadoria.
  const fontes = values.fonte ?? FONTES.filter((f) => f.nivel !== 'N3').map((f) => f.id);
  const nomeModelo = modeloConfigurado(process.env, 'fatos');
  const extrator = extratorFatos(nomeModelo);
  const modelo = criarModeloAnthropic({ modelo: nomeModelo });
  console.error(`Modelo: ${nomeModelo} (extrator ${extrator}).`);
  const pool = abrirPool('processador');
  let custo = 0;
  try {
    for (const doc of await listarPendentesNormativos(pool, extrator, { limite, fontes })) {
      const { resultado, uso } = await proporFatosComModelo(doc, { modelo });
      if (uso !== null) custo += custoUsd(uso);
      const gravados = await gravarNormativo(pool, doc, extrator, resultado);
      console.log(`${String(gravados).padStart(3)} fatos  ${doc.url}${resultado.detalhe === null ? '' : ` — ${resultado.detalhe}`}`);
    }
  } finally {
    await pool.end();
  }
  console.error(`Custo estimado de LLM: US$ ${custo.toFixed(4)}. Fatos propostos aguardam dupla aprovação no painel de curadoria.`);
}

async function comandoCurador(args: string[]): Promise<void> {
  const [acao, ...resto] = args;
  const { values } = parseArgs({
    args: resto,
    options: { emissor: { type: 'string' }, sujeito: { type: 'string' }, nome: { type: 'string' }, papel: { type: 'string', default: 'curador' }, id: { type: 'string' } },
  });
  const pool = abrirPool('admin');
  try {
    if (acao === 'criar') {
      if (values.emissor === undefined || values.sujeito === undefined || values.nome === undefined) throw new Error('informe --emissor, --sujeito e --nome');
      if (values.papel !== 'curador' && values.papel !== 'supervisor') throw new Error('--papel deve ser curador ou supervisor');
      const id = await criarCurador(pool, { emissor: values.emissor, sujeito: values.sujeito, nome: values.nome, papel: values.papel });
      console.log(`Curador ${id} criado (${values.papel}). O login é pelo SSO: emissor ${values.emissor}, sujeito ${values.sujeito}.`);
      return;
    }
    if (acao === 'listar') {
      for (const c of await listarCuradores(pool)) console.log(`${c.id}  ${c.ativo ? 'ativo  ' : 'inativo'}  ${c.papel.padEnd(10)} ${c.nome}  (${c.emissor} · ${c.sujeito})`);
      return;
    }
    if (acao === 'desativar') {
      if (values.id === undefined) throw new Error('informe --id');
      console.log((await desativarCurador(pool, values.id)) ? 'Curador desativado; sessões encerradas.' : 'Nenhum curador ativo com esse id.');
      return;
    }
    throw new Error('ação de curador: criar | listar | desativar');
  } finally {
    await pool.end();
  }
}

async function comandoExpurgar(): Promise<void> {
  const pool = abrirPool('admin');
  try {
    console.log(`${String(await expurgarConsultas(pool))} consultas e ${String(await expurgarVerificacoes(pool))} verificações vencidas apagadas.`);
  } finally {
    await pool.end();
  }
}

async function principal(argv: string[]): Promise<void> {
  const [comando, ...resto] = argv;
  switch (comando) {
    case 'processar':
      return comandoProcessar(resto);
    case 'anomalia':
      return comandoAnomalia(resto);
    case 'cliente':
      return comandoCliente(resto);
    case 'plano':
      return comandoPlano(resto);
    case 'uso':
      return comandoUso(resto);
    case 'slack':
      return comandoSlack(resto);
    case 'chave':
      return comandoChave(resto);
    case 'expurgar':
      return comandoExpurgar();
    case 'normas':
      return comandoNormas(resto);
    case 'fatos':
      return comandoFatos(resto);
    case 'curador':
      return comandoCurador(resto);
    case 'preparar':
      return comandoPreparar();
    case 'webhook':
      return comandoWebhook(resto);
    case 'notificar':
      return comandoNotificar();
    case 'sondar':
      return comandoSondar(resto);
    case 'coletar':
      return comandoColetar(resto);
    case 'mudancas':
      return comandoMudancas(resto);
    default:
      console.log(AJUDA);
      if (comando !== undefined && comando !== '--help' && comando !== 'ajuda') process.exitCode = 1;
  }
}

principal(process.argv.slice(2)).catch((erro: unknown) => {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exitCode = 1;
});
