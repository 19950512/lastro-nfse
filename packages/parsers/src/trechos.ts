import type { BlocoHtml } from './html.ts';

export interface Trecho {
  readonly ordem: number;
  readonly texto: string;
  readonly paginaIni: number | null;
  readonly paginaFim: number | null;
  readonly secao: string | null;
}

export interface OpcoesTrechos {
  readonly maxCaracteres?: number;
}

const MAX_PADRAO = 1800;
const MAX_SECAO = 200;

const colapsar = (s: string): string => s.replace(/\s+/g, ' ').trim();

// why: o sufixo ("Art. 62-A", "Art. 8º-A") vem colado ao número. O catálogo de São Paulo escreve "Art. 9º - São
// responsáveis" e "Art. 11 - A legitimidade", com o hífen entre espaços; ler isso como "Art. 9-S" ou "Art. 11-A"
// faria a resposta citar um dispositivo que não existe.
const ARTIGO = /^Art\.\s{0,3}(\d{1,4})\s{0,2}[º°o]?(?:-([A-Z]{1,2})(?![\p{L}\d]))?/u;
const ESTRUTURA_LEI = /^(LIVRO|T[ÍI]TULO|CAP[ÍI]TULO|Se[çc][ãa]o|SE[ÇC][ÃA]O|Subse[çc][ãa]o|SUBSE[ÇC][ÃA]O|ANEXO)\s/;

/** `Art. 62-A.` → `Art. 62-A`; undefined se o texto não começa um artigo. */
export function secaoDeArtigo(texto: string): string | undefined {
  const m = ARTIGO.exec(texto);
  if (m === null) return undefined;
  return m[2] === undefined ? `Art. ${m[1] ?? ''}` : `Art. ${m[1] ?? ''}-${m[2]}`;
}

function cortarSecao(texto: string): string {
  const limpo = colapsar(texto);
  return limpo.length <= MAX_SECAO ? limpo : `${limpo.slice(0, MAX_SECAO - 1)}…`;
}

/** Quebra um texto longo perto do limite, de preferência em fim de frase, depois em espaço. */
function quebrarLongo(texto: string, max: number): string[] {
  const partes: string[] = [];
  let resto = texto;
  while (resto.length > max) {
    const janela = resto.slice(0, max);
    const fimFrase = Math.max(janela.lastIndexOf('. '), janela.lastIndexOf('; '), janela.lastIndexOf(': '));
    const espaco = janela.lastIndexOf(' ');
    const corte = fimFrase >= max * 0.5 ? fimFrase + 1 : espaco >= max * 0.5 ? espaco : max;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto !== '') partes.push(resto);
  return partes;
}

/** Agrupa parágrafos em pedaços de até `max` caracteres, sem cortar parágrafo que caiba inteiro. */
function agrupar(paragrafos: readonly string[], max: number, separador: string): string[] {
  const pedacos: string[] = [];
  let atual = '';
  for (const p of paragrafos.flatMap((x) => quebrarLongo(x, max))) {
    if (atual !== '' && atual.length + separador.length + p.length > max) {
      pedacos.push(atual);
      atual = p;
    } else {
      atual = atual === '' ? p : `${atual}${separador}${p}`;
    }
  }
  if (atual !== '') pedacos.push(atual);
  return pedacos;
}

interface Grupo {
  secao: string | null;
  paragrafos: string[];
  soEstrutura: boolean;
}

/**
 * Trechos de uma página HTML respeitando a estrutura.
 *
 * invariant: em texto legal (3 ou mais parágrafos começando com "Art."), cada artigo começa um trecho
 * novo com `secao = "Art. N"`, e títulos estruturais (capítulo, seção) vão junto do artigo seguinte;
 * artigo longo é dividido em parágrafos, mantendo a mesma seção, para a citação apontar o dispositivo.
 */
export function trechosDeHtml(blocos: readonly BlocoHtml[], opcoes: OpcoesTrechos = {}): Trecho[] {
  const max = opcoes.maxCaracteres ?? MAX_PADRAO;
  const legal = blocos.filter((b) => b.tipo === 'paragrafo' && secaoDeArtigo(b.texto) !== undefined).length >= 3;
  const grupos: Grupo[] = [];
  let atual: Grupo = { secao: null, paragrafos: [], soEstrutura: false };
  const fechar = (proximo: Grupo): void => {
    if (atual.paragrafos.length > 0) grupos.push(atual);
    atual = proximo;
  };

  for (const bloco of blocos) {
    const texto = colapsar(bloco.texto);
    if (texto === '') continue;
    const artigo = legal ? secaoDeArtigo(texto) : undefined;
    if (artigo !== undefined) {
      if (atual.soEstrutura) {
        atual.secao = artigo;
        atual.soEstrutura = false;
        atual.paragrafos.push(texto);
      } else {
        fechar({ secao: artigo, paragrafos: [texto], soEstrutura: false });
      }
    } else if (bloco.tipo === 'titulo' || (legal && ESTRUTURA_LEI.test(texto))) {
      if (atual.soEstrutura) atual.paragrafos.push(texto);
      else fechar({ secao: cortarSecao(texto), paragrafos: [texto], soEstrutura: legal });
    } else {
      atual.paragrafos.push(texto);
    }
  }
  fechar({ secao: null, paragrafos: [], soEstrutura: false });

  const trechos: Trecho[] = [];
  for (const grupo of grupos) {
    for (const texto of agrupar(grupo.paragrafos, max, '\n')) {
      trechos.push({ ordem: trechos.length, texto, paginaIni: null, paginaFim: null, secao: grupo.secao });
    }
  }
  return trechos;
}

const NUMERO_DE_PAGINA = /^(?:\d{1,4}|P[áa]gina\s+\d{1,4}(?:\s+de\s+\d{1,4})?|\d{1,4}\s*\/\s*\d{1,4})$/i;
const TITULO_NUMERADO = /^(\d{1,2})((?:\.\d{1,3}){0,4})\.?\s+(\S.*)$/;
const TITULO_ESTRUTURAL_PDF = /^(CAP[ÍI]TULO|ANEXO|SE[ÇC][ÃA]O|T[ÍI]TULO)\b/;

// why: em atos oficiais o nome do capítulo vem na linha seguinte ao número, em maiúsculas
// ("CAPÍTULO I" / "DISPOSIÇÕES GERAIS"); ele pertence ao título, não ao corpo.
function ehRotuloMaiusculo(linha: string): boolean {
  return linha.length <= 80 && linha === linha.toUpperCase() && /[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(linha);
}

function secaoDeLinhaPdf(linha: string): string | undefined {
  // why: linhas de sumário ("2.3 Título ........ 4") repetem os títulos; tratá-las como seção
  // faria cada linha do sumário virar um trecho isolado.
  if (linha.length > 120 || linha.includes('.....')) return undefined;
  const artigo = secaoDeArtigo(linha);
  if (artigo !== undefined) return artigo;
  if (TITULO_ESTRUTURAL_PDF.test(linha)) return cortarSecao(linha);
  const m = TITULO_NUMERADO.exec(linha);
  if (m === null) return undefined;
  const resto = m[3] ?? '';
  // why: "1 Os contribuintes devem…" é frase numerada, não título; título é curto, começa em
  // maiúscula e não termina como frase ou item de lista.
  if (!/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(resto) || /[.,;:]$/.test(resto) || resto.split(' ').length > 12) return undefined;
  return cortarSecao(linha);
}

/**
 * Trechos de um PDF com página inicial e final (1 = primeira página).
 *
 * invariant: o trecho nunca mistura seções; um título detectado (artigo, capítulo, item numerado)
 * fecha o trecho anterior. Linhas só com número de página são descartadas.
 */
export function trechosDePdf(paginas: readonly string[], opcoes: OpcoesTrechos = {}): Trecho[] {
  const max = opcoes.maxCaracteres ?? MAX_PADRAO;
  const trechos: Trecho[] = [];
  let secao: string | null = null;
  let linhas: string[] = [];
  let soTitulos = false;
  let tamanho = 0;
  let paginaIni: number | null = null;
  let paginaFim: number | null = null;

  const fechar = (): void => {
    if (linhas.length > 0) {
      for (const texto of agrupar([linhas.join(' ')], max, ' ')) {
        trechos.push({ ordem: trechos.length, texto, paginaIni, paginaFim, secao });
      }
    }
    linhas = [];
    soTitulos = false;
    tamanho = 0;
    paginaIni = null;
    paginaFim = null;
  };

  paginas.forEach((pagina, indice) => {
    const numero = indice + 1;
    const doTexto = pagina.split('\n').map(colapsar).filter((l) => l !== '');
    while (doTexto.length > 0 && NUMERO_DE_PAGINA.test(doTexto[0] ?? '')) doTexto.shift();
    while (doTexto.length > 0 && NUMERO_DE_PAGINA.test(doTexto.at(-1) ?? '')) doTexto.pop();
    for (const linha of doTexto) {
      const novaSecao = secaoDeLinhaPdf(linha);
      const ultima = linhas.at(-1) ?? '';
      if (novaSecao !== undefined) {
        // invariant: títulos seguidos ("CAPÍTULO I" + "Art. 1º") ficam no mesmo trecho, com a seção mais específica.
        if (!soTitulos || tamanho + linha.length + 1 > max) fechar();
        secao = novaSecao;
        soTitulos = (linhas.length === 0 || soTitulos) && secaoDeArtigo(linha) === undefined;
      } else if (tamanho + linha.length + 1 > max || (tamanho >= max * 0.75 && /[.:;]$/.test(ultima))) {
        fechar();
      }
      if (novaSecao === undefined && !(soTitulos && ehRotuloMaiusculo(linha))) soTitulos = false;
      linhas.push(linha);
      tamanho += linha.length + 1;
      paginaIni ??= numero;
      paginaFim = numero;
    }
  });
  fechar();
  return trechos;
}
