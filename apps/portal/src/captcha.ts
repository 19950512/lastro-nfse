export const PROVEDORES_CAPTCHA = ['turnstile', 'hcaptcha', 'desligado'] as const;
export type ProvedorCaptcha = (typeof PROVEDORES_CAPTCHA)[number];

export interface Captcha {
  readonly provedor: ProvedorCaptcha;
  readonly chaveSite: string;
  /** Nome do campo que o widget acrescenta ao formulário. */
  readonly campo: string;
  /** Classe do elemento que o script do provedor transforma no widget. */
  readonly classe: string;
  readonly script: string | null;
  /** Origens a liberar na CSP, por diretiva. */
  readonly csp: { readonly script: readonly string[]; readonly frame: readonly string[]; readonly style: readonly string[]; readonly connect: readonly string[] };
  verificar(token: string, ip: string): Promise<boolean>;
}

export interface ConfigCaptcha {
  readonly provedor: ProvedorCaptcha;
  readonly chaveSite?: string | undefined;
  readonly segredo?: string | undefined;
  /** Host público do portal; a resposta do provedor precisa ter sido emitida para ele. */
  readonly hostEsperado: string;
  readonly timeoutMs?: number;
}

type Buscar = (url: string, init: RequestInit) => Promise<Response>;

const HCAPTCHA = ['https://hcaptcha.com', 'https://*.hcaptcha.com'];

// why: Turnstile e hCaptcha usam o mesmo protocolo de verificação no servidor (siteverify com secret, response e
// remoteip); trocar de provedor é configuração, não código (decisão de provedor ainda em aberto).
const DEFINICOES = {
  turnstile: {
    verificacao: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    script: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    campo: 'cf-turnstile-response',
    classe: 'cf-turnstile',
    csp: { script: ['https://challenges.cloudflare.com'], frame: ['https://challenges.cloudflare.com'], style: [], connect: [] },
  },
  hcaptcha: {
    verificacao: 'https://api.hcaptcha.com/siteverify',
    script: 'https://js.hcaptcha.com/1/api.js',
    campo: 'h-captcha-response',
    classe: 'h-captcha',
    csp: { script: HCAPTCHA, frame: HCAPTCHA, style: HCAPTCHA, connect: HCAPTCHA },
  },
} as const;

const TOKEN = /^[A-Za-z0-9._:-]{1,4096}$/;

export class ErroConfigCaptcha extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroConfigCaptcha';
  }
}

export function criarCaptcha(config: ConfigCaptcha, buscar: Buscar = fetch): Captcha {
  if (config.provedor === 'desligado') {
    return {
      provedor: 'desligado',
      chaveSite: '',
      campo: 'captcha',
      classe: '',
      script: null,
      csp: { script: [], frame: [], style: [], connect: [] },
      verificar: () => Promise.resolve(true),
    };
  }
  const d = DEFINICOES[config.provedor];
  const chaveSite = config.chaveSite ?? '';
  const segredo = config.segredo ?? '';
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(chaveSite)) throw new ErroConfigCaptcha('chave de site do CAPTCHA ausente ou inválida');
  if (segredo.length < 16) throw new ErroConfigCaptcha('segredo do CAPTCHA ausente');
  const timeoutMs = config.timeoutMs ?? 5000;
  return {
    provedor: config.provedor,
    chaveSite,
    campo: d.campo,
    classe: d.classe,
    script: d.script,
    csp: d.csp,
    async verificar(token, ip) {
      if (!TOKEN.test(token)) return false;
      let corpo: unknown;
      try {
        const r = await buscar(d.verificacao, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: segredo, response: token, remoteip: ip }).toString(),
          // hazard: o endereço do provedor é fixo no código; redirecionamento não é seguido (SSRF, SEGURANCA.md §8).
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) return false;
        corpo = await r.json();
      } catch {
        // invariant: provedor fora do ar ou lento falha fechado; sem CAPTCHA confirmado, nada chega ao modelo.
        return false;
      }
      if (typeof corpo !== 'object' || corpo === null) return false;
      const { success, hostname } = corpo as { success?: unknown; hostname?: unknown };
      // why: token emitido para outro site (colado de outro formulário com a mesma chave pública) não vale aqui.
      return success === true && (hostname === undefined || hostname === config.hostEsperado);
    },
  };
}
