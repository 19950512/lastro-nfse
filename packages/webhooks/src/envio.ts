import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { criarLookupSeguro, EnderecoBloqueado } from '@lastro/ingest';
import { validarUrlWebhook } from './url.ts';

export interface ResultadoEnvio {
  readonly ok: boolean;
  readonly status: number | null;
  readonly erro: string | null;
}

export type Enviador = (url: string, corpo: string, cabecalhos: Record<string, string>) => Promise<ResultadoEnvio>;

export interface OpcoesEnvio {
  readonly lookup?: LookupFunction;
  readonly ca?: string | Buffer;
  readonly timeoutMs?: number;
}

const MAX_RESPOSTA = 8 * 1024;

function mensagem(erro: unknown): string {
  if (erro instanceof EnderecoBloqueado || (erro instanceof Error && erro.cause instanceof EnderecoBloqueado)) {
    return 'host resolve para endereço não público';
  }
  const codigo = (erro as NodeJS.ErrnoException | undefined)?.code;
  const texto = erro instanceof Error ? erro.message : String(erro);
  return (codigo === undefined ? texto : `${codigo}: ${texto}`).slice(0, 300);
}

/**
 * POST HTTPS para o assinante (SEGURANCA.md §9).
 *
 * invariant: o endereço é validado no momento da conexão (lookup seguro com DNS fixado), redirecionamento
 * nunca é seguido (3xx conta como falha) e a resposta do cliente é lida no máximo até 8 KiB.
 */
export function criarEnviadorHttps(opcoes: OpcoesEnvio = {}): Enviador {
  const lookup = opcoes.lookup ?? criarLookupSeguro();
  const timeoutMs = opcoes.timeoutMs ?? 10_000;
  return (url, corpo, cabecalhos) =>
    new Promise((resolve) => {
      const validacao = validarUrlWebhook(url);
      if (!validacao.valida) {
        resolve({ ok: false, status: null, erro: validacao.motivo });
        return;
      }
      let resolvido = false;
      const concluir = (r: ResultadoEnvio): void => {
        if (resolvido) return;
        resolvido = true;
        resolve(r);
      };
      const requisicao = https.request(
        validacao.url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(corpo)),
            'user-agent': 'LastroWebhook/0.1',
            ...cabecalhos,
          },
          lookup,
          agent: false,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          signal: AbortSignal.timeout(timeoutMs),
          ...(opcoes.ca === undefined ? {} : { ca: opcoes.ca }),
        },
        (resposta) => {
          const status = resposta.statusCode ?? 0;
          let lidos = 0;
          resposta.on('data', (parte: Buffer) => {
            lidos += parte.byteLength;
            if (lidos > MAX_RESPOSTA) resposta.destroy();
          });
          resposta.on('error', () => undefined);
          const ok = status >= 200 && status < 300;
          concluir({
            ok,
            status,
            erro: ok ? null : status >= 300 && status < 400 ? 'redirecionamento não é seguido' : `HTTP ${String(status)}`,
          });
        },
      );
      requisicao.on('error', (erro) => {
        concluir({ ok: false, status: null, erro: mensagem(erro) });
      });
      requisicao.end(corpo);
    });
}
