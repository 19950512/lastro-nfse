import { ErroParser } from './erro.ts';
import type { EntradaZip } from './zip.ts';

/** Cabeçalho do pacote "Alíquotas de ISSQN" do Portal NFS-e (um CSV por UF), conferido em 17/11/2026. */
export const CABECALHO_ALIQUOTAS_ISS = 'codigo_ibge;uf;nome_municipio;codigo_servico;incidencia;aliquota;dt_ini;dt_fim';

/** UF pelo prefixo de 2 dígitos do código IBGE do município. */
export const UF_POR_CODIGO_IBGE: Readonly<Record<string, string>> = {
  '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
  '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA',
  '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP',
  '41': 'PR', '42': 'SC', '43': 'RS',
  '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
};
const UFS = new Set(Object.values(UF_POR_CODIGO_IBGE));

export interface MunicipioIss {
  readonly codigoIbge: string;
  readonly uf: string;
  readonly nome: string;
}

/** Uma linha do CSV oficial, com os valores exatamente como publicados. */
export interface LinhaAliquotaIss {
  readonly codigoIbge: string;
  readonly codigoServico: string;
  readonly incidencia: string;
  /** Texto publicado (vírgula decimal, ex.: "2,5"); null quando a célula está vazia. */
  readonly aliquota: string | null;
  /** AAAA-MM-DD. */
  readonly inicio: string;
  readonly fim: string | null;
  /** Arquivo dentro do ZIP (ex.: "SP.csv"). */
  readonly arquivo: string;
  /** Número da linha no arquivo (1 = cabeçalho). */
  readonly linha: number;
}

export interface ArquivoAliquotas {
  readonly nome: string;
  readonly linhas: number;
  readonly recusadas: number;
}

export interface TabelaAliquotasIss {
  /** Data de extração declarada no nome do pacote (AAAA-MM-DD), quando houver. */
  readonly dataReferencia: string | null;
  readonly municipios: readonly MunicipioIss[];
  readonly arquivos: readonly ArquivoAliquotas[];
  readonly total: number;
  readonly recusadas: number;
  /** Linhas em lotes, sem materializar a tabela inteira como objetos. */
  lotes(tamanho: number): Iterable<LinhaAliquotaIss[]>;
}

const ARQUIVO_UF = /^([A-Z]{2})\.csv$/;
const CODIGO_SERVICO = /^\d{2}\.\d{2}\.\d{2}\.\d{3}$/;
const ALIQUOTA = /^\d{1,3}(?:,\d{1,4})?$/;
const DATA_HORA = /^(\d{4})-(\d{2})-(\d{2})T00:00:00$/;
const DATA_NO_NOME = /aliquotas-municipios-(\d{4})(\d{2})(\d{2})/;
const MAX_NOME = 120;
// why: tolera poucas linhas defeituosas num arquivo oficial de quase 2 milhões de linhas, mas uma mudança de
// formato (muitas linhas fora do padrão) derruba a extração inteira em vez de indexar meia tabela.
const MAX_RECUSADAS_FRACAO = 0.001;
const MAX_RECUSADAS_ABSOLUTO = 50;
const MAX_DICIONARIO = 0xffff;

/** Pacote de alíquotas: só CSV por UF interessam; o TXT consolidado repete as mesmas linhas. */
export function ehArquivoDeAliquotas(nome: string): boolean {
  const m = ARQUIVO_UF.exec(nome);
  return m !== null && UFS.has(m[1] ?? '');
}

function dataValida(ano: string, mes: string, dia: string): string | null {
  const iso = `${ano}-${mes}-${dia}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

function dataDoCampo(campo: string): string | null {
  const m = DATA_HORA.exec(campo);
  return m === null ? null : dataValida(m[1] ?? '', m[2] ?? '', m[3] ?? '');
}

export function dataReferenciaAliquotas(nomes: readonly string[]): string | null {
  for (const nome of nomes) {
    const m = DATA_NO_NOME.exec(nome);
    if (m !== null) {
      const data = dataValida(m[1] ?? '', m[2] ?? '', m[3] ?? '');
      if (data !== null) return data;
    }
  }
  return null;
}

function semControle(s: string): boolean {
  for (const c of s) {
    const cp = c.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return false;
  }
  return true;
}

/**
 * A linha exatamente como está no CSV oficial; é o texto citado nas respostas.
 *
 * invariant: para toda linha aceita pelo parser, `linhaPublicada` devolve byte a byte a linha do arquivo
 * (o parser confere isso antes de aceitar).
 */
export function linhaPublicada(l: LinhaAliquotaIss, municipio: MunicipioIss): string {
  const data = (d: string | null): string => (d === null ? '' : `${d}T00:00:00`);
  return [l.codigoIbge, municipio.uf, municipio.nome, l.codigoServico, l.incidencia, l.aliquota ?? '', data(l.inicio), data(l.fim)].join(';');
}

class Dicionario {
  private readonly indice = new Map<string, number>();
  readonly valores: string[] = [];

  id(valor: string): number {
    const existente = this.indice.get(valor);
    if (existente !== undefined) return existente;
    if (this.valores.length >= MAX_DICIONARIO) throw new ErroParser('alíquotas de ISSQN: valores distintos demais numa coluna');
    this.indice.set(valor, this.valores.length);
    this.valores.push(valor);
    return this.valores.length - 1;
  }
}

function decodificar(entrada: EntradaZip): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(entrada.conteudo);
  } catch {
    throw new ErroParser(`alíquotas de ISSQN: ${entrada.nome} não é UTF-8 válido`);
  }
}

/**
 * Lê o pacote oficial de alíquotas de ISSQN (um CSV por UF).
 *
 * hazard: arquivo externo de ~1,9 milhão de linhas. Cada campo é validado (código IBGE coerente com a UF do
 * arquivo, código de serviço, alíquota entre 0 e 100, datas reais); o que não passa é recusado e contado.
 * Cabeçalho diferente ou recusa acima do limite derrubam a extração (falha fechada). As linhas ficam em
 * colunas com dicionário (cerca de 15 bytes por linha), não em 1,9 milhão de objetos.
 */
export function lerAliquotasIss(entradas: readonly EntradaZip[], nomesDoPacote: readonly string[] = []): TabelaAliquotasIss {
  const csvs = entradas.filter((e) => ehArquivoDeAliquotas(e.nome)).sort((a, b) => a.nome.localeCompare(b.nome));
  if (csvs.length === 0) throw new ErroParser('alíquotas de ISSQN: pacote sem CSV por UF');

  const textos = csvs.map((e) => ({ nome: e.nome, texto: decodificar(e) }));
  let capacidade = textos.length;
  for (const t of textos) for (let i = t.texto.indexOf('\n'); i !== -1; i = t.texto.indexOf('\n', i + 1)) capacidade++;

  const municipio = new Uint16Array(capacidade);
  const servico = new Uint16Array(capacidade);
  const incidencia = new Uint16Array(capacidade);
  const aliquota = new Uint16Array(capacidade);
  const inicio = new Uint16Array(capacidade);
  const fim = new Uint16Array(capacidade);
  const arquivo = new Uint8Array(capacidade);
  const numeroLinha = new Uint32Array(capacidade);
  const dMunicipio = new Dicionario();
  const dCodigo = new Dicionario();
  const dAliquota = new Dicionario();
  const dData = new Dicionario();
  const dadosMunicipio: MunicipioIss[] = [];
  const NULO = dAliquota.id('');
  const SEM_DATA = dData.id('');

  let total = 0;
  let recusadasTotal = 0;
  const arquivos: ArquivoAliquotas[] = [];

  for (const [indiceArquivo, { nome, texto }] of textos.entries()) {
    const ufArquivo = ARQUIVO_UF.exec(nome)?.[1] ?? '';
    const linhas = texto.replace(/^\u{FEFF}/u, '').split(/\r?\n/);
    if (linhas[0] !== CABECALHO_ALIQUOTAS_ISS) throw new ErroParser(`alíquotas de ISSQN: cabeçalho inesperado em ${nome}`);
    if (linhas.at(-1) === '') linhas.pop();
    let aceitas = 0;
    let recusadas = 0;

    for (let n = 1; n < linhas.length; n++) {
      const bruta = linhas[n] ?? '';
      const c = bruta.split(';');
      const [ibge = '', uf = '', nomeMun = '', codigo = '', inc = '', aliq = '', ini = '', fimTexto = ''] = c;
      const dataIni = dataDoCampo(ini);
      const dataFim = fimTexto === '' ? null : dataDoCampo(fimTexto);
      const valida =
        c.length === 8 &&
        /^\d{7}$/.test(ibge) &&
        uf === ufArquivo &&
        UF_POR_CODIGO_IBGE[ibge.slice(0, 2)] === uf &&
        nomeMun.length > 0 &&
        nomeMun.length <= MAX_NOME &&
        nomeMun.trim() === nomeMun &&
        semControle(nomeMun) &&
        CODIGO_SERVICO.test(codigo) &&
        CODIGO_SERVICO.test(inc) &&
        (aliq === '' || (ALIQUOTA.test(aliq) && Number(aliq.replace(',', '.')) <= 100)) &&
        dataIni !== null &&
        (fimTexto === '' || dataFim !== null);
      if (!valida) {
        recusadas++;
        continue;
      }

      const idMunicipio = dMunicipio.id(ibge);
      if (idMunicipio === dadosMunicipio.length) dadosMunicipio.push({ codigoIbge: ibge, uf, nome: nomeMun });
      const mun = dadosMunicipio[idMunicipio];
      const linha: LinhaAliquotaIss = {
        codigoIbge: ibge,
        codigoServico: codigo,
        incidencia: inc,
        aliquota: aliq === '' ? null : aliq,
        inicio: dataIni,
        fim: dataFim,
        arquivo: nome,
        linha: n + 1,
      };
      // invariant: um código IBGE tem um só nome no pacote, e a linha reconstruída é a publicada; divergência é
      // linha inconsistente (recusada), nunca um segundo município nem um texto citado diferente do original.
      if (mun === undefined || mun.nome !== nomeMun || linhaPublicada(linha, mun) !== bruta) {
        recusadas++;
        continue;
      }

      municipio[total] = idMunicipio;
      servico[total] = dCodigo.id(codigo);
      incidencia[total] = dCodigo.id(inc);
      aliquota[total] = aliq === '' ? NULO : dAliquota.id(aliq);
      inicio[total] = dData.id(dataIni);
      fim[total] = dataFim === null ? SEM_DATA : dData.id(dataFim);
      arquivo[total] = indiceArquivo;
      numeroLinha[total] = n + 1;
      total++;
      aceitas++;
    }
    arquivos.push({ nome, linhas: aceitas, recusadas });
    recusadasTotal += recusadas;
  }

  if (total === 0) throw new ErroParser('alíquotas de ISSQN: nenhuma linha válida');
  if (recusadasTotal > Math.max(MAX_RECUSADAS_ABSOLUTO, total * MAX_RECUSADAS_FRACAO)) {
    throw new ErroParser(`alíquotas de ISSQN: ${recusadasTotal} linhas fora do formato (possível mudança de leiaute)`);
  }

  const nomesArquivos = textos.map((t) => t.nome);
  function* gerarLotes(tamanho: number): Iterable<LinhaAliquotaIss[]> {
    for (let i = 0; i < total; i += tamanho) {
      const lote: LinhaAliquotaIss[] = [];
      for (let j = i; j < Math.min(total, i + tamanho); j++) {
        const valorAliquota = aliquota[j] ?? NULO;
        const valorFim = fim[j] ?? SEM_DATA;
        lote.push({
          codigoIbge: dMunicipio.valores[municipio[j] ?? 0] ?? '',
          codigoServico: dCodigo.valores[servico[j] ?? 0] ?? '',
          incidencia: dCodigo.valores[incidencia[j] ?? 0] ?? '',
          aliquota: valorAliquota === NULO ? null : (dAliquota.valores[valorAliquota] ?? null),
          inicio: dData.valores[inicio[j] ?? 0] ?? '',
          fim: valorFim === SEM_DATA ? null : (dData.valores[valorFim] ?? null),
          arquivo: nomesArquivos[arquivo[j] ?? 0] ?? '',
          linha: numeroLinha[j] ?? 0,
        });
      }
      yield lote;
    }
  }

  return {
    dataReferencia: dataReferenciaAliquotas([...nomesDoPacote, ...entradas.map((e) => e.nome)]),
    municipios: dadosMunicipio,
    arquivos,
    total,
    recusadas: recusadasTotal,
    lotes: gerarLotes,
  };
}
