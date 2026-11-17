import { blocosDeHtml, decodificarHtml } from './html.ts';
import { extrairPaginasPdf } from './pdf.ts';
import { tabelasDeXlsx, type TabelaReferencia } from './tabelas.ts';
import { trechosDeHtml, trechosDePdf, type Trecho } from './trechos.ts';
import { lerXlsx } from './xlsx.ts';
import { camposDeXsd, type CampoLeiaute } from './xsd.ts';
import { lerZip } from './zip.ts';

export type Extracao =
  | { readonly tipo: 'texto'; readonly trechos: readonly Trecho[] }
  | { readonly tipo: 'tabelas'; readonly tabelas: readonly TabelaReferencia[]; readonly trechos: readonly Trecho[] }
  | { readonly tipo: 'leiaute'; readonly campos: readonly CampoLeiaute[]; readonly trechos: readonly Trecho[] }
  | { readonly tipo: 'ignorado'; readonly motivo: string };

const MIMES_HTML = new Set(['text/html', 'application/xhtml+xml']);
const MIMES_XLSX = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const MIMES_ZIP = new Set(['application/zip', 'application/x-zip-compressed']);
const MAX_CARACTERES = 1800;

function numerar(textos: readonly { texto: string; secao: string | null }[]): Trecho[] {
  return textos.map((t, ordem) => ({ ordem, texto: t.texto, paginaIni: null, paginaFim: null, secao: t.secao }));
}

function trechosDeTabelas(tabelas: readonly TabelaReferencia[]): Trecho[] {
  return numerar(
    tabelas.map((t) => ({
      texto: `${t.titulo}. Planilha "${t.planilha}", ${t.linhas.length} linhas. Colunas: ${t.colunas.join('; ')}.`.slice(0, MAX_CARACTERES),
      secao: t.slug,
    })),
  );
}

function trechosDeCampos(campos: readonly CampoLeiaute[]): Trecho[] {
  const porArquivo = new Map<string, string[]>();
  for (const c of campos) {
    const linha = `${c.caminho} (${c.tipo ?? 'grupo'}, ocorrência ${c.minOcorrencias}-${c.maxOcorrencias})${c.descricao === null ? '' : `: ${c.descricao}`}`;
    porArquivo.set(c.arquivo, [...(porArquivo.get(c.arquivo) ?? []), linha]);
  }
  const textos: { texto: string; secao: string }[] = [];
  for (const [arquivo, linhas] of porArquivo) {
    let atual = '';
    for (const linha of linhas.map((l) => l.slice(0, MAX_CARACTERES))) {
      if (atual !== '' && atual.length + 1 + linha.length > MAX_CARACTERES) {
        textos.push({ texto: atual, secao: arquivo });
        atual = linha;
      } else {
        atual = atual === '' ? linha : `${atual}\n${linha}`;
      }
    }
    if (atual !== '') textos.push({ texto: atual, secao: arquivo });
  }
  return numerar(textos);
}

/**
 * Extrai o conteúdo estruturado de um snapshot arquivado, conforme o tipo (ARQUITETURA.md §2.2).
 *
 * hazard: os bytes vêm de site externo; todo parser aplica limites próprios e lança ErroParser em
 * entrada malformada ou acima dos limites (falha fechada: o documento não entra no índice).
 */
export async function extrairDocumento(corpo: Buffer, mime: string, url: string): Promise<Extracao> {
  const tipo = (mime.split(';')[0] ?? '').trim().toLowerCase();
  if (MIMES_HTML.has(tipo)) {
    const trechos = trechosDeHtml(blocosDeHtml(decodificarHtml(corpo, mime)), { maxCaracteres: MAX_CARACTERES });
    return trechos.length === 0 ? { tipo: 'ignorado', motivo: 'HTML sem texto (página dinâmica ou vazia)' } : { tipo: 'texto', trechos };
  }
  if (tipo === 'application/pdf') {
    const trechos = trechosDePdf(await extrairPaginasPdf(corpo), { maxCaracteres: MAX_CARACTERES });
    // why: PDF digitalizado (só imagem) não tem camada de texto; sem OCR, não há o que citar.
    return trechos.length === 0 ? { tipo: 'ignorado', motivo: 'PDF sem camada de texto (provável digitalização; OCR não implementado)' } : { tipo: 'texto', trechos };
  }
  if (MIMES_XLSX.has(tipo)) {
    const tabelas = tabelasDeXlsx(lerXlsx(corpo), url);
    return { tipo: 'tabelas', tabelas, trechos: trechosDeTabelas(tabelas) };
  }
  if (MIMES_ZIP.has(tipo)) {
    const xsds = lerZip(corpo)
      .filter((e) => e.nome.toLowerCase().endsWith('.xsd'))
      .map((e) => ({ nome: e.nome, conteudo: new TextDecoder('utf-8').decode(e.conteudo) }));
    if (xsds.length === 0) return { tipo: 'ignorado', motivo: 'ZIP sem arquivos XSD' };
    const campos = camposDeXsd(xsds);
    return { tipo: 'leiaute', campos, trechos: trechosDeCampos(campos) };
  }
  return { tipo: 'ignorado', motivo: `tipo sem extrator: ${tipo || '(vazio)'}` };
}
