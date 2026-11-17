import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { LimitadorTaxa } from '@lastro/core';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { metadadosRecurso, type TokenValido } from './autorizacao.ts';
import { criarServidorMcp, ESCOPO_LEITURA, ESCOPO_PERGUNTAS, ESCOPO_VERIFICACOES, type DependenciasMcp } from './ferramentas.ts';

export interface OpcoesHttp {
  readonly recurso: string;
  readonly emissor: string;
  verificar(token: string): Promise<TokenValido | undefined>;
  /** Origens de navegador aceitas; requisição sem Origin (cliente fora de navegador) é aceita. */
  readonly origensPermitidas: readonly string[];
  /** Valores aceitos no cabeçalho Host (contra DNS rebinding). */
  readonly hostsPermitidos: readonly string[];
  readonly limitePorMinuto: number;
  readonly agora?: () => number;
}

const MAX_CORPO = 64 * 1024;
const CAMINHO_MCP = '/mcp';
const CAMINHOS_METADADOS = new Set(['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${CAMINHO_MCP}`]);

function json(res: ServerResponse, status: number, corpo: unknown, cabecalhos: Record<string, string> = {}): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cabecalhos });
  res.end(JSON.stringify(corpo));
  return true;
}

async function lerCorpo(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const parte of req as AsyncIterable<Buffer>) {
    total += parte.length;
    if (total > MAX_CORPO) throw new Error('corpo-muito-grande');
    partes.push(parte);
  }
  return JSON.parse(Buffer.concat(partes).toString('utf8')) as unknown;
}

/**
 * Transporte Streamable HTTP sem sessão: cada requisição é autenticada e ganha servidor e transporte
 * próprios (SEGURANCA.md §10 — o ID de sessão nunca serve como autenticação, porque não há sessão).
 */
export function criarHandlerHttp(deps: DependenciasMcp, opcoes: OpcoesHttp): RequestListener {
  const limitador = new LimitadorTaxa();
  const agora = opcoes.agora ?? (() => Date.now());
  const urlMetadados = `${new URL(opcoes.recurso).origin}/.well-known/oauth-protected-resource${new URL(opcoes.recurso).pathname === CAMINHO_MCP ? CAMINHO_MCP : ''}`;
  const desafio = (erro: string, extra = '') => `Bearer resource_metadata="${urlMetadados}", error="${erro}"${extra}`;

  return (req, res) => {
    void (async () => {
      const caminho = (req.url ?? '/').split('?')[0] ?? '/';
      // hazard: DNS rebinding — um site malicioso pode apontar seu domínio para 127.0.0.1; Host e Origin são conferidos.
      const host = req.headers.host ?? '';
      if (!opcoes.hostsPermitidos.includes(host)) return json(res, 421, { erro: 'host-nao-permitido' });
      const origem = req.headers.origin;
      if (origem !== undefined && !opcoes.origensPermitidas.includes(origem)) return json(res, 403, { erro: 'origem-nao-permitida' });

      if (req.method === 'GET' && CAMINHOS_METADADOS.has(caminho)) {
        return json(res, 200, metadadosRecurso(opcoes, [ESCOPO_LEITURA, ESCOPO_PERGUNTAS, ESCOPO_VERIFICACOES]), { 'cache-control': 'public, max-age=3600' });
      }
      if (caminho !== CAMINHO_MCP) return json(res, 404, { erro: 'nao-encontrado' });

      const porIp = limitador.consumir(`ip:${req.socket.remoteAddress ?? '?'}`, opcoes.limitePorMinuto * 5, agora());
      if (!porIp.permitido) return json(res, 429, { erro: 'limite-de-requisicoes' }, { 'retry-after': String(porIp.tenteEmSegundos) });

      const token = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.headers.authorization ?? '')?.[1];
      const valido = token === undefined ? undefined : await opcoes.verificar(token);
      if (token === undefined || valido === undefined) {
        return json(res, 401, { erro: 'nao-autenticado' }, { 'www-authenticate': desafio('invalid_token') });
      }
      if (!valido.escopos.includes(ESCOPO_LEITURA)) {
        return json(res, 403, { erro: 'escopo-insuficiente' }, { 'www-authenticate': desafio('insufficient_scope', `, scope="${ESCOPO_LEITURA}"`) });
      }
      const porSujeito = limitador.consumir(`sub:${valido.sujeito}`, opcoes.limitePorMinuto, agora());
      if (!porSujeito.permitido) return json(res, 429, { erro: 'limite-de-requisicoes' }, { 'retry-after': String(porSujeito.tenteEmSegundos) });

      if (req.method !== 'POST') return json(res, 405, { erro: 'metodo-nao-permitido' }, { allow: 'POST' });

      let corpo: unknown;
      try {
        corpo = await lerCorpo(req);
      } catch (e) {
        return json(res, e instanceof Error && e.message === 'corpo-muito-grande' ? 413 : 400, { erro: 'corpo-invalido' });
      }
      const servidor = criarServidorMcp(deps, { clienteId: valido.clienteId, escopos: valido.escopos });
      const transporte = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on('close', () => {
        void transporte.close();
        void servidor.close();
      });
      await servidor.connect(transporte);
      await transporte.handleRequest(req, res, corpo);
    })().catch(() => {
      // hazard: nunca devolver mensagem interna ao cliente; a falha vira 500 genérico.
      if (!res.headersSent) json(res, 500, { erro: 'interno' });
      else res.end();
    });
  };
}
