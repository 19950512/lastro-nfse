import { verificarOrigem, type Fonte } from '@lastro/core';
import type { BlocoModelo, CitacaoModelo, ResultadoBusca } from './modelo.ts';
import { AVISO_PADRAO, FRASE_SEM_RESPOSTA, LIMITES_PADRAO } from './prompt.ts';
import type { Rota } from './roteador.ts';
import type { Evidencia, FonteCitada, RespostaPergunta } from './tipos.ts';

const SHA = /^[0-9a-f]{64}$/;
const MAX_PALAVRAS_CONECTIVO = 12;
const MAX_TRECHO_CITADO = 2000;

const FUSO = 'America/Sao_Paulo';
const formatoData = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' });
const formatoIso = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' });

export const dataBrasil = (d: Date): string => formatoData.format(d);
export const dataIsoBrasil = (d: Date): string => formatoIso.format(d);

const semAcento = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const TEMA_PRAZO = /prazo|obrigat|vigencia|vigor|a partir de|ate \d|data|adiad|prorrog|\d{1,2}\/\d{1,2}\/\d{2,4}/;

/** Controles C0 (exceto tab e quebras), DEL e marcas bidi (Trojan Source) não têm uso legítimo em resposta de texto. */
function caractereProibido(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return cp < 0x20 || cp === 0x7f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}

/**
 * Remove da saída do modelo o que não pode ir ao cliente (SEGURANCA.md §4 e LLM05): imagens, HTML,
 * caracteres de controle e links para fora da lista oficial. Links oficiais viram texto simples, porque
 * as URLs já saem estruturadas em `fontes`.
 *
 * hazard: todas as expressões têm quantificadores limitados e sem aninhamento, para não abrir ReDoS.
 */
export function sanitizarTexto(texto: string): { texto: string; removidos: number } {
  let removidos = 0;
  let saida = '';
  for (const c of texto) {
    if (caractereProibido(c.codePointAt(0) ?? 0)) removidos++;
    else saida += c;
  }
  saida = saida.replace(/!\[[^\]\n]{0,500}\]\([^)\s]{0,2000}\)/g, () => {
    removidos++;
    return '';
  });
  saida = saida.replace(/\[([^\]\n]{0,500})\]\(([^)\s]{0,2000})\)/g, (_m, rotulo: string, url: string) => {
    if (!verificarOrigem(url).permitido) removidos++;
    return rotulo;
  });
  saida = saida.replace(/https?:\/\/[^\s<>()"'\]]{1,2000}/g, (url) => {
    if (verificarOrigem(url.replace(/[.,;:]+$/, '')).permitido) return url;
    removidos++;
    return '[link removido]';
  });
  saida = saida.replace(/<\/?[a-zA-Z][^<>]{0,500}>/g, () => {
    removidos++;
    return '';
  });
  return { texto: saida, removidos };
}

const compactar = (s: string): string => s.replace(/\s+/g, '');

function citacaoValida(c: CitacaoModelo, resultados: readonly ResultadoBusca[]): boolean {
  const r = resultados[c.indiceResultado];
  if (r === undefined || !Number.isInteger(c.inicioBloco) || !Number.isInteger(c.fimBloco)) return false;
  if (c.inicioBloco < 0 || c.fimBloco <= c.inicioBloco || c.fimBloco > r.blocos.length) return false;
  // invariant: o texto citado tem de existir literalmente no que foi enviado ao modelo.
  return compactar(r.blocos.slice(c.inicioBloco, c.fimBloco).join('')) === compactar(c.textoCitado);
}

const numeros = (s: string): string[] => [...s.matchAll(/\d[\d./-]*\d|\d/g)].map((m) => m[0]);

interface Analisado {
  readonly texto: string;
  readonly citacoes: readonly CitacaoModelo[];
}

/**
 * Bloco sem citação só fica se for conectivo ("De acordo com", "Além disso,"): curto e sem número que
 * não esteja nos trechos citados pelos blocos vizinhos. Número sem lastro é exatamente o tipo de erro
 * (data, prazo, código) que o produto existe para evitar.
 */
function conectivoAceitavel(bloco: Analisado, vizinhos: readonly Analisado[], resultados: readonly ResultadoBusca[]): boolean {
  const palavras = bloco.texto.trim().split(/\s+/).filter((p) => p !== '');
  if (palavras.length > MAX_PALAVRAS_CONECTIVO) return false;
  const nums = numeros(bloco.texto);
  if (nums.length === 0) return true;
  const lastro = vizinhos
    .flatMap((v) => v.citacoes)
    .map((c) => resultados[c.indiceResultado]?.blocos.join(' ') ?? '')
    .join(' ');
  return nums.every((n) => lastro.includes(n));
}

export interface EntradaChecagem {
  readonly rota: Rota;
  readonly blocos: readonly BlocoModelo[];
  readonly parada: string | null;
  readonly evidencias: readonly Evidencia[];
  readonly resultados: readonly ResultadoBusca[];
  readonly fontes: readonly Fonte[];
  readonly agora: Date;
}

export interface ResultadoChecagem {
  readonly resposta: RespostaPergunta;
  readonly evidenciasCitadas: readonly Evidencia[];
}

export function respostaSemModelo(rota: Rota, situacao: 'sem-resposta' | 'fora-do-escopo' | 'rejeitada', texto: string, agora: Date, avisos: readonly string[] = []): RespostaPergunta {
  return {
    situacao,
    rota,
    resposta: texto,
    posicao_em: dataIsoBrasil(agora),
    fontes: [],
    avisos,
    limites: [...LIMITES_PADRAO],
    aviso: AVISO_PADRAO,
    checagem: { citacoes_invalidas: 0, frases_sem_citacao_removidas: 0, conteudo_removido: 0 },
  };
}

/**
 * Checagem pós-geração, determinística e sem LLM (ARQUITETURA.md §2.7). Falha fechada: o que não passa
 * é removido; se nada citado sobra, a resposta vira "não encontrei"; origem fora da lista rejeita tudo.
 */
export function checarResposta(e: EntradaChecagem): ResultadoChecagem {
  if (e.evidencias.length !== e.resultados.length) throw new Error('evidências e resultados fora de correspondência');
  const fontesPorId = new Map(e.fontes.map((f) => [f.id, f]));

  if (e.parada === 'refusal') {
    return { resposta: respostaSemModelo(e.rota, 'rejeitada', 'Não foi possível gerar uma resposta verificável para esta pergunta.', e.agora, ['O modelo recusou a pergunta.']), evidenciasCitadas: [] };
  }
  if (e.parada !== 'end_turn' && e.parada !== 'stop_sequence') {
    return { resposta: respostaSemModelo(e.rota, 'rejeitada', 'Não foi possível gerar uma resposta verificável para esta pergunta.', e.agora, [`Geração interrompida (${e.parada ?? 'sem motivo'}).`]), evidenciasCitadas: [] };
  }

  let citacoesInvalidas = 0;
  let conteudoRemovido = 0;
  const analisados: Analisado[] = e.blocos.map((b) => {
    const validas = b.citacoes.filter((c) => citacaoValida(c, e.resultados));
    citacoesInvalidas += b.citacoes.length - validas.length;
    const limpo = sanitizarTexto(b.texto);
    conteudoRemovido += limpo.removidos;
    return { texto: limpo.texto, citacoes: validas };
  });

  const textoTotal = analisados.map((a) => a.texto).join('');
  const algumaCitacao = analisados.some((a) => a.citacoes.length > 0);
  if (!algumaCitacao) {
    const avisos = textoTotal.includes(FRASE_SEM_RESPOSTA) || textoTotal.trim() === '' ? [] : ['A resposta gerada não tinha citação de fonte oficial e foi descartada.'];
    return { resposta: respostaSemModelo(e.rota, 'sem-resposta', FRASE_SEM_RESPOSTA, e.agora, avisos), evidenciasCitadas: [] };
  }

  const numeroDaFonte = new Map<number, number>();
  const citadosPorResultado = new Map<number, string[]>();
  const partes: string[] = [];
  let frasesRemovidas = 0;
  let prazoSoN3 = false;
  let soAtoRevogado = 0;

  for (const [i, a] of analisados.entries()) {
    if (a.citacoes.length === 0) {
      const vizinhos = [analisados[i - 1], analisados[i + 1]].filter((v): v is Analisado => v !== undefined);
      if (conectivoAceitavel(a, vizinhos, e.resultados)) partes.push(a.texto);
      else if (a.texto.trim() !== '') frasesRemovidas++;
      continue;
    }
    /* invariant: frase apoiada só em ato revogado (grafo normativo aprovado) não sai como o que vale hoje
       (ARQUITETURA.md §2.7, item 5); "a Resolução X previa…, mas foi revogada pela Y" fica, porque cita também o ato que revogou. */
    if (a.citacoes.every((c) => (e.evidencias[c.indiceResultado]?.revogadoPor ?? null) !== null)) {
      soAtoRevogado++;
      continue;
    }
    const marcadores: number[] = [];
    for (const c of a.citacoes) {
      if (!numeroDaFonte.has(c.indiceResultado)) numeroDaFonte.set(c.indiceResultado, numeroDaFonte.size + 1);
      const n = numeroDaFonte.get(c.indiceResultado) ?? 0;
      if (!marcadores.includes(n)) marcadores.push(n);
      const lista = citadosPorResultado.get(c.indiceResultado) ?? [];
      if (!lista.includes(c.textoCitado)) lista.push(c.textoCitado);
      citadosPorResultado.set(c.indiceResultado, lista);
    }
    const niveis = a.citacoes.map((c) => fontesPorId.get(e.evidencias[c.indiceResultado]?.fonteId ?? '')?.nivel);
    if (TEMA_PRAZO.test(semAcento(a.texto)) && niveis.every((n) => n === 'N3')) prazoSoN3 = true;
    const final = /\s*$/.exec(a.texto)?.[0] ?? '';
    partes.push(`${a.texto.slice(0, a.texto.length - final.length)} ${marcadores.map((n) => `[${n}]`).join('')}${final}`);
  }

  const avisos: string[] = [];
  const fontesSaida: FonteCitada[] = [];
  const evidenciasCitadas: Evidencia[] = [];
  for (const [indice, numero] of [...numeroDaFonte.entries()].sort((a, b) => a[1] - b[1])) {
    const ev = e.evidencias[indice];
    const fonte = ev === undefined ? undefined : fontesPorId.get(ev.fonteId);
    // invariant: toda citação aponta para snapshot com hash, de origem da lista oficial e de fonte do catálogo.
    if (ev === undefined || fonte === undefined || !SHA.test(ev.sha256) || !verificarOrigem(ev.url).permitido) {
      return {
        resposta: respostaSemModelo(e.rota, 'rejeitada', 'Não foi possível gerar uma resposta verificável para esta pergunta.', e.agora, ['Citação sem origem oficial verificável.']),
        evidenciasCitadas: [],
      };
    }
    evidenciasCitadas.push(ev);
    fontesSaida.push({
      id: numero,
      titulo: ev.titulo,
      orgao: fonte.orgao,
      nivel: fonte.nivel,
      url: ev.url,
      secao: ev.secao,
      pagina: ev.paginaIni,
      trecho: (citadosPorResultado.get(indice) ?? []).join(' … ').slice(0, MAX_TRECHO_CITADO),
      coletado_em: ev.coletadoEm,
      confirmado_em: ev.confirmadoEm,
      sha256: ev.sha256,
      snapshot_id: ev.snapshotId,
      documento_id: ev.documentoId,
      original: `/v1/snapshots/${ev.snapshotId}/original`,
    });
    if (e.agora.getTime() - new Date(ev.confirmadoEm).getTime() > fonte.slaHoras * 3_600_000) {
      avisos.push(`Fonte [${numero}] verificada pela última vez em ${dataBrasil(new Date(ev.confirmadoEm))}.`);
    }
    if (ev.documentoIndisponivel) {
      avisos.push(`Fonte [${numero}] não estava disponível no site oficial na última coleta; o texto citado é a última versão arquivada.`);
    }
  }
  if (numeroDaFonte.size === 0) {
    return {
      resposta: respostaSemModelo(e.rota, 'sem-resposta', FRASE_SEM_RESPOSTA, e.agora, ['A resposta gerada citava só ato revogado e foi descartada.']),
      evidenciasCitadas: [],
    };
  }
  if (soAtoRevogado > 0) avisos.push('Parte do texto gerado citava só ato já revogado e foi removida.');
  if (prazoSoN3) avisos.push('Há afirmação sobre prazo ou obrigação apoiada só em fonte N3 (notícia ou FAQ oficial); confira no ato normativo.');
  if (frasesRemovidas > 0) avisos.push('Parte do texto gerado foi removida por não ter citação de fonte oficial.');
  if (conteudoRemovido > 0) avisos.push('Links externos, imagens ou marcação foram removidos da resposta.');

  return {
    resposta: {
      situacao: 'respondida',
      rota: e.rota,
      resposta: partes.join('').replace(/[ \t]{2,}/g, ' ').trim(),
      posicao_em: dataIsoBrasil(e.agora),
      fontes: fontesSaida,
      avisos,
      limites: [...LIMITES_PADRAO],
      aviso: AVISO_PADRAO,
      checagem: { citacoes_invalidas: citacoesInvalidas, frases_sem_citacao_removidas: frasesRemovidas, conteudo_removido: conteudoRemovido },
    },
    evidenciasCitadas,
  };
}
