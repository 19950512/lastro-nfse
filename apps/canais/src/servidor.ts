import { FONTES } from '@lastro/core';
import { abrirApi, clienteDoSlack } from '@lastro/db';
import { criarModeloAnthropic, criarServicoPerguntas, criarServicoVerificacoes, modeloConfigurado, modeloIndisponivel, type ClienteModelo } from '@lastro/llm';
import { construirCanais, respostaPadraoSlack } from './app.ts';

function falhar(mensagem: string): never {
  console.error(mensagem);
  process.exit(1);
}

const host = process.env.LASTRO_CANAIS_HOST || '127.0.0.1';
const porta = Number(process.env.LASTRO_CANAIS_PORTA || 8083);
const segredoSlack = process.env.LASTRO_SLACK_SEGREDO_ASSINATURA ?? '';
// invariant: sem o signing secret não há como provar que o pedido veio do Slack; o serviço não sobe.
if (segredoSlack.length < 16) falhar('LASTRO_SLACK_SEGREDO_ASSINATURA ausente (Signing Secret do app do Slack)');
const orcamentoDiarioUsd = Number(process.env.LASTRO_LLM_ORCAMENTO_DIARIO_USD ?? 20);
if (!Number.isFinite(orcamentoDiarioUsd) || orcamentoDiarioUsd < 0) falhar('LASTRO_LLM_ORCAMENTO_DIARIO_USD inválido');

if (host !== '127.0.0.1' && host !== '::1') console.warn(`Escutando em ${host}: coloque um proxy com TLS na frente (o Slack só chama HTTPS).`);

let nomeModelo: string;
try {
  nomeModelo = modeloConfigurado(process.env, 'respostas');
} catch (erro) {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exit(1);
}
let modelo: ClienteModelo;
try {
  modelo = criarModeloAnthropic({ modelo: nomeModelo });
} catch (erro) {
  console.warn(`Perguntas desativadas: credencial da Anthropic indisponível (${erro instanceof Error ? erro.message : 'erro'}).`);
  modelo = modeloIndisponivel();
}

const abertas = await abrirApi();
const app = construirCanais(
  {
    perguntas: criarServicoPerguntas({ clientes: abertas.clientes, conhecimento: abertas.conhecimento, fatos: abertas.fatos, modelo, fontes: FONTES, orcamentoDiarioUsd }),
    verificacoes: criarServicoVerificacoes({
      clientes: abertas.clientes,
      verificacoes: abertas.verificacoes,
      conhecimento: abertas.conhecimento,
      fatos: abertas.fatos,
      modelo,
      fontes: FONTES,
      orcamentoDiarioUsd,
    }),
    clienteDoSlack: (team) => clienteDoSlack(abertas.pool, team),
    segredoSlack,
    responder: respostaPadraoSlack(),
    urlPublicaApi: process.env.LASTRO_API_URL_PUBLICA || 'http://127.0.0.1:8080',
  },
  { logger: true },
);

async function encerrar(): Promise<void> {
  await app.close();
  await abertas.fechar();
}
process.once('SIGINT', () => void encerrar());
process.once('SIGTERM', () => void encerrar());

await app.listen({ host, port: porta });
