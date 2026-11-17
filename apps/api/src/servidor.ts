import { FONTES } from '@lastro/core';
import { abrirConsultas } from '@lastro/db';
import { construirApp } from './app.ts';

const host = process.env.LASTRO_API_HOST ?? '127.0.0.1';
const porta = Number(process.env.LASTRO_API_PORTA ?? 8080);

// hazard: sem autenticação nem limite de requisições (requisitos da Fase 2); expor fora de 127.0.0.1 só atrás de proxy que faça isso.
if (host !== '127.0.0.1' && host !== '::1' && process.env.LASTRO_API_EXPOR !== 'sim') {
  console.error(`Recusando escutar em ${host}: a API ainda não tem autenticação. Defina LASTRO_API_EXPOR=sim se houver proxy autenticado na frente.`);
  process.exit(1);
}

const abertas = await abrirConsultas();
const app = construirApp({ consultas: abertas.consultas, lerOriginal: abertas.lerOriginal, fontes: FONTES }, { logger: true });

async function encerrar(): Promise<void> {
  await app.close();
  await abertas.fechar();
}
process.once('SIGINT', () => void encerrar());
process.once('SIGTERM', () => void encerrar());

await app.listen({ host, port: porta });
