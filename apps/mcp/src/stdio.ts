import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { abrirDependencias } from './dependencias.ts';
import { criarServidorMcp, ESCOPO_LEITURA, ESCOPO_PERGUNTAS, ESCOPO_VERIFICACOES } from './ferramentas.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cliente = process.env.LASTRO_MCP_CLIENTE_ID ?? '';

// why: no stdio o processo é do próprio operador (uso local); perguntas só com um cliente explícito, para valer cota e registro.
const clienteId = UUID.test(cliente) ? cliente : null;
if (clienteId === null) console.error('LASTRO_MCP_CLIENTE_ID não definido: perguntar_nfse fica desativada; as demais ferramentas funcionam.');

const { deps, aberta } = await abrirDependencias();
const servidor = criarServidorMcp(deps, { clienteId, escopos: [ESCOPO_LEITURA, ...(clienteId === null ? [] : [ESCOPO_PERGUNTAS, ESCOPO_VERIFICACOES])] });

async function encerrar(): Promise<void> {
  await servidor.close();
  await aberta.fechar();
}
process.once('SIGINT', () => void encerrar());
process.once('SIGTERM', () => void encerrar());

await servidor.connect(new StdioServerTransport());
