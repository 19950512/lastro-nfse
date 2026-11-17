import { FONTES } from '@lastro/core';
import { abrirCuradoria } from '@lastro/db';
import { construirAdmin } from './app.ts';
import { criarProvedorOidc } from './oidc.ts';

function exigir(nome: string): string {
  const valor = process.env[nome];
  if (valor === undefined || valor === '') {
    console.error(`Variável de ambiente ausente: ${nome} (o painel de curadoria exige SSO configurado).`);
    process.exit(1);
  }
  return valor;
}

const host = process.env.LASTRO_ADMIN_HOST ?? '127.0.0.1';
const porta = Number(process.env.LASTRO_ADMIN_PORTA ?? 8081);
const duracaoSessaoMin = Number(process.env.LASTRO_ADMIN_SESSAO_MIN ?? 120);
if (!Number.isInteger(duracaoSessaoMin) || duracaoSessaoMin < 5 || duracaoSessaoMin > 720) {
  console.error('LASTRO_ADMIN_SESSAO_MIN deve ser inteiro entre 5 e 720');
  process.exit(1);
}
const urlPublica = new URL(exigir('LASTRO_ADMIN_URL_PUBLICA'));
const amrAceitos = (process.env.LASTRO_ADMIN_OIDC_AMR ?? 'hwk')
  .split(',')
  .map((a) => a.trim())
  .filter((a) => a !== '');

// hazard: cookies __Host- só funcionam em contexto seguro; fora de 127.0.0.1 o painel precisa de TLS na frente.
if (host !== '127.0.0.1' && host !== '::1') console.warn(`Escutando em ${host}: coloque um proxy com TLS na frente do painel.`);

const oidc = criarProvedorOidc({
  emissor: exigir('LASTRO_ADMIN_OIDC_EMISSOR'),
  clienteId: exigir('LASTRO_ADMIN_OIDC_CLIENTE_ID'),
  clienteSegredo: exigir('LASTRO_ADMIN_OIDC_CLIENTE_SEGREDO'),
  urlRetorno: new URL('/oidc/retorno', urlPublica).toString(),
  amrAceitos,
});

const aberta = await abrirCuradoria();
const app = construirAdmin({ curadoria: aberta.curadoria, oidc, fontes: FONTES, origem: urlPublica.origin, duracaoSessaoMin }, { logger: true });

async function encerrar(): Promise<void> {
  await app.close();
  await aberta.fechar();
}
process.once('SIGINT', () => void encerrar());
process.once('SIGTERM', () => void encerrar());

await app.listen({ host, port: porta });
