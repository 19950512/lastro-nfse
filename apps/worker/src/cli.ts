import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buscarFonte, FONTES, type Fonte } from '@lastro/core';
import { abrirArquivoPostgres, abrirPool, prepararInfra, type ArquivoAberto } from '@lastro/db';
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

async function principal(argv: string[]): Promise<void> {
  const [comando, ...resto] = argv;
  switch (comando) {
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
