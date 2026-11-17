import type { Fonte, Nivel } from '@lastro/core';
import type { EvidenciaArquivada, FatoPublico, RelacaoPublica } from '@lastro/db';
import { z } from 'zod';
import { dataBrasil, dataIsoBrasil } from './checagem.ts';
import { custoUsd, type ClienteModelo, type UsoModelo } from './modelo.ts';
import { minimizarPergunta } from './pipeline.ts';
import { AVISO_PADRAO, LIMITES_PADRAO } from './prompt.ts';
import { PROMPT_EXTRACAO, PROMPT_VEREDITO } from './prompt-verificacao.ts';
import {
  aplicarRegras,
  ROTULOS_VEREDITO,
  TIPOS_ALEGACAO,
  VEREDITOS,
  type ContextoRegras,
  type ItemEvidencia,
  type ItemFato,
  type ItemRelacao,
  type TipoAlegacao,
  type Veredito,
  type VereditoModelo,
} from './regras-veredito.ts';
import { classificarPergunta, type Rota } from './roteador.ts';
import type { Evidencia } from './tipos.ts';

export const MAX_TEXTO_VERIFICACAO = 5000;

/* why: a verificação de alegação de ISS fica para depois da Fase 5. Um FALSO sobre alíquota ou regra municipal
   exigiria fato curado com a tabela oficial ou a lei do município, e ainda não há regra de evidência para isso
   em regras-veredito.ts; a recusa é decidida em código, não pelo modelo. */
const ROTAS_FORA_DA_VERIFICACAO: ReadonlySet<Rota> = new Set<Rota>(['fora-do-escopo', 'iss', 'iss-aliquota']);
// why: limites por verificação (SEGURANCA.md §11): alegações extraídas, evidências enviadas e tokens por chamada.
const MAX_ALEGACOES = 8;
const TRECHOS_POR_ALEGACAO = 5;
const FATOS_POR_ALEGACAO = 3;
const MAX_EVIDENCIAS = 36;
const MAX_TEXTO_EVIDENCIA = 2000;
const MAX_TOKENS_EXTRACAO = 4096;
const MAX_TOKENS_VEREDITO = 8192;

export interface DependenciasVerificacao {
  readonly modelo: ClienteModelo;
  readonly fontes: readonly Fonte[];
  buscarTrechos(consulta: string, limite: number): Promise<Evidencia[]>;
  buscarFatos(consulta: string, limite: number): Promise<FatoPublico[]>;
  relacoesDosDocumentos(documentoIds: readonly string[]): Promise<RelacaoPublica[]>;
  readonly agora?: () => Date;
}

export interface EvidenciaVerificacao {
  readonly titulo: string;
  readonly orgao: string;
  readonly nivel: Nivel;
  readonly url: string;
  readonly secao: string | null;
  readonly pagina: number | null;
  readonly trecho: string;
  readonly coletado_em: string;
  readonly sha256: string;
  readonly snapshot_id: string;
  readonly documento_id: string;
  readonly original: string;
  readonly revogado_por: string | null;
}

export interface FatoVerificacao {
  readonly id: string;
  readonly tipo: string;
  readonly tema: string;
  readonly enunciado: string;
  readonly publico: string | null;
  readonly data_efeito: string | null;
  readonly aprovado_em: string | null;
}

export interface RelacaoVerificacao {
  readonly id: string;
  readonly tipo: string;
  readonly origem: string;
  readonly origem_url: string;
  readonly destino: string;
  readonly dispositivo: string | null;
  readonly efeito_em: string | null;
}

export interface AlegacaoVerificada {
  readonly id: string;
  readonly alegacao: string;
  readonly tipo: TipoAlegacao;
  readonly data_mencionada: string | null;
  readonly veredito: Veredito;
  readonly rotulo: string;
  readonly veredito_proposto: Veredito | null;
  readonly rebaixado: boolean;
  readonly explicacao: string;
  readonly evidencias: readonly EvidenciaVerificacao[];
  readonly fatos: readonly FatoVerificacao[];
  readonly relacoes: readonly RelacaoVerificacao[];
  readonly avisos: readonly string[];
  readonly busca: { readonly consulta: string; readonly fontes_consultadas: number } | null;
}

export type SituacaoVerificacao = 'verificada' | 'sem-alegacoes' | 'rejeitada';

/** Formato da verificação (docs/VERIFICACAO-DE-ALEGACOES.md, passo 7). */
export interface ResultadoVerificacao {
  readonly situacao: SituacaoVerificacao;
  readonly posicao_em: string;
  readonly alegacoes: readonly AlegacaoVerificada[];
  readonly avisos: readonly string[];
  readonly limites: readonly string[];
  readonly aviso: string;
  readonly checagem: { readonly citacoes_invalidas: number; readonly vereditos_rebaixados: number };
}

export interface ResultadoPipelineVerificacao {
  readonly resultado: ResultadoVerificacao;
  readonly entradaMinimizada: string;
  readonly trechos: readonly string[];
  readonly fatos: readonly string[];
  readonly relacoes: readonly string[];
  readonly usos: readonly UsoModelo[];
  readonly custoUsd: number;
}

const ESQUEMA_EXTRACAO = {
  type: 'object',
  additionalProperties: false,
  required: ['alegacoes'],
  properties: {
    alegacoes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['texto', 'tipo', 'verificavel', 'consulta', 'data_mencionada'],
        properties: {
          texto: { type: 'string' },
          tipo: { type: 'string', enum: [...TIPOS_ALEGACAO] },
          verificavel: { type: 'boolean' },
          consulta: { type: 'string' },
          data_mencionada: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
        },
      },
    },
  },
} as const;

const ESQUEMA_VEREDITO = {
  type: 'object',
  additionalProperties: false,
  required: ['vereditos'],
  properties: {
    vereditos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['alegacao', 'veredito', 'explicacao', 'evidencias', 'fatos', 'relacoes'],
        properties: {
          alegacao: { type: 'string' },
          veredito: { type: 'string', enum: [...VEREDITOS] },
          explicacao: { type: 'string' },
          evidencias: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['ref', 'citacao'], properties: { ref: { type: 'string' }, citacao: { type: 'string' } } },
          },
          fatos: { type: 'array', items: { type: 'string' } },
          relacoes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

// invariant: a resposta do provedor é validada por schema antes do uso (SEGURANCA.md API10), mesmo com structured outputs.
const Extracao = z.object({
  alegacoes: z.array(
    z.object({
      texto: z.string(),
      tipo: z.enum(TIPOS_ALEGACAO),
      verificavel: z.boolean(),
      consulta: z.string(),
      data_mencionada: z.iso.date().nullable(),
    }),
  ),
});

const Vereditos = z.object({
  vereditos: z.array(
    z.object({
      alegacao: z.string(),
      veredito: z.enum(VEREDITOS),
      explicacao: z.string(),
      evidencias: z.array(z.object({ ref: z.string(), citacao: z.string() })).max(20),
      fatos: z.array(z.string()).max(20),
      relacoes: z.array(z.string()).max(20),
    }),
  ),
});

interface Alegacao {
  readonly id: string;
  readonly texto: string;
  readonly tipo: TipoAlegacao;
  readonly verificavel: boolean;
  readonly consulta: string;
  readonly dataMencionada: string | null;
  readonly foraDoEscopo: boolean;
}

const normalizar = (s: string): string => s.replace(/\s+/g, ' ').trim();

function tituloDaUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter((p) => p !== '').at(-1) ?? url);
  } catch {
    return url;
  }
}

export function evidenciaDeArquivada(e: EvidenciaArquivada): Evidencia {
  return {
    tipo: 'trecho',
    id: e.trechoId,
    titulo: tituloDaUrl(e.url),
    texto: e.texto,
    secao: e.secao,
    paginaIni: e.paginaIni,
    paginaFim: e.paginaFim,
    url: e.url,
    fonteId: e.fonteId,
    documentoId: e.documentoId,
    snapshotId: e.snapshotId,
    sha256: e.sha256,
    coletadoEm: e.coletadoEm,
    confirmadoEm: e.coletadoEm,
    documentoIndisponivel: false,
  };
}

/** Registro das evidências enviadas ao modelo, com referências estáveis (E1…, F1…, R1…). */
class Registro {
  readonly evidencias = new Map<string, { ref: string; evidencia: Evidencia; texto: string }>();
  readonly fatos = new Map<string, ItemFato>();
  readonly relacoes = new Map<string, ItemRelacao>();
  private readonly refPorTrecho = new Map<string, string>();

  evidencia(ev: Evidencia, obrigatoria = false): string | undefined {
    const existente = this.refPorTrecho.get(ev.id);
    if (existente !== undefined) return existente;
    if (!obrigatoria && this.evidencias.size >= MAX_EVIDENCIAS) return undefined;
    const ref = `E${String(this.evidencias.size + 1)}`;
    // hazard: o texto vai entre marcadores <texto>; um documento adulterado não pode fechar o marcador.
    const texto = ev.texto.slice(0, MAX_TEXTO_EVIDENCIA).replace(/<\/?texto[^>]{0,40}>/gi, ' ');
    this.evidencias.set(ref, { ref, evidencia: ev, texto });
    this.refPorTrecho.set(ev.id, ref);
    return ref;
  }

  fato(f: FatoPublico): void {
    if ([...this.fatos.values()].some((x) => x.fato.id === f.id)) return;
    const refEvidencia = this.evidencia(evidenciaDeArquivada(f.evidencia), true);
    if (refEvidencia === undefined) return;
    const ref = `F${String(this.fatos.size + 1)}`;
    this.fatos.set(ref, { ref, fato: f, refEvidencia });
  }

  relacao(r: RelacaoPublica): void {
    if ([...this.relacoes.values()].some((x) => x.relacao.id === r.id)) return;
    const refEvidencia = this.evidencia(evidenciaDeArquivada(r.evidencia), true);
    if (refEvidencia === undefined) return;
    const ref = `R${String(this.relacoes.size + 1)}`;
    this.relacoes.set(ref, { ref, relacao: r, refEvidencia });
  }
}

function descreverOrigem(r: RelacaoPublica): string {
  return r.origemTitulo ?? tituloDaUrl(r.origemUrl);
}

function textoVeredito(alegacoes: readonly Alegacao[], reg: Registro, itens: ReadonlyMap<string, ItemEvidencia>, fontes: ReadonlyMap<string, Fonte>, hoje: string): string {
  const linhasAlegacoes = alegacoes.map((a) => `${a.id} (${a.tipo}${a.dataMencionada === null ? '' : `; data mencionada ${a.dataMencionada}`}): ${a.texto.replace(/<\/?alegacoes>/gi, '')}`);
  const blocos = [...itens.values()].map((i) => {
    const f = fontes.get(i.evidencia.fonteId);
    const local = [i.evidencia.secao, i.evidencia.paginaIni === null ? null : `p. ${String(i.evidencia.paginaIni)}`].filter((p) => p !== null).join(', ');
    const revogado = i.revogadoPor === null ? '' : ` — ATO REVOGADO por ${i.revogadoPor}; use só para mostrar o que valia antes`;
    return `[${i.ref}] ${i.evidencia.titulo}${local === '' ? '' : ` (${local})`} — ${f?.orgao ?? '?'}, ${f?.nivel ?? '?'}, coletado em ${dataBrasil(new Date(i.evidencia.coletadoEm))}${revogado}\n<texto ref="${i.ref}">\n${i.textoEnviado}\n</texto>`;
  });
  const fatos = [...reg.fatos.values()].map(
    (f) =>
      `[${f.ref}] Fato aprovado pela curadoria (${f.fato.tipo}; tema ${f.fato.tema}${f.fato.dataEfeito === null ? '' : `; data ${f.fato.dataEfeito}`}${f.fato.publico === null ? '' : `; público: ${f.fato.publico}`}): ${f.fato.enunciado} Evidência: ${f.refEvidencia}.`,
  );
  const relacoes = [...reg.relacoes.values()].map(
    (r) =>
      `[${r.ref}] Relação aprovada pela curadoria: ${descreverOrigem(r.relacao)} ${r.relacao.tipo} ${r.relacao.destinoDescricao}${r.relacao.dispositivo === null ? '' : ` (${r.relacao.dispositivo})`}${r.relacao.efeitoEm === null ? '' : `, com efeito a partir de ${r.relacao.efeitoEm}`}. Evidência: ${r.refEvidencia}.`,
  );
  return `Data de referência: ${hoje}.\n\n<alegacoes>\n${linhasAlegacoes.join('\n')}\n</alegacoes>\n\n<evidencias>\n${[...blocos, ...fatos, ...relacoes].join('\n\n')}\n</evidencias>`;
}

function rejeitada(agora: Date, aviso: string, entrada: string, usos: UsoModelo[]): ResultadoPipelineVerificacao {
  return {
    resultado: {
      situacao: 'rejeitada',
      posicao_em: dataIsoBrasil(agora),
      alegacoes: [],
      avisos: [aviso],
      limites: [...LIMITES_PADRAO],
      aviso: AVISO_PADRAO,
      checagem: { citacoes_invalidas: 0, vereditos_rebaixados: 0 },
    },
    entradaMinimizada: entrada,
    trechos: [],
    fatos: [],
    relacoes: [],
    usos,
    custoUsd: usos.reduce((s, u) => s + custoUsd(u), 0),
  };
}

/**
 * Verificação de alegações (docs/VERIFICACAO-DE-ALEGACOES.md): extração (modelo) → evidência por alegação
 * (fatos aprovados, grafo normativo, busca nos trechos oficiais) → veredito proposto (modelo) → regras em código.
 *
 * invariant: o texto enviado é o objeto da checagem; nunca entra na base nem serve de evidência.
 */
export async function verificarAlegacoes(texto: string, deps: DependenciasVerificacao, opcoes: { dataConteudo?: string | undefined } = {}): Promise<ResultadoPipelineVerificacao> {
  const agora = (deps.agora ?? (() => new Date()))();
  const hoje = dataIsoBrasil(agora);
  const entrada = minimizarPergunta(texto.trim()).slice(0, MAX_TEXTO_VERIFICACAO);
  const fontes = new Map(deps.fontes.map((f) => [f.id, f]));
  const usos: UsoModelo[] = [];

  const extracao = await deps.modelo.gerarJson({
    sistema: PROMPT_EXTRACAO,
    textoUsuario: `Data de referência: ${hoje}.\nData do conteúdo: ${opcoes.dataConteudo ?? 'não informada'}.\n\n<conteudo>\n${entrada.replace(/<\/?conteudo>/gi, '')}\n</conteudo>`,
    esquema: ESQUEMA_EXTRACAO,
    esforco: 'low',
    maxTokens: MAX_TOKENS_EXTRACAO,
  });
  usos.push(extracao.uso);
  const extraidas = Extracao.safeParse(extracao.dados);
  if (!extraidas.success) return rejeitada(agora, 'Não foi possível separar as alegações do conteúdo.', entrada, usos);

  const alegacoes: Alegacao[] = extraidas.data.alegacoes.slice(0, MAX_ALEGACOES).flatMap((a, i) => {
    const t = normalizar(a.texto).slice(0, 500);
    if (t === '') return [];
    return [
      {
        id: `C${String(i + 1)}`,
        texto: t,
        tipo: a.tipo,
        verificavel: a.verificavel,
        consulta: normalizar(a.consulta).slice(0, 300),
        dataMencionada: a.data_mencionada,
        foraDoEscopo: !a.verificavel || ROTAS_FORA_DA_VERIFICACAO.has(classificarPergunta(t)),
      },
    ];
  });
  const base = { posicao_em: hoje, limites: [...LIMITES_PADRAO], aviso: AVISO_PADRAO };
  if (alegacoes.length === 0) {
    return {
      resultado: { ...base, situacao: 'sem-alegacoes', alegacoes: [], avisos: ['Nenhuma alegação verificável foi encontrada no conteúdo.'], checagem: { citacoes_invalidas: 0, vereditos_rebaixados: 0 } },
      entradaMinimizada: entrada,
      trechos: [],
      fatos: [],
      relacoes: [],
      usos,
      custoUsd: usos.reduce((s, u) => s + custoUsd(u), 0),
    };
  }

  const reg = new Registro();
  const avaliaveis = alegacoes.filter((a) => !a.foraDoEscopo);
  const buscas = await Promise.all(
    avaliaveis.map(async (a) => {
      const consulta = a.consulta === '' ? a.texto : a.consulta;
      const [trechos, fatos] = await Promise.all([deps.buscarTrechos(consulta, TRECHOS_POR_ALEGACAO), deps.buscarFatos(`${consulta} ${a.texto}`, FATOS_POR_ALEGACAO)]);
      return { trechos, fatos };
    }),
  );
  for (const b of buscas) for (const f of b.fatos) if (f.situacao === 'aprovado') reg.fato(f);
  for (const b of buscas) for (const t of b.trechos) reg.evidencia(t);
  const documentos = [...new Set([...reg.evidencias.values()].map((e) => e.evidencia.documentoId))];
  for (const r of await deps.relacoesDosDocumentos(documentos)) if (r.situacao === 'aprovado') reg.relacao(r);

  const revogados = new Map<string, string>();
  for (const { relacao: r } of reg.relacoes.values()) {
    if (r.tipo === 'revoga' && r.destinoDocumentoId !== null && (r.efeitoEm === null || r.efeitoEm <= hoje)) revogados.set(r.destinoDocumentoId, descreverOrigem(r));
  }
  const itens = new Map<string, ItemEvidencia>(
    [...reg.evidencias.values()].map((e) => [e.ref, { ref: e.ref, evidencia: e.evidencia, textoEnviado: e.texto, revogadoPor: revogados.get(e.evidencia.documentoId) ?? null }]),
  );

  const propostos = new Map<string, VereditoModelo>();
  if (avaliaveis.length > 0 && itens.size > 0) {
    const veredito = await deps.modelo.gerarJson({
      sistema: PROMPT_VEREDITO,
      textoUsuario: textoVeredito(avaliaveis, reg, itens, fontes, hoje),
      esquema: ESQUEMA_VEREDITO,
      esforco: 'medium',
      maxTokens: MAX_TOKENS_VEREDITO,
    });
    usos.push(veredito.uso);
    const lidos = Vereditos.safeParse(veredito.dados);
    if (!lidos.success) return rejeitada(agora, 'Não foi possível obter vereditos verificáveis para este conteúdo.', entrada, usos);
    for (const v of lidos.data.vereditos) if (!propostos.has(v.alegacao)) propostos.set(v.alegacao, v);
  }

  const ctx: ContextoRegras = { evidencias: itens, fatos: reg.fatos, relacoes: reg.relacoes, fontes, hoje };
  const usadosTrechos = new Set<string>();
  const usadosFatos = new Set<string>();
  const usadasRelacoes = new Set<string>();
  let citacoesInvalidas = 0;
  let rebaixados = 0;

  const resultadoAlegacoes: AlegacaoVerificada[] = alegacoes.map((a) => {
    const d = aplicarRegras({ texto: a.texto, tipo: a.tipo, foraDoEscopo: a.foraDoEscopo }, propostos.get(a.id), ctx);
    citacoesInvalidas += d.citacoesInvalidas;
    if (d.rebaixado) rebaixados++;
    const evidencias: EvidenciaVerificacao[] = d.citacoes.flatMap((c) => {
      const f = fontes.get(c.item.evidencia.fonteId);
      if (f === undefined) return [];
      usadosTrechos.add(c.item.evidencia.id);
      const ev = c.item.evidencia;
      return [
        {
          titulo: ev.titulo,
          orgao: f.orgao,
          nivel: f.nivel,
          url: ev.url,
          secao: ev.secao,
          pagina: ev.paginaIni,
          trecho: c.citacao,
          coletado_em: ev.coletadoEm,
          sha256: ev.sha256,
          snapshot_id: ev.snapshotId,
          documento_id: ev.documentoId,
          original: `/v1/snapshots/${ev.snapshotId}/original`,
          revogado_por: c.item.revogadoPor,
        },
      ];
    });
    for (const f of d.fatos) {
      usadosFatos.add(f.fato.id);
      usadosTrechos.add(f.fato.evidencia.trechoId);
    }
    for (const r of d.relacoes) {
      usadasRelacoes.add(r.relacao.id);
      usadosTrechos.add(r.relacao.evidencia.trechoId);
    }
    return {
      id: a.id,
      alegacao: a.texto,
      tipo: a.tipo,
      data_mencionada: a.dataMencionada,
      veredito: d.veredito,
      rotulo: ROTULOS_VEREDITO[d.veredito],
      veredito_proposto: d.vereditoModelo,
      rebaixado: d.rebaixado,
      explicacao: d.explicacao,
      evidencias,
      fatos: d.fatos.map((f) => ({
        id: f.fato.id,
        tipo: f.fato.tipo,
        tema: f.fato.tema,
        enunciado: f.fato.enunciado,
        publico: f.fato.publico,
        data_efeito: f.fato.dataEfeito,
        aprovado_em: f.fato.aprovadoEm,
      })),
      relacoes: d.relacoes.map((r) => ({
        id: r.relacao.id,
        tipo: r.relacao.tipo,
        origem: descreverOrigem(r.relacao),
        origem_url: r.relacao.origemUrl,
        destino: r.relacao.destinoDescricao,
        dispositivo: r.relacao.dispositivo,
        efeito_em: r.relacao.efeitoEm,
      })),
      avisos: d.avisos,
      busca: a.foraDoEscopo ? null : { consulta: a.consulta === '' ? a.texto : a.consulta, fontes_consultadas: deps.fontes.length },
    };
  });

  const avisos: string[] = [];
  if (rebaixados > 0) avisos.push('Algum veredito proposto não tinha a evidência mínima exigida e foi rebaixado para SEM RESPALDO OFICIAL.');
  return {
    resultado: {
      ...base,
      situacao: 'verificada',
      alegacoes: resultadoAlegacoes,
      avisos,
      checagem: { citacoes_invalidas: citacoesInvalidas, vereditos_rebaixados: rebaixados },
    },
    entradaMinimizada: entrada,
    trechos: [...usadosTrechos],
    fatos: [...usadosFatos],
    relacoes: [...usadasRelacoes],
    usos,
    custoUsd: usos.reduce((s, u) => s + custoUsd(u), 0),
  };
}
