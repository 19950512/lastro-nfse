/**
 * Detecção de mudança anômala (SEGURANCA.md §8, "Integridade do conteúdo").
 *
 * why: página de manutenção, erro servido com HTTP 200 ou site pichado aparecem como "nova versão"
 * com conteúdo muito menor ou sem os links de documentos. Casos reais da Fase 0: INLABS em manutenção
 * e arquivos do gov.br despublicados. A mudança continua arquivada (é prova do que a fonte publicou),
 * mas o evento sai marcado para revisão humana antes de qualquer uso na base de conhecimento.
 */

export interface LadoComparacao {
  readonly urlFinal: string;
  readonly mime: string;
  readonly bytes: number;
  readonly textoNormalizado?: string;
  readonly linksDocumentos?: readonly string[];
}

const ENCOLHIMENTO = 0.3;
const TEXTO_MINIMO = 200;

export function detectarAnomalia(anterior: LadoComparacao, atual: LadoComparacao): string | null {
  const motivos: string[] = [];

  const hostAnterior = new URL(anterior.urlFinal).hostname;
  const hostAtual = new URL(atual.urlFinal).hostname;
  if (hostAnterior !== hostAtual) motivos.push(`destino final mudou de ${hostAnterior} para ${hostAtual}`);

  if (anterior.mime !== atual.mime) motivos.push(`tipo mudou de ${anterior.mime} para ${atual.mime}`);

  const textoAnterior = anterior.textoNormalizado;
  const textoAtual = atual.textoNormalizado;
  if (textoAnterior !== undefined && textoAtual !== undefined) {
    if (textoAnterior.length >= TEXTO_MINIMO && textoAtual.length < textoAnterior.length * ENCOLHIMENTO) {
      motivos.push(`texto encolheu de ${textoAnterior.length} para ${textoAtual.length} caracteres`);
    }
  } else if (anterior.bytes > 0 && atual.bytes < anterior.bytes * ENCOLHIMENTO) {
    motivos.push(`arquivo encolheu de ${anterior.bytes} para ${atual.bytes} bytes`);
  }

  const linksAnteriores = anterior.linksDocumentos;
  if (linksAnteriores !== undefined && atual.linksDocumentos !== undefined && linksAnteriores.length >= 3) {
    const atuais = new Set(atual.linksDocumentos);
    const sumiram = linksAnteriores.filter((d) => !atuais.has(d)).length;
    if (sumiram * 2 >= linksAnteriores.length) {
      motivos.push(`${sumiram} de ${linksAnteriores.length} links de documentos sumiram`);
    }
  }

  return motivos.length === 0 ? null : motivos.join('; ');
}
