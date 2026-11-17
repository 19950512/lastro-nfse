import { FONTES, securityTxtDoAmbiente } from '@lastro/core';
import { abrirApi } from '@lastro/db';
import { criarModeloAnthropic, criarServicoPerguntas, criarServicoVerificacoes, modeloConfigurado, modeloIndisponivel, type ClienteModelo } from '@lastro/llm';
import { construirPortal } from './app.ts';
import { criarCaptcha, PROVEDORES_CAPTCHA, type ProvedorCaptcha } from './captcha.ts';

function falhar(mensagem: string): never {
  console.error(mensagem);
  process.exit(1);
}

const host = process.env.LASTRO_PORTAL_HOST || '127.0.0.1';
const porta = Number(process.env.LASTRO_PORTAL_PORTA || 8082);
const local = host === '127.0.0.1' || host === '::1';
const urlPublica = new URL(process.env.LASTRO_PORTAL_URL_PUBLICA || (local ? `http://${host}:${String(porta)}` : falhar('LASTRO_PORTAL_URL_PUBLICA é obrigatória fora de 127.0.0.1')));
const clienteId = process.env.LASTRO_PORTAL_CLIENTE_ID ?? '';
if (!/^[0-9a-f-]{36}$/.test(clienteId)) falhar('LASTRO_PORTAL_CLIENTE_ID ausente: crie com `pnpm lastro cliente criar --nome "Portal público" --plano portal-publico`');

const provedor = (process.env.LASTRO_PORTAL_CAPTCHA || (local ? 'desligado' : '')) as ProvedorCaptcha;
if (!PROVEDORES_CAPTCHA.includes(provedor)) falhar(`LASTRO_PORTAL_CAPTCHA deve ser ${PROVEDORES_CAPTCHA.join(' | ')}`);
// invariant: sem CAPTCHA o portal só sobe em 127.0.0.1 (desenvolvimento); exposto, exige CAPTCHA (SEGURANCA.md §11 e §15).
if (provedor === 'desligado' && !local) falhar('CAPTCHA desligado só é aceito com o portal em 127.0.0.1');
const captcha = criarCaptcha({
  provedor,
  chaveSite: process.env.LASTRO_PORTAL_CAPTCHA_SITE,
  segredo: process.env.LASTRO_PORTAL_CAPTCHA_SEGREDO,
  hostEsperado: urlPublica.hostname,
});

const inteiro = (nome: string, padrao: number, max: number): number => {
  const v = Number(process.env[nome] ?? padrao);
  return Number.isInteger(v) && v >= 1 && v <= max ? v : falhar(`${nome} deve ser inteiro entre 1 e ${String(max)}`);
};
const limiteLlmPorHoraIp = inteiro('LASTRO_PORTAL_LIMITE_HORA_IP', 10, 1000);
const orcamentoDiarioUsd = Number(process.env.LASTRO_LLM_ORCAMENTO_DIARIO_USD ?? 20);
if (!Number.isFinite(orcamentoDiarioUsd) || orcamentoDiarioUsd < 0) falhar('LASTRO_LLM_ORCAMENTO_DIARIO_USD inválido');
const proxyConfiavel = (process.env.LASTRO_PORTAL_PROXY ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter((p) => p !== '');
const securityTxt = securityTxtDoAmbiente(process.env, urlPublica.protocol === 'https:' ? new URL('/.well-known/security.txt', urlPublica).toString() : undefined);

if (!local) console.warn(`Escutando em ${host}: coloque um proxy com TLS na frente e informe o IP dele em LASTRO_PORTAL_PROXY.`);

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
  console.warn(`Perguntas e verificações desativadas: credencial da Anthropic indisponível (${erro instanceof Error ? erro.message : 'erro'}).`);
  modelo = modeloIndisponivel();
}

const abertas = await abrirApi();
// invariant: o portal não sobe com cliente inexistente ou inativo; sem ele não há cota nem orçamento para conferir.
if ((await abertas.clientes.limites(clienteId)) === undefined) {
  await abertas.fechar();
  falhar(`cliente do portal ${clienteId} inexistente ou inativo`);
}

const app = construirPortal(
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
    clienteId,
    captcha,
    origem: urlPublica.origin,
    urlPublicaApi: process.env.LASTRO_API_URL_PUBLICA || 'http://127.0.0.1:8080',
  },
  { logger: true, limiteLlmPorHoraIp, proxyConfiavel, securityTxt },
);

async function encerrar(): Promise<void> {
  await app.close();
  await abertas.fechar();
}
process.once('SIGINT', () => void encerrar());
process.once('SIGTERM', () => void encerrar());

await app.listen({ host, port: porta });
