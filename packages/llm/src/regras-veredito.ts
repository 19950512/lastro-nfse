import { verificarOrigem, type Fonte, type Nivel } from '@lastro/core';
import type { FatoPublico, RelacaoPublica } from '@lastro/db';
import { sanitizarTexto } from './checagem.ts';
import type { Evidencia } from './tipos.ts';

export const VEREDITOS = ['confirmado', 'falso', 'desatualizado', 'impreciso', 'ainda-nao-definido', 'sem-respaldo-oficial', 'fora-do-escopo'] as const;
export type Veredito = (typeof VEREDITOS)[number];

export const TIPOS_ALEGACAO = ['prazo', 'obrigacao', 'valor', 'definicao', 'outro'] as const;
export type TipoAlegacao = (typeof TIPOS_ALEGACAO)[number];

export const ROTULOS_VEREDITO: Readonly<Record<Veredito, string>> = {
  confirmado: 'CONFIRMADO',
  falso: 'FALSO',
  desatualizado: 'DESATUALIZADO',
  impreciso: 'IMPRECISO',
  'ainda-nao-definido': 'AINDA NÃO DEFINIDO',
  'sem-respaldo-oficial': 'SEM RESPALDO OFICIAL',
  'fora-do-escopo': 'FORA DO ESCOPO',
};

const EXPLICACAO_PADRAO: Readonly<Record<Veredito, string>> = {
  confirmado: 'A fonte oficial citada afirma o mesmo que a alegação.',
  falso: 'A fonte oficial vigente citada afirma o contrário da alegação.',
  desatualizado: 'A alegação se baseia em norma que foi alterada, revogada ou prorrogada por ato posterior.',
  impreciso: 'A alegação está só parcialmente correta; veja o que dizem as fontes citadas.',
  'ainda-nao-definido': 'O órgão responsável informa que a definição ainda será publicada.',
  'sem-respaldo-oficial': 'Não encontramos fonte oficial que confirme ou contradiga a alegação. Isso não significa que ela seja falsa.',
  'fora-do-escopo': 'Opinião, previsão ou tema fora do escopo desta plataforma (ISS municipal, por exemplo).',
};

/** Trecho oficial enviado ao modelo, com o texto exato que ele recebeu. */
export interface ItemEvidencia {
  readonly ref: string;
  readonly evidencia: Evidencia;
  readonly textoEnviado: string;
  /** Descrição do ato que revogou o documento (relação aprovada, com efeito já iniciado); null se vigente. */
  readonly revogadoPor: string | null;
}

export interface ItemFato {
  readonly ref: string;
  readonly fato: FatoPublico;
  readonly refEvidencia: string;
}

export interface ItemRelacao {
  readonly ref: string;
  readonly relacao: RelacaoPublica;
  readonly refEvidencia: string;
}

export interface ContextoRegras {
  readonly evidencias: ReadonlyMap<string, ItemEvidencia>;
  readonly fatos: ReadonlyMap<string, ItemFato>;
  readonly relacoes: ReadonlyMap<string, ItemRelacao>;
  readonly fontes: ReadonlyMap<string, Fonte>;
  /** AAAA-MM-DD no fuso de Brasília. */
  readonly hoje: string;
}

export interface VereditoModelo {
  readonly veredito: Veredito;
  readonly explicacao: string;
  readonly evidencias: readonly { readonly ref: string; readonly citacao: string }[];
  readonly fatos: readonly string[];
  readonly relacoes: readonly string[];
}

export interface AlegacaoAvaliada {
  readonly texto: string;
  readonly tipo: TipoAlegacao;
  /** Decidido em código antes do modelo (ex.: ISS municipal). */
  readonly foraDoEscopo: boolean;
}

export interface CitacaoValida {
  readonly item: ItemEvidencia;
  readonly citacao: string;
}

export interface DecisaoAlegacao {
  readonly veredito: Veredito;
  readonly vereditoModelo: Veredito | null;
  readonly rebaixado: boolean;
  readonly motivoRebaixamento: string | null;
  readonly explicacao: string;
  readonly citacoes: readonly CitacaoValida[];
  readonly fatos: readonly ItemFato[];
  readonly relacoes: readonly ItemRelacao[];
  readonly citacoesInvalidas: number;
  readonly avisos: readonly string[];
}

const SHA = /^[0-9a-f]{64}$/;
const MIN_CITACAO = 12;
const MAX_CITACAO = 1500;
const MAX_EXPLICACAO = 600;
const TIPOS_QUE_SUPERAM = new Set(['altera', 'revoga', 'prorroga']);
const PENDENTE = /ser[áa]o?\s+(?:divulgad|publicad|definid|disponibilizad|estabelecid|regulamentad|informad)|futuramente|oportunamente|posteriormente|a\s+ser(?:em)?\s+definid|ainda\s+n[ãa]o\s+(?:foi|foram|est[áa])|em\s+ato\s+pr[óo]prio|em\s+momento\s+oportuno/iu;

const normalizar = (s: string): string => s.replace(/\s+/g, ' ').trim();
const numeros = (s: string): string[] => [...s.matchAll(/\d[\d./-]*\d|\d/g)].map((m) => m[0]);

function nivelDe(item: ItemEvidencia, fontes: ReadonlyMap<string, Fonte>): Nivel | undefined {
  return fontes.get(item.evidencia.fonteId)?.nivel;
}

function origemValida(item: ItemEvidencia, fontes: ReadonlyMap<string, Fonte>): boolean {
  return fontes.has(item.evidencia.fonteId) && SHA.test(item.evidencia.sha256) && verificarOrigem(item.evidencia.url).permitido;
}

/**
 * invariant: citação vale só se for texto contíguo (após normalizar espaços) do que o modelo recebeu, com
 * tamanho mínimo e origem oficial verificável. O modelo não consegue "citar" o que não estava na entrada.
 */
function validarCitacoes(v: VereditoModelo, ctx: ContextoRegras): { validas: CitacaoValida[]; invalidas: number } {
  const validas: CitacaoValida[] = [];
  let invalidas = 0;
  for (const c of v.evidencias) {
    const item = ctx.evidencias.get(c.ref);
    const citacao = normalizar(c.citacao);
    if (
      item === undefined ||
      citacao.length < MIN_CITACAO ||
      citacao.length > MAX_CITACAO ||
      !normalizar(item.textoEnviado).includes(citacao) ||
      !origemValida(item, ctx.fontes)
    ) {
      invalidas++;
      continue;
    }
    if (!validas.some((x) => x.item.ref === item.ref && x.citacao === citacao)) validas.push({ item, citacao });
  }
  return { validas, invalidas };
}

function forte(c: CitacaoValida, ctx: ContextoRegras): boolean {
  const n = nivelDe(c.item, ctx.fontes);
  return n === 'N1' || n === 'N2';
}

function explicacaoSegura(bruta: string, veredito: Veredito, alegacao: string, lastro: readonly string[]): string {
  const limpa = normalizar(sanitizarTexto(bruta).texto).slice(0, MAX_EXPLICACAO);
  if (limpa === '') return EXPLICACAO_PADRAO[veredito];
  const base = [alegacao, ...lastro].join(' ');
  // why: número sem lastro (data, prazo, código) é exatamente o erro que o produto existe para evitar.
  return numeros(limpa).every((n) => base.includes(n)) ? limpa : EXPLICACAO_PADRAO[veredito];
}

function sem(veredito: Veredito, alegacao: AlegacaoAvaliada, motivo: string | null, invalidas: number, vereditoModelo: Veredito | null): DecisaoAlegacao {
  return {
    veredito,
    vereditoModelo,
    rebaixado: motivo !== null,
    motivoRebaixamento: motivo,
    explicacao: EXPLICACAO_PADRAO[veredito],
    citacoes: [],
    fatos: [],
    relacoes: [],
    citacoesInvalidas: invalidas,
    avisos: motivo === null || vereditoModelo === null ? [] : [`Veredito proposto (${ROTULOS_VEREDITO[vereditoModelo]}) rebaixado: ${motivo}.`],
  };
}

/**
 * Regras de evidência mínima por veredito (docs/VERIFICACAO-DE-ALEGACOES.md, passo 6), em código.
 *
 * invariant: falha fechada. Qualquer veredito sem a evidência exigida vira SEM RESPALDO OFICIAL; nunca o
 * contrário (código não promove veredito). Uma injeção que convença o modelo não convence estas regras.
 */
export function aplicarRegras(alegacao: AlegacaoAvaliada, modelo: VereditoModelo | undefined, ctx: ContextoRegras): DecisaoAlegacao {
  if (alegacao.foraDoEscopo) return sem('fora-do-escopo', alegacao, null, 0, modelo?.veredito ?? null);
  if (modelo === undefined) return sem('sem-respaldo-oficial', alegacao, null, 0, null);

  const { validas, invalidas } = validarCitacoes(modelo, ctx);
  const vigentes = validas.filter((c) => c.item.revogadoPor === null);
  const fatos = modelo.fatos.flatMap((ref) => {
    const f = ctx.fatos.get(ref);
    const ev = f === undefined ? undefined : ctx.evidencias.get(f.refEvidencia);
    // invariant: fato só sustenta veredito se aprovado, com o trecho ainda na versão vigente e de fonte N1/N2.
    if (f === undefined || ev === undefined || f.fato.situacao !== 'aprovado' || !f.fato.evidenciaAtual || !origemValida(ev, ctx.fontes)) return [];
    const n = nivelDe(ev, ctx.fontes);
    return n === 'N1' || n === 'N2' ? [f] : [];
  });
  const relacoes = modelo.relacoes.flatMap((ref) => {
    const r = ctx.relacoes.get(ref);
    const ev = r === undefined ? undefined : ctx.evidencias.get(r.refEvidencia);
    if (r === undefined || ev === undefined || r.relacao.situacao !== 'aprovado' || !origemValida(ev, ctx.fontes)) return [];
    if (!TIPOS_QUE_SUPERAM.has(r.relacao.tipo)) return [];
    // invariant: revogação com data futura ainda não tornou nada desatualizado.
    if (r.relacao.efeitoEm !== null && r.relacao.efeitoEm > ctx.hoje) return [];
    return [r];
  });
  const exigeFato = alegacao.tipo === 'prazo' || alegacao.tipo === 'obrigacao';
  const v = modelo.veredito;
  const rebaixar = (motivo: string): DecisaoAlegacao => sem('sem-respaldo-oficial', alegacao, motivo, invalidas, v);

  let usadas: readonly CitacaoValida[] = vigentes;
  const avisos: string[] = [];
  switch (v) {
    case 'fora-do-escopo':
      return sem('fora-do-escopo', alegacao, null, invalidas, v);
    case 'sem-respaldo-oficial':
      return sem('sem-respaldo-oficial', alegacao, null, invalidas, v);
    case 'confirmado':
      if (vigentes.length === 0) return rebaixar('nenhuma citação válida de documento oficial vigente');
      if (!vigentes.some((c) => forte(c, ctx))) avisos.push('Confirmado só por fonte N3 (notícia ou FAQ oficial); confira no ato normativo.');
      break;
    case 'impreciso':
      if (vigentes.length === 0) return rebaixar('nenhuma citação válida de documento oficial vigente');
      if (!vigentes.some((c) => forte(c, ctx))) avisos.push('Avaliação apoiada só em fonte N3 (notícia ou FAQ oficial); confira no ato normativo.');
      break;
    case 'ainda-nao-definido':
      usadas = vigentes.filter((c) => PENDENTE.test(c.citacao));
      if (usadas.length === 0) return rebaixar('nenhum trecho oficial citado diz que a definição está pendente');
      break;
    case 'falso':
      if (!vigentes.some((c) => forte(c, ctx))) return rebaixar('FALSO exige citação de fonte N1 ou N2 vigente');
      if (exigeFato && fatos.length === 0) return rebaixar('FALSO sobre prazo ou obrigação exige fato aprovado pela curadoria');
      break;
    case 'desatualizado': {
      if (relacoes.length === 0) return rebaixar('DESATUALIZADO exige relação aprovada no grafo normativo (alteração, revogação ou prorrogação)');
      const daRelacao = relacoes.flatMap((r) => {
        const item = ctx.evidencias.get(r.refEvidencia);
        return item === undefined ? [] : [{ item, citacao: normalizar(r.relacao.evidenciaTexto) }];
      });
      usadas = [...validas, ...daRelacao.filter((d) => !validas.some((c) => c.item.ref === d.item.ref))];
      if (!usadas.some((c) => forte(c, ctx))) return rebaixar('DESATUALIZADO exige citação de fonte N1 ou N2');
      if (exigeFato && fatos.length === 0) return rebaixar('DESATUALIZADO sobre prazo ou obrigação exige fato aprovado pela curadoria');
      break;
    }
  }
  if (validas.length > vigentes.length && v !== 'desatualizado') {
    avisos.push('Trecho de ato revogado foi desconsiderado.');
  }

  const lastro = [
    ...usadas.map((c) => c.citacao),
    ...fatos.map((f) => `${f.fato.enunciado} ${f.fato.dataEfeito ?? ''}`),
    ...relacoes.map((r) => `${r.relacao.destinoDescricao} ${r.relacao.efeitoEm ?? ''}`),
  ];
  return {
    veredito: v,
    vereditoModelo: v,
    rebaixado: false,
    motivoRebaixamento: null,
    explicacao: explicacaoSegura(modelo.explicacao, v, alegacao.texto, lastro),
    citacoes: usadas,
    fatos,
    relacoes,
    citacoesInvalidas: invalidas,
    avisos,
  };
}
