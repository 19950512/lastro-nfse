export const ROTAS = ['fora-do-escopo', 'iss-aliquota', 'iss', 'codigo', 'campo', 'prazo', 'conceitual'] as const;
export type Rota = (typeof ROTAS)[number];

export const sem = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const ISS = /\b(iss|issqn)\b|imposto sobre servicos de qualquer natureza/;
const ALIQUOTA = /aliquota/;
const ASSUNTO_MUNICIPAL =
  /apuracao|recolh|base de calculo|lei municipal|legislacao municipal|retencao|reter|guia|codigo tributario municipal|local de incidencia|substituicao tributaria|responsavel tributario|isencao|isento|regulamento/;
const CONSULTORIA = /planejamento tributario|pagar menos imposto|reduzir (a )?carga|elisao|vale a pena (abrir|mudar)/;
const CODIGO = /cclasstrib|\bnbs\b|indop|\bcst\b|codigo de (tributacao|classificacao)|item da lista|subitem|lista de servicos/;
const CAMPO = /\bcampo\b|\btag\b|\bxpath\b|\belemento\b|leiaute|layout|\bxsd\b/;
const PRAZO = /prazo|quando|a partir de|obrigat|vigencia|vigor|data|cronograma|ate quando|adiad|prorrog/;

/**
 * Escolhe o caminho mais determinístico possível (ARQUITETURA.md §2.5).
 *
 * why: ISS (Fase 5) tem caminho próprio. Alíquota vai à tabela oficial do Portal NFS-e, sem modelo; apuração,
 * retenção e recolhimento vão só à LC 116 e à legislação dos municípios coletados. Responder sobre um município sem
 * a lei dele seria inventar, e essa recusa é decidida em código, no pipeline, antes de qualquer chamada ao modelo.
 */
export function classificarPergunta(pergunta: string): Rota {
  const p = sem(pergunta);
  if (CONSULTORIA.test(p)) return 'fora-do-escopo';
  if (ISS.test(p) && ALIQUOTA.test(p)) return 'iss-aliquota';
  if (ISS.test(p) && ASSUNTO_MUNICIPAL.test(p)) return 'iss';
  if (CODIGO.test(p)) return 'codigo';
  if (CAMPO.test(p) || /\b[a-z]+[A-Z][A-Za-z]*\b/.test(pergunta)) return 'campo';
  if (PRAZO.test(p)) return 'prazo';
  return 'conceitual';
}

/** Termos da pergunta que podem ser nome de campo do leiaute (ex.: indFinal, cClassTrib, xDescServ). */
export function candidatosCampo(pergunta: string): string[] {
  return [...new Set([...pergunta.matchAll(/\b[a-z]{1,8}[A-Z][A-Za-z0-9]{1,40}\b/g)].map((m) => m[0]))].slice(0, 5);
}

/** Códigos citados na pergunta (ex.: 000001, 1.05, 01.05.00, 1.0101.10.00). */
export function candidatosCodigo(pergunta: string): string[] {
  return [...new Set([...pergunta.matchAll(/\b\d[\d.]{1,20}\d\b|\b\d{2,}\b/g)].map((m) => m[0]))].slice(0, 5);
}
