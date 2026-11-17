/**
 * Identificação de atos normativos e das relações entre eles por regras (sem LLM), para o grafo normativo
 * (ARQUITETURA.md §2.3). Tudo o que sai daqui é proposta: só vale depois da dupla aprovação na curadoria.
 *
 * hazard: as expressões rodam sobre texto de documentos externos; todos os quantificadores são limitados e
 * sem aninhamento ambíguo, para não abrir ReDoS (o CodeQL já apontou um caso polinomial neste projeto).
 */

export const EXTRATOR_REGRAS = 'regras-v2';

const TIPO_EM_CAIXA_ALTA = /^[A-ZÀ-Ý][A-ZÀ-Ý -]{2,40}\s/u;

export interface ReferenciaAto {
  /** Texto literal da referência, como aparece no documento. */
  readonly texto: string;
  readonly inicio: number;
  readonly fim: number;
  readonly tipo: string;
  readonly orgao: string | null;
  readonly numero: string;
  readonly ano: number | null;
  /** AAAA-MM-DD quando a referência traz dia e mês. */
  readonly data: string | null;
  /** Identidade canônica (ex.: resolucao-cgibs-11-2026); null quando falta o ano. */
  readonly chave: string | null;
}

export type TipoRelacao = 'altera' | 'revoga' | 'prorroga' | 'regulamenta';

export interface RelacaoProposta {
  readonly tipo: TipoRelacao;
  readonly destino: ReferenciaAto;
  readonly dispositivo: string | null;
  /** invariant: revogação com data futura ("Ficam revogados a partir de 1º de janeiro de 2033") só vale a partir dela. */
  readonly efeitoEm: string | null;
  /** Substring literal do trecho que sustenta a relação. */
  readonly evidencia: string;
}

const TIPOS: readonly (readonly [RegExp, string])[] = [
  [/^ato tecnico conjunto$/, 'ato-tecnico-conjunto'],
  [/^ato conjunto$/, 'ato-conjunto'],
  [/^resolucao$/, 'resolucao'],
  [/^portaria conjunta$/, 'portaria-conjunta'],
  [/^portaria$/, 'portaria'],
  [/^instrucao normativa$/, 'instrucao-normativa'],
  [/^lei complementar$/, 'lei-complementar'],
  [/^decreto-lei$/, 'decreto-lei'],
  [/^decreto$/, 'decreto'],
  [/^lei$/, 'lei'],
  [/^medida provisoria$/, 'medida-provisoria'],
  [/^emenda constitucional$/, 'emenda-constitucional'],
  [/^nota tecnica$/, 'nota-tecnica'],
];

const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const semAcento = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// why: "Lei Complementar" antes de "Lei" e "Decreto-Lei" antes de "Decreto"; a alternância pega a primeira que casa.
const PADRAO_TIPO =
  'ato\\s+t[ée]cnico\\s+conjunto|ato\\s+conjunto|resolu[çc][ãa]o|portaria\\s+conjunta|portaria|instru[çc][ãa]o\\s+normativa|lei\\s+complementar|decreto-lei|decreto|lei|medida\\s+provis[óo]ria|emenda\\s+constitucional|nota\\s+t[ée]cnica';
const PADRAO_ORGAO = '[\\p{L}][\\p{L}\\d-]{0,30}(?:\\s?\\/\\s?[\\p{L}][\\p{L}\\d-]{0,30}){0,5}';
const PADRAO_NUMERO = '\\d{1,6}(?:\\.\\d{3}){0,2}(?:-\\d{1,3})?';
const PADRAO_MES = 'janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';

const REFERENCIA = new RegExp(
  `(?<![\\p{L}\\d])(${PADRAO_TIPO})(?:\\s+(${PADRAO_ORGAO}))?\\s+n\\s?[º°o]\\.?\\s?(${PADRAO_NUMERO})` +
    `(?:,?\\s+(?:de\\s+)?(\\d{1,2})[º°o]?\\s+(?:de\\s+)?(${PADRAO_MES})\\s+de\\s+(\\d{4})|,\\s+de\\s+(\\d{4})|\\s?\\/\\s?(\\d{4}))?`,
  'giu',
);

function normalizarTipo(bruto: string): string | null {
  const t = semAcento(bruto).replace(/\s+/g, ' ');
  return TIPOS.find(([re]) => re.test(t))?.[1] ?? null;
}

function normalizarOrgao(bruto: string): string | null {
  const segmentos = semAcento(bruto)
    .split('/')
    .map((s) => s.replace(/[^a-z0-9]/g, ''))
    .filter((s) => s !== '');
  return segmentos.length === 0 ? null : segmentos.join('-');
}

const normalizarNumero = (bruto: string): string => bruto.replace(/\./g, '').replace(/^0+(?=\d)/, '');

export function chaveAto(tipo: string, orgao: string | null, numero: string, ano: number | null): string | null {
  if (ano === null) return null;
  const chave = [tipo, orgao, normalizarNumero(numero), String(ano)].filter((p): p is string => p !== null && p !== '').join('-');
  return /^[a-z0-9-]{3,160}$/.test(chave) ? chave : null;
}

/** Todas as referências a atos normativos num texto, na ordem em que aparecem. */
export function encontrarReferencias(texto: string): ReferenciaAto[] {
  const saida: ReferenciaAto[] = [];
  for (const m of texto.matchAll(REFERENCIA)) {
    const tipo = normalizarTipo(m[1] ?? '');
    const numero = m[3];
    if (tipo === null || numero === undefined) continue;
    const orgaoBruto = m[2];
    // why: o órgão é opcional e a expressão é insensível a caixa; "no" (de "Lei no 22") não pode virar órgão.
    const orgao = orgaoBruto === undefined || /^n[º°o]\.?$/i.test(orgaoBruto) ? null : normalizarOrgao(orgaoBruto);
    const anoTexto = m[6] ?? m[7] ?? m[8];
    const ano = anoTexto === undefined ? null : Number(anoTexto);
    const mes = m[5] === undefined ? -1 : MESES.indexOf(semAcento(m[5]));
    const dia = m[4] === undefined ? null : Number(m[4]);
    const data =
      ano !== null && mes >= 0 && dia !== null && dia >= 1 && dia <= 31
        ? `${String(ano)}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
        : null;
    const inicio = m.index;
    saida.push({ texto: m[0], inicio, fim: inicio + m[0].length, tipo, orgao, numero: normalizarNumero(numero), ano, data, chave: chaveAto(tipo, orgao, numero, ano) });
  }
  return saida;
}

export interface CabecalhoAto {
  readonly referencia: ReferenciaAto;
  readonly titulo: string;
}

/**
 * Identidade do próprio documento: a primeira referência completa (com dia, mês e ano) no começo do texto.
 *
 * why: minuta não é ato publicado; um documento cujo título começa por "MINUTA" fica sem identidade, para não
 * resolver relações de outros atos para um rascunho.
 */
export function extrairCabecalho(inicioDoTexto: string): CabecalhoAto | null {
  const janela = inicioDoTexto.slice(0, 800);
  /* why: cabeçalho oficial de ato vem em caixa alta ("RESOLUÇÃO CGIBS Nº 11, DE…"); citação em texto corrido no
     começo de uma página ("Lista de Serviços Anexa à Lei Complementar nº 116…") não é a identidade do documento. */
  const ref = encontrarReferencias(janela).find((r) => r.data !== null && r.chave !== null && r.inicio < 400 && TIPO_EM_CAIXA_ALTA.test(r.texto));
  if (ref === undefined) return null;
  if (/minuta/i.test(janela.slice(Math.max(0, ref.inicio - 40), ref.inicio))) return null;
  return { referencia: ref, titulo: ref.texto.replace(/\s+/g, ' ').trim() };
}

const VERBO_REVOGA = /fica[m]?\s+revogad[oa]s?|revoga[m]?-se|\brevoga[m]?\b/giu;
const DISPOSITIVO = /(?<!\p{L})(?:arts?\.|(?:artigos?|incisos?|al[íi]neas?|itens?|item|par[áa]grafos?|caput|anexos?|cap[íi]tulos?|se[çc][ãa]o|subitens?|dispositivos?)(?!\p{L}))|§/iu;
const A_PARTIR_DE = new RegExp(`a\\s+partir\\s+de\\s+(\\d{1,2})[º°o]?\\s+de\\s+(${PADRAO_MES})\\s+de\\s+(\\d{4})`, 'iu');
const ALCANCE_REVOGACAO = 6000;

function dataDeEfeito(texto: string): string | null {
  const m = A_PARTIR_DE.exec(texto);
  if (m === null) return null;
  const mes = MESES.indexOf(semAcento(m[2] ?? ''));
  const dia = Number(m[1]);
  if (mes < 0 || dia < 1 || dia > 31) return null;
  return `${m[3] ?? ''}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}
const PASSIVA = /\bpel[oa]s?\s*$|\bvide\s*$/iu;
const PASSA_A_VIGORAR = /^[^;().]{0,60}?passa(?:m)?\s+a\s+vigorar\s+com/iu;
const VERBO_ANTES = /\b(altera[m]?|prorroga[m]?|regulamenta[m]?)\s+(?:(?:o|a|os|as)\s+)?(?:\S+\s+){0,3}$/iu;
const ARTIGO_INICIAL = /^\s*Art\.\s?\d{1,4}[º°o]?(?:-[A-Z])?\.?\s*(?:-\s*)?(?:(?:O|A|Os|As)\s+)?/u;
const LIMITE_EVIDENCIA = 1200;
const LIMITE_DISPOSITIVO = 300;
const JANELA_CLAUSULA = 300;

function tipoDoVerbo(verbo: string): TipoRelacao | null {
  const v = semAcento(verbo);
  if (v.startsWith('alter')) return 'altera';
  if (v.startsWith('prorrog')) return 'prorroga';
  if (v.startsWith('regulament')) return 'regulamenta';
  return null;
}

function inicioDoSegmento(texto: string, ate: number, piso: number): number {
  const p = texto.lastIndexOf(';', ate - 1);
  return p >= piso ? p + 1 : piso;
}

function inicioDaClausula(texto: string, ate: number): number {
  const piso = Math.max(0, ate - JANELA_CLAUSULA);
  const janela = texto.slice(piso, ate);
  const artigo = [...janela.matchAll(/Art\.\s?\d/gu)].at(-1);
  const pontoEVirgula = janela.lastIndexOf(';');
  const melhor = Math.max(artigo === undefined ? -1 : artigo.index, pontoEVirgula < 0 ? -1 : pontoEVirgula + 1);
  return melhor < 0 ? piso : piso + melhor;
}

function recortar(texto: string, inicio: number, fim: number): string {
  const ini = Math.max(inicio, fim - LIMITE_EVIDENCIA);
  return texto.slice(ini, fim).trim();
}

function dispositivoDe(segmento: string): string | null {
  const limpo = segmento.replace(ARTIGO_INICIAL, '').replace(/^\s*[IVXLC]{1,6}\s*[-–]\s*/u, '').replace(/\s+/g, ' ').replace(/^[\s,;:.]+|[\s,;:]+$/g, '').trim();
  if (limpo === '' || !DISPOSITIVO.test(limpo)) return null;
  return limpo.length > LIMITE_DISPOSITIVO ? `${limpo.slice(0, LIMITE_DISPOSITIVO - 1)}…` : limpo;
}

/**
 * Relações que o trecho declara sobre outros atos. Conservador de propósito: só cláusulas ativas ("Fica
 * revogada a…", "Altera a…", "A Lei nº… passa a vigorar com…"). Anotações passivas do texto compilado
 * ("Revogado pela…", "Redação dada pela…", "Vide…") descrevem o próprio documento sendo alterado e ficam de fora.
 *
 * invariant: `evidencia` é sempre substring literal de `texto` (o banco recusa a proposta se não for).
 */
export function extrairRelacoes(texto: string, chavePropria: string | null): RelacaoProposta[] {
  const referencias = encontrarReferencias(texto).filter((r) => r.chave !== null && r.chave !== chavePropria);
  if (referencias.length === 0) return [];

  const revogacoes = [...texto.matchAll(VERBO_REVOGA)].map((m) => ({ inicio: m.index, fim: m.index + m[0].length }));
  const saida: RelacaoProposta[] = [];
  const vistas = new Set<string>();
  const incluir = (r: RelacaoProposta): void => {
    const k = `${r.tipo}|${r.destino.chave ?? ''}|${r.dispositivo ?? ''}`;
    if (vistas.has(k)) return;
    vistas.add(k);
    saida.push(r);
  };

  for (const ref of referencias) {
    const depois = PASSA_A_VIGORAR.exec(texto.slice(ref.fim, ref.fim + 120));
    if (depois !== null) {
      const ini = inicioDaClausula(texto, ref.inicio);
      incluir({ tipo: 'altera', destino: ref, dispositivo: dispositivoDe(texto.slice(ini, ref.inicio)), efeitoEm: null, evidencia: recortar(texto, ini, ref.fim + depois[0].length) });
      continue;
    }

    if (PASSIVA.test(texto.slice(Math.max(0, ref.inicio - 40), ref.inicio))) continue;

    const revogacao = revogacoes.filter((v) => v.fim <= ref.inicio && ref.inicio - v.fim <= ALCANCE_REVOGACAO).at(-1);
    const segIni = revogacao === undefined ? -1 : inicioDoSegmento(texto, ref.inicio, revogacao.fim);
    /* why: num rol de revogações ("Ficam revogados: …; a Lei nº…; a Lei Complementar nº…"), o que fica entre o
       último ";" e a referência diz se o ato inteiro foi revogado ou só um dispositivo dele. Um "Art. N" no meio
       indica outra cláusula, que a revogação não alcança. */
    if (revogacao !== undefined && !/Art\.\s?\d/u.test(texto.slice(revogacao.fim, ref.inicio))) {
      const segmento = texto.slice(segIni, ref.inicio);
      const dispositivo = DISPOSITIVO.test(segmento) ? dispositivoDe(segmento) : null;
      const ini = ref.inicio - revogacao.inicio <= LIMITE_EVIDENCIA ? revogacao.inicio : segIni;
      incluir({
        tipo: dispositivo === null ? 'revoga' : 'altera',
        destino: ref,
        dispositivo: dispositivo === null ? null : `revoga ${dispositivo}`.slice(0, LIMITE_DISPOSITIVO),
        efeitoEm: dataDeEfeito(segmento) ?? dataDeEfeito(texto.slice(revogacao.inicio, Math.min(ref.inicio, revogacao.fim + 80))),
        evidencia: recortar(texto, ini, ref.fim),
      });
      continue;
    }

    const verbo = VERBO_ANTES.exec(texto.slice(Math.max(0, ref.inicio - 80), ref.inicio));
    const tipo = verbo === null ? null : tipoDoVerbo(verbo[1] ?? '');
    if (verbo !== null && tipo !== null) {
      const ini = Math.max(0, ref.inicio - 80) + verbo.index;
      incluir({ tipo, destino: ref, dispositivo: null, efeitoEm: null, evidencia: recortar(texto, ini, ref.fim) });
    }
  }
  return saida;
}
