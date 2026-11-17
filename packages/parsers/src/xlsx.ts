import { ErroParser } from './erro.ts';
import { nomeLocal, percorrerXml } from './xml.ts';
import { lerZip, type EntradaZip } from './zip.ts';

export interface Planilha {
  readonly nome: string;
  readonly linhas: readonly (readonly string[])[];
}

export interface OpcoesXlsx {
  readonly maxLinhas?: number;
  readonly maxColunas?: number;
}

function arquivo(entradas: readonly EntradaZip[], nome: string): string | undefined {
  return entradas.find((e) => e.nome === nome)?.conteudo.toString('utf8');
}

function lerTextosCompartilhados(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  const textos: string[] = [];
  let atual: string[] | undefined;
  let emT = 0;
  let emFonetica = 0;
  percorrerXml(xml, {
    abrir(nome) {
      const local = nomeLocal(nome);
      if (local === 'si') atual = [];
      else if (local === 'rPh') emFonetica++;
      else if (local === 't') emT++;
    },
    texto(t) {
      if (atual !== undefined && emT > 0 && emFonetica === 0) atual.push(t);
    },
    fechar(nome) {
      const local = nomeLocal(nome);
      if (local === 'si') {
        textos.push((atual ?? []).join(''));
        atual = undefined;
      } else if (local === 'rPh') emFonetica--;
      else if (local === 't') emT--;
    },
  });
  return textos;
}

interface FolhaDeclarada {
  readonly nome: string;
  readonly caminho: string;
}

function lerFolhas(entradas: readonly EntradaZip[]): FolhaDeclarada[] {
  const workbook = arquivo(entradas, 'xl/workbook.xml');
  const relacoes = arquivo(entradas, 'xl/_rels/workbook.xml.rels');
  if (workbook === undefined || relacoes === undefined) throw new ErroParser('XLSX sem xl/workbook.xml');
  const alvos = new Map<string, string>();
  percorrerXml(relacoes, {
    abrir(nome, a) {
      if (nomeLocal(nome) === 'Relationship' && a.Id !== undefined && a.Target !== undefined) alvos.set(a.Id, a.Target);
    },
    texto() {},
    fechar() {},
  });
  const folhas: FolhaDeclarada[] = [];
  percorrerXml(workbook, {
    abrir(nome, a) {
      if (nomeLocal(nome) !== 'sheet') return;
      const id = a['r:id'] ?? Object.entries(a).find(([k]) => nomeLocal(k) === 'id' && k.includes(':'))?.[1];
      const alvo = id === undefined ? undefined : alvos.get(id);
      if (alvo === undefined) return;
      const caminho = alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`;
      folhas.push({ nome: a.name ?? caminho, caminho });
    },
    texto() {},
    fechar() {},
  });
  return folhas;
}

function indiceColuna(referencia: string | undefined): number | undefined {
  if (referencia === undefined) return undefined;
  const letras = /^([A-Z]{1,3})\d*$/.exec(referencia)?.[1];
  if (letras === undefined) return undefined;
  let indice = 0;
  for (const letra of letras) indice = indice * 26 + (letra.charCodeAt(0) - 64);
  return indice - 1;
}

interface Mesclagem {
  readonly linha1: number;
  readonly coluna1: number;
  readonly linha2: number;
  readonly coluna2: number;
}

function lerMesclagem(ref: string | undefined): Mesclagem | undefined {
  const m = /^([A-Z]{1,3})(\d{1,7}):([A-Z]{1,3})(\d{1,7})$/.exec(ref ?? '');
  if (m === null) return undefined;
  const coluna1 = indiceColuna(m[1]);
  const coluna2 = indiceColuna(m[3]);
  if (coluna1 === undefined || coluna2 === undefined) return undefined;
  return { linha1: Number(m[2]), coluna1, linha2: Number(m[4]), coluna2 };
}

// hazard: uma mesclagem forjada pode cobrir a planilha inteira; o total de células preenchidas é limitado.
const MAX_CELULAS_MESCLADAS = 5_000_000;

// why: nos anexos oficiais, células mescladas (ex.: o item da LC 116 que vale para várias NBS) só
// guardam o valor na primeira célula; sem propagar, as linhas seguintes perderiam a chave.
function aplicarMesclagens(porNumero: Map<number, string[]>, mesclagens: readonly Mesclagem[], maxColunas: number): void {
  let preenchidas = 0;
  for (const m of mesclagens) {
    const valor = porNumero.get(m.linha1)?.[m.coluna1];
    if (valor === undefined || valor === '') continue;
    for (let l = m.linha1; l <= m.linha2; l++) {
      const linha = porNumero.get(l);
      if (linha === undefined) continue;
      for (let c = m.coluna1; c <= Math.min(m.coluna2, maxColunas - 1); c++) {
        if (++preenchidas > MAX_CELULAS_MESCLADAS) throw new ErroParser('planilha com mesclagens demais');
        if (linha[c] === undefined || linha[c] === '') linha[c] = valor;
      }
    }
  }
}

function lerFolha(xml: string, compartilhados: readonly string[], maxLinhas: number, maxColunas: number): string[][] {
  const porNumero = new Map<number, string[]>();
  const mesclagens: Mesclagem[] = [];
  let linha: string[] | undefined;
  let numeroLinha = 0;
  let celula: { coluna: number; tipo: string; v: string[]; inline: string[] } | undefined;
  let proximaColuna = 0;
  let dentro: 'v' | 't' | undefined;
  let emFormula = 0;
  let emFonetica = 0;

  percorrerXml(xml, {
    abrir(nome, a) {
      const local = nomeLocal(nome);
      if (local === 'row') {
        linha = [];
        proximaColuna = 0;
        const declarado = Number(a.r);
        numeroLinha = Number.isInteger(declarado) && declarado > numeroLinha ? declarado : numeroLinha + 1;
      } else if (local === 'mergeCell') {
        const m = lerMesclagem(a.ref);
        if (m !== undefined) mesclagens.push(m);
      } else if (local === 'c' && linha !== undefined) {
        const coluna = indiceColuna(a.r) ?? proximaColuna;
        proximaColuna = coluna + 1;
        celula = { coluna, tipo: a.t ?? 'n', v: [], inline: [] };
      } else if (local === 'f') {
        emFormula++;
      } else if (local === 'rPh') {
        emFonetica++;
      } else if (local === 'v' && celula !== undefined) {
        dentro = 'v';
      } else if (local === 't' && celula !== undefined) {
        dentro = 't';
      }
    },
    texto(t) {
      // invariant: o texto de <f> (fórmula) nunca é lido; vale só o último valor calculado gravado em <v>.
      if (celula === undefined || emFormula > 0 || emFonetica > 0) return;
      if (dentro === 'v') celula.v.push(t);
      else if (dentro === 't') celula.inline.push(t);
    },
    fechar(nome) {
      const local = nomeLocal(nome);
      if (local === 'f') emFormula--;
      else if (local === 'rPh') emFonetica--;
      else if (local === 'v' || local === 't') dentro = undefined;
      else if (local === 'c' && celula !== undefined && linha !== undefined) {
        const bruto = celula.v.join('');
        let valor: string;
        if (celula.tipo === 's') valor = compartilhados[Number(bruto)] ?? '';
        else if (celula.tipo === 'inlineStr') valor = celula.inline.join('');
        else valor = bruto;
        if (celula.coluna < maxColunas) linha[celula.coluna] = valor.trim();
        celula = undefined;
      } else if (local === 'row' && linha !== undefined) {
        if (linha.length > 0) {
          if (porNumero.size >= maxLinhas) throw new ErroParser(`planilha com mais de ${maxLinhas} linhas`);
          porNumero.set(numeroLinha, linha);
        }
        linha = undefined;
      }
    },
  });
  aplicarMesclagens(porNumero, mesclagens, maxColunas);
  const linhas: string[][] = [];
  for (const numero of [...porNumero.keys()].sort((a, b) => a - b)) {
    const esparsa: (string | undefined)[] = porNumero.get(numero) ?? [];
    const preenchida = Array.from(esparsa, (v) => v ?? '');
    while (preenchida.length > 0 && preenchida.at(-1) === '') preenchida.pop();
    if (preenchida.length > 0) linhas.push(preenchida);
  }
  return linhas;
}

/**
 * Valores de um XLSX, planilha a planilha.
 *
 * hazard: só valores são lidos; fórmulas não são avaliadas, macros (`vbaProject.bin`), vínculos
 * externos e desenhos são ignorados (SEGURANCA.md §8).
 */
export function lerXlsx(corpo: Buffer, opcoes: OpcoesXlsx = {}): Planilha[] {
  const entradas = lerZip(corpo);
  const compartilhados = lerTextosCompartilhados(arquivo(entradas, 'xl/sharedStrings.xml'));
  return lerFolhas(entradas).map((folha) => {
    const xml = arquivo(entradas, folha.caminho);
    if (xml === undefined) throw new ErroParser(`XLSX sem a planilha ${folha.caminho}`);
    return { nome: folha.nome, linhas: lerFolha(xml, compartilhados, opcoes.maxLinhas ?? 200_000, opcoes.maxColunas ?? 200) };
  });
}
