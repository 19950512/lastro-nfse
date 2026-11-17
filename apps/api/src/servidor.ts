import { FONTES, securityTxtDoAmbiente } from '@lastro/core';
import { abrirApi } from '@lastro/db';
import { criarModeloAnthropic, criarServicoPerguntas, criarServicoVerificacoes, modeloConfigurado, modeloIndisponivel, type ClienteModelo } from '@lastro/llm';
import { AlertasPostgres } from '@lastro/webhooks';
import { construirApp } from './app.ts';

const host = process.env.LASTRO_API_HOST ?? '127.0.0.1';
const porta = Number(process.env.LASTRO_API_PORTA ?? 8080);
const local = host === '127.0.0.1' || host === '::1';
const orcamentoDiarioUsd = Number(process.env.LASTRO_LLM_ORCAMENTO_DIARIO_USD ?? 20);
if (!Number.isFinite(orcamentoDiarioUsd) || orcamentoDiarioUsd < 0) {
  console.error('LASTRO_LLM_ORCAMENTO_DIARIO_USD inválido');
  process.exit(1);
}

// hazard: fora de 127.0.0.1 a API precisa de TLS na frente (proxy reverso); ela mesma só fala HTTP.
if (!local) console.warn(`Escutando em ${host}: coloque um proxy com TLS na frente. O painel sem autenticação fica desligado.`);

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

const urlPublica = process.env.LASTRO_API_URL_PUBLICA ?? `http://${host}:${String(porta)}`;
// invariant: configuração inválida do security.txt impede a subida; arquivo errado é pior que nenhum.
const securityTxt = securityTxtDoAmbiente(process.env, urlPublica.startsWith('https://') ? new URL('/.well-known/security.txt', urlPublica).toString() : undefined);

const abertas = await abrirApi();
const app = construirApp(
  {
    consultas: abertas.consultas,
    lerOriginal: abertas.lerOriginal,
    fontes: FONTES,
    autenticacao: abertas.clientes,
    conhecimento: abertas.conhecimento,
    perguntas: criarServicoPerguntas({
      clientes: abertas.clientes,
      conhecimento: abertas.conhecimento,
      fatos: abertas.fatos,
      iss: abertas.iss,
      modelo,
      fontes: FONTES,
      orcamentoDiarioUsd,
    }),
    fatos: abertas.fatos,
    iss: abertas.iss,
    verificacoes: criarServicoVerificacoes({
      clientes: abertas.clientes,
      verificacoes: abertas.verificacoes,
      conhecimento: abertas.conhecimento,
      fatos: abertas.fatos,
      modelo,
      fontes: FONTES,
      orcamentoDiarioUsd,
    }),
    contas: abertas.clientes,
    alertas: new AlertasPostgres(abertas.pool, new Set(FONTES.map((f) => f.id))),
    urlPublica,
  },
  { logger: true, painel: local, securityTxt },
);

async function encerrar(): Promise<void> {
  await app.close();
  await abertas.fechar();
}
process.once('SIGINT', () => void encerrar());
process.once('SIGTERM', () => void encerrar());

await app.listen({ host, port: porta });
