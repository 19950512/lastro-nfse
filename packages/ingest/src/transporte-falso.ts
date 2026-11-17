import type { RespostaBruta, Transporte } from './http.ts';

export interface RespostaFalsa {
  readonly status?: number;
  readonly cabecalhos?: Record<string, string>;
  readonly corpo?: string | Buffer;
}

export type Rota = RespostaFalsa | ((cabecalhos: Record<string, string>) => RespostaFalsa);

export interface TransporteFalso {
  readonly transporte: Transporte;
  readonly chamadas: { url: string; cabecalhos: Record<string, string> }[];
}

/** Transporte em memória para testes: rotas por URL exata; URL sem rota responde 404. */
export function criarTransporteFalso(rotas: Record<string, Rota>): TransporteFalso {
  const chamadas: TransporteFalso['chamadas'] = [];
  const transporte: Transporte = (url, cabecalhos) => {
    chamadas.push({ url: url.toString(), cabecalhos });
    const rota = rotas[url.toString()];
    const resposta: RespostaFalsa =
      rota === undefined ? { status: 404 } : typeof rota === 'function' ? rota(cabecalhos) : rota;
    const corpo = Buffer.from(resposta.corpo ?? '');
    const bruta: RespostaBruta = {
      status: resposta.status ?? 200,
      cabecalhos: Object.fromEntries(Object.entries(resposta.cabecalhos ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      corpo: (async function* () {
        // why: entrega em pedaços para exercitar o limite de tamanho durante o streaming.
        for (let i = 0; i < corpo.length; i += 1024) {
          await Promise.resolve();
          yield corpo.subarray(i, i + 1024);
        }
      })(),
      descartar: () => undefined,
    };
    return Promise.resolve(bruta);
  };
  return { transporte, chamadas };
}
