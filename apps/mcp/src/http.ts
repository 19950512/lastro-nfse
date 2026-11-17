import { createServer } from 'node:http';
import { createRemoteJWKSet } from 'jose';
import { criarVerificador } from './autorizacao.ts';
import { abrirDependencias } from './dependencias.ts';
import { criarHandlerHttp } from './http-app.ts';

function exigir(nome: string): string {
  const valor = process.env[nome];
  if (valor === undefined || valor === '') {
    console.error(`Recusando iniciar: ${nome} ausente. O MCP remoto só funciona com OAuth configurado (SEGURANCA.md §10).`);
    process.exit(1);
  }
  return valor;
}

const recurso = exigir('LASTRO_MCP_URL_RECURSO');
const emissor = exigir('LASTRO_MCP_OAUTH_EMISSOR');
const jwks = new URL(exigir('LASTRO_MCP_OAUTH_JWKS'));
if (jwks.protocol !== 'https:') {
  console.error('LASTRO_MCP_OAUTH_JWKS precisa ser https.');
  process.exit(1);
}
const host = process.env.LASTRO_MCP_HOST ?? '127.0.0.1';
const porta = Number(process.env.LASTRO_MCP_PORTA ?? 8090);
const limitePorMinuto = Number(process.env.LASTRO_MCP_LIMITE_MINUTO ?? 60);
const origens = (process.env.LASTRO_MCP_ORIGENS ?? '').split(',').map((o) => o.trim()).filter((o) => o !== '');
const hostRecurso = new URL(recurso).host;

const { deps, aberta } = await abrirDependencias();
const servidor = createServer(
  { requestTimeout: 150_000, headersTimeout: 10_000 },
  criarHandlerHttp(deps, {
    recurso,
    emissor,
    verificar: criarVerificador({ recurso, emissor, chaves: createRemoteJWKSet(jwks, { timeoutDuration: 5000 }) }),
    origensPermitidas: origens,
    hostsPermitidos: [hostRecurso, `127.0.0.1:${String(porta)}`, `localhost:${String(porta)}`],
    limitePorMinuto,
  }),
);

process.once('SIGTERM', () => {
  servidor.close();
  void aberta.fechar();
});
// hazard: fora de 127.0.0.1 precisa de TLS na frente; o servidor fala HTTP puro.
servidor.listen(porta, host, () => {
  console.error(`MCP (Streamable HTTP, OAuth) em http://${host}:${String(porta)}/mcp — recurso ${recurso}`);
});
