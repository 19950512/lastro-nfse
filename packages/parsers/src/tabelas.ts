import type { Planilha } from './xlsx.ts';

export interface LinhaReferencia {
  readonly ordem: number;
  readonly dados: Readonly<Record<string, string>>;
  readonly codigos: readonly string[];
}

export interface TabelaReferencia {
  readonly slug: string;
  readonly titulo: string;
  readonly planilha: string;
  readonly colunas: readonly string[];
  readonly linhas: readonly LinhaReferencia[];
}

export function semAcento(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

export function slugificar(s: string, maximo = 120): string {
  const slug = semAcento(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maximo).replace(/-+$/, '');
}

/** Forma canônica de um código para busca exata: sem espaços nas pontas e no meio, em maiúsculas. */
export function normalizarCodigo(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, '');
}

const colapsar = (s: string): string => s.replace(/\s+/g, ' ').trim();

interface AnexoConhecido {
  readonly padrao: RegExp;
  readonly slug: string;
  readonly titulo: string;
}

// invariant: a ordem importa; o nome do anexo VIII contém "nbs" e "indop", então ele é testado
// primeiro. Os padrões são aplicados ao nome do arquivo reduzido a letras e dígitos ("anexoviileiautes…").
const ANEXOS: readonly AnexoConhecido[] = [
  { padrao: /correlacao/, slug: 'correlacao-item-nbs-indop-cclasstrib', titulo: 'Correlação item LC 116 × NBS × indOp × cClassTrib (Anexo VIII)' },
  { padrao: /indop/, slug: 'indop-ibscbs', titulo: 'Códigos indOp – IBS/CBS' },
  { padrao: /^anexovi(?!i)/, slug: 'anexo-vi-leiaute-rtc', titulo: 'Leiaute e regras de negócio RTC – IBS/CBS (Anexo VI)' },
  { padrao: /^anexoa(?=municipio)/, slug: 'municipios-paises', titulo: 'Municípios IBGE e países ISO2 (Anexo A)' },
  { padrao: /^anexob(?=nbs|lista)/, slug: 'nbs-lista-servicos', titulo: 'Lista de serviços nacional e NBS (Anexo B)' },
];

// why: o slug identifica a tabela entre versões do mesmo anexo; versão e data do nome do arquivo
// (ex.: "-v1-01-20260209") mudariam o slug a cada nova publicação.
function baseEstavel(arquivo: string): string {
  const semExtensao = arquivo.replace(/\.[a-z0-9]{1,5}$/i, '');
  const versao = semExtensao.search(/[-_]v\d/i);
  return (versao === -1 ? semExtensao : semExtensao.slice(0, versao)).replace(/[-_]\d{8}$/, '');
}

function nomeArquivo(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
  } catch {
    return url.split('/').at(-1) ?? '';
  }
}

function identificarAnexo(url: string): { slug: string; titulo: string } {
  const arquivo = nomeArquivo(url);
  const compacto = semAcento(arquivo).toLowerCase().replace(/[^a-z0-9]/g, '');
  const conhecido = ANEXOS.find((a) => a.padrao.test(compacto));
  if (conhecido !== undefined) return { slug: conhecido.slug, titulo: conhecido.titulo };
  const base = baseEstavel(arquivo);
  return { slug: slugificar(base, 80) || 'tabela', titulo: base || 'Tabela' };
}

const NUMERICO = /^-?[\d.,\s/%-]+$/;

function pontuacaoCabecalho(linha: readonly string[]): number {
  return linha.filter((c) => c !== '' && c !== '-' && !NUMERICO.test(c) && c.length <= 120).length;
}

// why: os anexos oficiais têm linhas de título acima do cabeçalho; o cabeçalho é a primeira linha
// (entre as 12 primeiras) com quase tantas células de texto quanto a mais "rotulada" delas.
function localizarCabecalho(linhas: readonly (readonly string[])[]): number | undefined {
  const candidatas = linhas.slice(0, 12).map(pontuacaoCabecalho);
  const maior = Math.max(0, ...candidatas);
  if (maior < 2) return undefined;
  const indice = candidatas.findIndex((p) => p >= Math.max(2, Math.ceil(maior * 0.8)));
  return indice === -1 ? undefined : indice;
}

function nomesColunas(cabecalho: readonly string[], largura: number): string[] {
  const usados = new Map<string, number>();
  const nomes: string[] = [];
  for (let i = 0; i < largura; i++) {
    let nome = colapsar(cabecalho[i] ?? '').slice(0, 120);
    if (nome === '' || nome === '-' || nome === '__' || nome === '#') nome = `coluna_${i + 1}`;
    const vezes = (usados.get(nome) ?? 0) + 1;
    usados.set(nome, vezes);
    nomes.push(vezes === 1 ? nome : `${nome}_${vezes}`);
  }
  return nomes;
}

const COLUNA_DE_CODIGO = /cclasstrib|\bnbs\b|indop|\bcst\b|\bcod|codigo|\bitem\b|subitem|ibge|\biso|\bcampo\b|\berro\b|\bsigla\b|\bcfop\b|\bncm\b/;
const COLUNA_DESCRITIVA = /descri|\bnome\b|observ|nota|mensagem|\bmsg\b|regra|local/;

function ehColunaDeCodigo(nome: string): boolean {
  const n = semAcento(nome).toLowerCase();
  return COLUNA_DE_CODIGO.test(n) && !COLUNA_DESCRITIVA.test(n);
}

function pareceCodigo(valor: string): boolean {
  if (valor === '' || valor === '-' || valor.length > 40) return false;
  return !/\s/.test(valor) || /\d/.test(valor);
}

function codigosDe(valor: string): string[] {
  const normal = normalizarCodigo(valor);
  const alfanumerico = semAcento(normal).replace(/[^A-Z0-9]/g, '');
  return alfanumerico === '' || alfanumerico === normal ? [normal] : [normal, alfanumerico];
}

/** Tabelas estruturadas (linha = registro) a partir das planilhas de um anexo oficial. */
export function tabelasDeXlsx(planilhas: readonly Planilha[], url: string): TabelaReferencia[] {
  const anexo = identificarAnexo(url);
  const uteis = planilhas
    .map((p) => ({ planilha: p, cabecalho: localizarCabecalho(p.linhas) }))
    .filter((u): u is { planilha: Planilha; cabecalho: number } => u.cabecalho !== undefined && u.planilha.linhas.length > u.cabecalho + 1);

  const slugs = new Set<string>();
  return uteis.map(({ planilha, cabecalho }) => {
    const dadosBrutos = planilha.linhas.slice(cabecalho + 1);
    const largura = Math.max(planilha.linhas[cabecalho]?.length ?? 0, ...dadosBrutos.map((l) => l.length));
    const colunas = nomesColunas(planilha.linhas[cabecalho] ?? [], largura);
    const colunasCodigo = colunas.map((c, i) => (ehColunaDeCodigo(c) ? i : -1)).filter((i) => i !== -1);

    const linhas: LinhaReferencia[] = dadosBrutos.map((bruta, ordem) => {
      const dados: Record<string, string> = {};
      bruta.forEach((valor, i) => {
        const coluna = colunas[i];
        const limpo = colapsar(valor);
        if (coluna !== undefined && limpo !== '') dados[coluna] = limpo;
      });
      const codigos = new Set<string>();
      for (const i of colunasCodigo) {
        const valor = colapsar(bruta[i] ?? '');
        if (pareceCodigo(valor)) for (const c of codigosDe(valor)) codigos.add(c);
      }
      return { ordem: ordem + 1, dados, codigos: [...codigos] };
    });

    let slug = uteis.length > 1 ? `${anexo.slug}-${slugificar(planilha.nome, 40)}`.slice(0, 120).replace(/-+$/, '') : anexo.slug;
    for (let n = 2; slugs.has(slug); n++) slug = `${slug.slice(0, 115)}-${n}`;
    slugs.add(slug);

    const titulos = planilha.linhas.slice(0, cabecalho).map((l) => colapsar(l.filter((c) => c !== '').join(' '))).filter((t) => t !== '');
    const titulo = [anexo.titulo, planilha.nome, ...titulos.slice(0, 1)].map(colapsar).join(' – ').slice(0, 300);
    return { slug, titulo, planilha: planilha.nome, colunas, linhas };
  });
}
