import Anthropic from '@anthropic-ai/sdk';

export const MODELO_PADRAO = 'claude-opus-5-5';

/** Falha do provedor de LLM (rede, limite, indisponibilidade). A mensagem original fica só no log do servidor. */
export class ErroModelo extends Error {
  readonly status: number | null;
  constructor(mensagem: string, status: number | null, opcoes?: ErrorOptions) {
    super(mensagem, opcoes);
    this.name = 'ErroModelo';
    this.status = status;
  }
}

export type Esforco = 'low' | 'medium' | 'high';

export interface ResultadoBusca {
  readonly titulo: string;
  readonly fonte: string;
  /** Blocos de texto do resultado; a citação aponta para um intervalo destes blocos. */
  readonly blocos: readonly string[];
}

export interface PedidoModelo {
  readonly sistema: string;
  readonly resultados: readonly ResultadoBusca[];
  readonly textoUsuario: string;
  readonly esforco: Esforco;
  readonly maxTokens: number;
}

export interface CitacaoModelo {
  readonly indiceResultado: number;
  readonly inicioBloco: number;
  readonly fimBloco: number;
  readonly textoCitado: string;
}

export interface BlocoModelo {
  readonly texto: string;
  readonly citacoes: readonly CitacaoModelo[];
}

export interface UsoModelo {
  readonly modelo: string;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly tokensCacheLeitura: number;
  readonly tokensCacheEscrita: number;
}

export interface RespostaModelo {
  readonly blocos: readonly BlocoModelo[];
  readonly parada: string | null;
  readonly uso: UsoModelo;
}

export interface PedidoJson {
  readonly sistema: string;
  readonly textoUsuario: string;
  /** JSON Schema da saída (structured outputs); sem minLength/minimum, que a API não aceita. */
  readonly esquema: Readonly<Record<string, unknown>>;
  readonly esforco: Esforco;
  readonly maxTokens: number;
}

export interface RespostaJson {
  /** JSON já interpretado; undefined se a geração parou antes do fim ou o texto não era JSON. */
  readonly dados: unknown;
  readonly parada: string | null;
  readonly uso: UsoModelo;
}

/** Fronteira com o provedor de LLM; os testes usam uma implementação falsa. */
export interface ClienteModelo {
  gerar(pedido: PedidoModelo): Promise<RespostaModelo>;
  /**
   * Saída estruturada (vereditos, extração). why: citações e `output_config.format` não podem ir na mesma
   * requisição (ARQUITETURA.md §5); aqui a evidência vem por id no próprio JSON e é conferida em código depois.
   */
  gerarJson(pedido: PedidoJson): Promise<RespostaJson>;
}

/** Substituto quando não há credencial da Anthropic: toda geração falha como provedor indisponível (503). */
export function modeloIndisponivel(): ClienteModelo {
  const falha = (): Promise<never> => Promise.reject(new ErroModelo('credencial da Anthropic ausente', null));
  return { gerar: falha, gerarJson: falha };
}

type TabelaPreco = readonly [entrada: number, saida: number, leituraCache: number, escritaCache: number];

// why: preços públicos por milhão de tokens (entrada, saída, leitura de cache, escrita de cache 5 min). A resposta
// pode vir de um modelo de fallback (Opus 5, Opus 4.8); modelo desconhecido usa o preço mais alto, para o disjuntor
// de gasto errar para o lado seguro. O Haiku 5.5 tem duas faixas, escolhidas pelo tamanho do prompt.
const PRECOS: Readonly<Record<string, { readonly ate: TabelaPreco; readonly longo?: { readonly acimaDe: number; readonly tabela: TabelaPreco } }>> = {
  'claude-opus-5-5': { ate: [4, 20, 0.2, 5] },
  'claude-opus-5': { ate: [5, 25, 0.5, 6.25] },
  'claude-opus-4-8': { ate: [5, 25, 0.5, 6.25] },
  'claude-sonnet-5-5': { ate: [2, 10, 0.1, 2.5] },
  'claude-sonnet-5': { ate: [2, 10, 0.2, 2.5] },
  'claude-haiku-5-5': { ate: [0.1, 0.5, 0.01, 0.125], longo: { acimaDe: 100_000, tabela: [0.5, 2.5, 0.05, 0.625] } },
};
const PRECO_DESCONHECIDO: TabelaPreco = [10, 50, 1, 12.5];

export function custoUsd(uso: UsoModelo): number {
  const preco = PRECOS[uso.modelo];
  const prompt = uso.tokensEntrada + uso.tokensCacheLeitura + uso.tokensCacheEscrita;
  const [entrada, saida, leitura, escrita] =
    preco === undefined ? PRECO_DESCONHECIDO : preco.longo !== undefined && prompt > preco.longo.acimaDe ? preco.longo.tabela : preco.ate;
  return (
    (uso.tokensEntrada * entrada + uso.tokensSaida * saida + uso.tokensCacheLeitura * leitura + uso.tokensCacheEscrita * escrita) /
    1_000_000
  );
}

// invariant: só modelos com preço cadastrado podem ser configurados; cotas, disjuntor e cobrança dependem do custo medido.
export const MODELOS_SUPORTADOS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

// why: o Haiku 5.5 não tem modelo reserva no servidor (com `fallbacks` a recusa só continua recusa); o parâmetro
// vai apenas para os modelos que o aceitam.
const COM_FALLBACK: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export function aceitaFallback(modelo: string): boolean {
  return COM_FALLBACK.has(modelo);
}

export class ErroConfigModelo extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroConfigModelo';
  }
}

// why: respostas (perguntas e verificações) e extração de fatos podem usar modelos diferentes (decisão em aberto
// nº 2): LASTRO_LLM_MODELO e LASTRO_LLM_MODELO_FATOS, que herda o primeiro quando vazio.
export function modeloConfigurado(ambiente: NodeJS.ProcessEnv, uso: 'respostas' | 'fatos'): string {
  const geral = (ambiente.LASTRO_LLM_MODELO ?? '').trim();
  const fatos = (ambiente.LASTRO_LLM_MODELO_FATOS ?? '').trim();
  const proprio = uso === 'fatos' && fatos !== '';
  const valor = (proprio ? fatos : geral) || MODELO_PADRAO;
  if (!(MODELOS_SUPORTADOS as readonly string[]).includes(valor)) {
    throw new ErroConfigModelo(`${proprio ? 'LASTRO_LLM_MODELO_FATOS' : 'LASTRO_LLM_MODELO'}: modelo não suportado (${valor}); use ${MODELOS_SUPORTADOS.join(', ')}`);
  }
  return valor;
}

function paraSearchResult(r: ResultadoBusca): Anthropic.Beta.BetaSearchResultBlockParam {
  return {
    type: 'search_result',
    source: r.fonte,
    title: r.titulo,
    content: r.blocos.map((texto) => ({ type: 'text', text: texto })),
    citations: { enabled: true },
  };
}

/**
 * Chamada ao Claude com os trechos como blocos `search_result` (ARQUITETURA.md §2.6): a API devolve, por
 * bloco de texto, o intervalo exato do resultado citado, e o modelo não consegue citar o que não recebeu.
 *
 * invariant: nenhuma ferramenta é oferecida ao modelo (SEGURANCA.md §3, princípio 2: LLM sem agência).
 */
export function criarModeloAnthropic(opcoes: { cliente?: Anthropic; modelo?: string; timeoutMs?: number } = {}): ClienteModelo {
  const cliente = opcoes.cliente ?? new Anthropic({ timeout: opcoes.timeoutMs ?? 120_000, maxRetries: 2 });
  const modelo = opcoes.modelo ?? MODELO_PADRAO;
  const fallback: Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, 'betas' | 'fallbacks'> = aceitaFallback(modelo)
    ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
    : {};
  return {
    async gerar(pedido) {
      let resposta: Anthropic.Beta.BetaMessage;
      try {
        resposta = await enviar(pedido);
      } catch (erro) {
        if (erro instanceof Anthropic.APIError) throw new ErroModelo(`provedor de LLM: ${erro.name}`, typeof erro.status === 'number' ? erro.status : null, { cause: erro });
        // why: sem credencial o SDK lança Error comum na montagem da requisição (visto no E2E de 17/11/2026); continua sendo indisponibilidade do provedor, não erro interno.
        throw new ErroModelo('provedor de LLM: falha antes da resposta', null, { cause: erro });
      }
      return converter(resposta);
    },
    async gerarJson(pedido) {
      let resposta: Anthropic.Beta.BetaMessage;
      try {
        resposta = await cliente.beta.messages.create({
          model: modelo,
          max_tokens: pedido.maxTokens,
          ...fallback,
          thinking: { type: 'adaptive' },
          output_config: { effort: pedido.esforco, format: { type: 'json_schema', schema: { ...pedido.esquema } } },
          system: [{ type: 'text', text: pedido.sistema, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: [{ type: 'text', text: pedido.textoUsuario }] }],
        });
      } catch (erro) {
        if (erro instanceof Anthropic.APIError) throw new ErroModelo(`provedor de LLM: ${erro.name}`, typeof erro.status === 'number' ? erro.status : null, { cause: erro });
        throw new ErroModelo('provedor de LLM: falha antes da resposta', null, { cause: erro });
      }
      return converterJson(resposta);
    },
  };

  function enviar(pedido: PedidoModelo): Promise<Anthropic.Beta.BetaMessage> {
    return cliente.beta.messages.create({
      model: modelo,
      max_tokens: pedido.maxTokens,
      // why: recusa do classificador de segurança é refeita no servidor em outro modelo, sem derrubar a pergunta.
      ...fallback,
      thinking: { type: 'adaptive' },
      output_config: { effort: pedido.esforco },
      system: [{ type: 'text', text: pedido.sistema, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [...pedido.resultados.map(paraSearchResult), { type: 'text', text: pedido.textoUsuario }],
        },
      ],
    });
  }
}

function usoDe(resposta: Anthropic.Beta.BetaMessage): UsoModelo {
  return {
    modelo: resposta.model,
    tokensEntrada: resposta.usage.input_tokens,
    tokensSaida: resposta.usage.output_tokens,
    tokensCacheLeitura: resposta.usage.cache_read_input_tokens ?? 0,
    tokensCacheEscrita: resposta.usage.cache_creation_input_tokens ?? 0,
  };
}

export function converterJson(resposta: Anthropic.Beta.BetaMessage): RespostaJson {
  const texto = resposta.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let dados: unknown = undefined;
  // invariant: JSON de geração interrompida (max_tokens, recusa) não é usado nem parcialmente.
  if (resposta.stop_reason === 'end_turn' || resposta.stop_reason === 'stop_sequence') {
    try {
      dados = JSON.parse(texto) as unknown;
    } catch {
      dados = undefined;
    }
  }
  return { dados, parada: resposta.stop_reason, uso: usoDe(resposta) };
}

export function converter(resposta: Anthropic.Beta.BetaMessage): RespostaModelo {
  const blocos: BlocoModelo[] = [];
  for (const bloco of resposta.content) {
    if (bloco.type !== 'text') continue;
    const citacoes: CitacaoModelo[] = [];
    for (const c of bloco.citations ?? []) {
      if (c.type !== 'search_result_location') continue;
      citacoes.push({
        indiceResultado: c.search_result_index,
        inicioBloco: c.start_block_index,
        fimBloco: c.end_block_index,
        textoCitado: c.cited_text,
      });
    }
    blocos.push({ texto: bloco.text, citacoes });
  }
  return {
    blocos,
    parada: resposta.stop_reason,
    uso: {
      modelo: resposta.model,
      tokensEntrada: resposta.usage.input_tokens,
      tokensSaida: resposta.usage.output_tokens,
      tokensCacheLeitura: resposta.usage.cache_read_input_tokens ?? 0,
      tokensCacheEscrita: resposta.usage.cache_creation_input_tokens ?? 0,
    },
  };
}
