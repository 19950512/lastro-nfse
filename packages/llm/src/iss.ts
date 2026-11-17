import { fontesMunicipais, prefixoCodigoServico, UFS, type Fonte } from '@lastro/core';
import type { AliquotaEncontrada, TabelaAliquotasVigente } from '@lastro/db';
import { dataBrasil, dataIsoBrasil } from './checagem.ts';
import { AVISO_PADRAO, LIMITES_PADRAO } from './prompt.ts';
import { sem, type Rota } from './roteador.ts';
import type { FonteCitada, RespostaPergunta } from './tipos.ts';

export const FONTE_ALIQUOTAS_ISS = 'nfse-aliquotas-iss';
export const FONTE_LEGISLACAO_FEDERAL = 'planalto-legislacao';

/** Município que a plataforma conhece: pela tabela oficial de alíquotas e/ou por fonte de legislação municipal. */
export interface MunicipioConhecido {
  readonly codigoIbge: string;
  readonly nome: string;
  readonly uf: string;
  readonly naTabela: boolean;
  /** Fonte de legislação municipal coletada (Fase 5); null se o município ainda não é coberto. */
  readonly fonteLegislacao: string | null;
}

export type Identificacao =
  | { readonly tipo: 'nenhum' }
  | { readonly tipo: 'unico'; readonly municipio: MunicipioConhecido }
  | { readonly tipo: 'ambiguo'; readonly candidatos: readonly MunicipioConhecido[] };

const MAX_CANDIDATOS = 8;
const MAX_CODIGOS_LISTADOS = 15;
export const MAX_LINHAS_ALIQUOTA = 5000;

const palavras = (s: string): string => ` ${sem(s).replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Junta os municípios da tabela oficial com os do catálogo de fontes municipais (que podem não estar na tabela). */
export function municipiosConhecidos(daTabela: readonly { codigoIbge: string; nome: string; uf: string }[], fontes: readonly Fonte[]): MunicipioConhecido[] {
  const legislacao = new Map(fontesMunicipais(fontes).flatMap((f) => (f.municipio === undefined ? [] : [[f.municipio.codigoIbge, f] as const])));
  const porCodigo = new Map<string, MunicipioConhecido>();
  for (const m of daTabela) porCodigo.set(m.codigoIbge, { ...m, naTabela: true, fonteLegislacao: legislacao.get(m.codigoIbge)?.id ?? null });
  for (const [codigo, f] of legislacao) {
    if (!porCodigo.has(codigo) && f.municipio !== undefined) porCodigo.set(codigo, { ...f.municipio, naTabela: false, fonteLegislacao: f.id });
  }
  return [...porCodigo.values()];
}

/**
 * Município citado na pergunta, por código IBGE ou pelo nome (palavras inteiras, sem acento), com a UF quando
 * escrita em maiúsculas ("Campinas/SP", "Bom Jesus - PI").
 *
 * invariant: na dúvida não escolhe. Nome repetido em mais de uma UF sem UF na pergunta, ou dois municípios
 * diferentes citados, devolvem `ambiguo` e a resposta pede que a pessoa diga qual.
 */
export function identificarMunicipio(pergunta: string, municipios: readonly MunicipioConhecido[]): Identificacao {
  const porCodigo = new Map(municipios.map((m) => [m.codigoIbge, m]));
  const codigos = [...new Set([...pergunta.matchAll(/\b\d{7}\b/g)].map((m) => m[0]))].flatMap((c) => porCodigo.get(c) ?? []);
  if (codigos.length === 1 && codigos[0] !== undefined) return { tipo: 'unico', municipio: codigos[0] };
  if (codigos.length > 1) return { tipo: 'ambiguo', candidatos: codigos.slice(0, MAX_CANDIDATOS) };

  const texto = palavras(pergunta);
  let achados = municipios.filter((m) => texto.includes(palavras(m.nome)));
  // why: "Bom Jesus da Lapa" contém "Bom Jesus"; fica só o nome mais longo encontrado.
  achados = achados.filter((a) => !achados.some((b) => b !== a && b.nome.length > a.nome.length && palavras(b.nome).includes(palavras(a.nome))));
  if (achados.length === 0) return { tipo: 'nenhum' };

  const ufsCitadas = new Set([...pergunta.normalize('NFD').matchAll(/\b[A-Z]{2}\b/g)].map((m) => m[0]).filter((u) => (UFS as readonly string[]).includes(u)));
  const naUf = ufsCitadas.size === 0 ? achados : achados.filter((m) => ufsCitadas.has(m.uf));
  const candidatos = naUf.length === 0 ? achados : naUf;
  if (candidatos.length === 1 && candidatos[0] !== undefined) return { tipo: 'unico', municipio: candidatos[0] };
  return { tipo: 'ambiguo', candidatos: candidatos.slice(0, MAX_CANDIDATOS) };
}

/** Prefixos de código de serviço citados na pergunta ("1.05", "010501", "01.05.01.000"). */
export function servicosCitados(pergunta: string): string[] {
  const prefixos = [...pergunta.matchAll(/\b\d[\d.]{0,11}\d\b/g)].flatMap((m) => prefixoCodigoServico(m[0]) ?? []);
  return [...new Set(prefixos)].slice(0, 5);
}

/** Data explícita na pergunta (dd/mm/aaaa) como AAAA-MM-DD; null se não houver. */
export function dataCitada(pergunta: string): string | null {
  const m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(pergunta);
  if (m === null) return null;
  const iso = `${m[3] ?? ''}-${(m[2] ?? '').padStart(2, '0')}-${(m[1] ?? '').padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/**
 * Registro vale na data: começou até ela e não terminou antes. Registro com fim anterior ao início (cancelado no
 * cadastro do município, como aparece no pacote oficial) não vale em data nenhuma.
 */
export function vigenteEm(l: Pick<AliquotaEncontrada, 'inicio' | 'fim'>, data: string): boolean {
  if (l.fim !== null && l.fim < l.inicio) return false;
  return l.inicio <= data && (l.fim === null || l.fim >= data);
}

const dataBr = (iso: string): string => iso.split('-').reverse().join('/');
const nomeMunicipio = (m: MunicipioConhecido): string => `${m.nome}/${m.uf} (código IBGE ${m.codigoIbge})`;
const percentual = (a: string | null): string => (a === null ? 'sem alíquota informada' : `${a}%`);

export function textoCandidatos(candidatos: readonly MunicipioConhecido[]): string {
  return candidatos.map(nomeMunicipio).join('; ');
}

export interface EntradaRespostaAliquotas {
  readonly municipio: MunicipioConhecido;
  readonly tabela: TabelaAliquotasVigente;
  readonly linhas: readonly AliquotaEncontrada[];
  /** null: a pergunta não citou código de serviço. */
  readonly prefixos: readonly string[] | null;
  readonly data: string;
  readonly agora: Date;
  readonly fontes: readonly Fonte[];
  readonly rota: Rota;
}

/**
 * Resposta de alíquota montada em código, sem modelo: cada número sai de uma linha do CSV oficial, citada
 * literalmente (arquivo, linha, URL e hash do pacote arquivado).
 *
 * invariant: nada é calculado nem escolhido. Dois registros vigentes com alíquotas diferentes para o mesmo código
 * aparecem os dois, com aviso de divergência, e a plataforma não decide qual vale.
 */
export function respostaAliquotas(e: EntradaRespostaAliquotas): RespostaPergunta {
  const fonte = e.fontes.find((f) => f.id === e.tabela.fonteId);
  const citadas: FonteCitada[] = [];
  const numero = new Map<string, number>();
  const citar = (l: AliquotaEncontrada): string => {
    const chave = `${l.arquivo}:${l.linha}`;
    let n = numero.get(chave);
    if (n === undefined) {
      n = citadas.length + 1;
      numero.set(chave, n);
      citadas.push({
        id: n,
        titulo: `Alíquotas de ISSQN cadastradas no ambiente nacional da NFS-e — ${l.arquivo}, linha ${l.linha}`,
        orgao: fonte?.orgao ?? e.tabela.fonteId,
        nivel: fonte?.nivel ?? 'N2',
        url: e.tabela.url,
        secao: `${l.arquivo}, linha ${l.linha}`,
        pagina: null,
        trecho: l.textoPublicado,
        coletado_em: e.tabela.coletadoEm,
        confirmado_em: e.tabela.confirmadoEm,
        sha256: e.tabela.sha256,
        snapshot_id: e.tabela.snapshotId,
        documento_id: e.tabela.documentoId,
        original: `/v1/snapshots/${e.tabela.snapshotId}/original`,
      });
    }
    return `[${n}]`;
  };

  const referencia = e.tabela.dataReferencia === null ? '' : ` (extração de ${dataBr(e.tabela.dataReferencia)})`;
  const abertura = `Segundo a tabela de alíquotas de ISSQN publicada no Portal NFS-e${referencia}, para ${nomeMunicipio(e.municipio)}`;
  const avisos: string[] = ['A tabela reúne o que cada município cadastrou no ambiente nacional da NFS-e; havendo divergência, vale a lei municipal.'];
  const resposta = (situacao: 'respondida' | 'sem-resposta', texto: string): RespostaPergunta => {
    if (fonte !== undefined && e.agora.getTime() - new Date(e.tabela.confirmadoEm).getTime() > fonte.slaHoras * 3_600_000) {
      avisos.push(`Tabela verificada pela última vez em ${dataBrasil(new Date(e.tabela.confirmadoEm))}.`);
    }
    return {
      situacao,
      rota: e.rota,
      resposta: texto,
      posicao_em: dataIsoBrasil(e.agora),
      fontes: situacao === 'respondida' ? citadas : [],
      avisos,
      limites: [...LIMITES_PADRAO],
      aviso: AVISO_PADRAO,
      checagem: { citacoes_invalidas: 0, frases_sem_citacao_removidas: 0, conteudo_removido: 0 },
    };
  };

  if (e.linhas.length === 0) {
    const codigos = e.prefixos === null ? '' : ` com código de serviço começando por ${e.prefixos.join(' ou ')}`;
    return resposta('sem-resposta', `A tabela de alíquotas de ISSQN publicada no Portal NFS-e${referencia} não traz registro para ${nomeMunicipio(e.municipio)}${codigos}.`);
  }

  if (e.prefixos === null) {
    const vigentes = e.linhas.filter((l) => vigenteEm(l, e.data));
    if (vigentes.length === 0) return resposta('sem-resposta', `${abertura}, nenhum registro está vigente em ${dataBr(e.data)}.`);
    const porAliquota = new Map<string | null, AliquotaEncontrada[]>();
    for (const l of vigentes) porAliquota.set(l.aliquota, [...(porAliquota.get(l.aliquota) ?? []), l]);
    const codigosDistintos = new Set(vigentes.map((l) => l.codigoServico)).size;
    const partes = [...porAliquota.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([aliquota, ls]) => `${percentual(aliquota)} em ${new Set(ls.map((l) => l.codigoServico)).size} código(s), por exemplo ${ls[0]?.codigoServico ?? ''} ${ls[0] === undefined ? '' : citar(ls[0])}`);
    return resposta(
      'respondida',
      `${abertura}, há ${codigosDistintos} códigos de serviço com registro vigente em ${dataBr(e.data)}: ${partes.join('; ')}. Informe o subitem da lista de serviços (ex.: 1.05) para ver a alíquota de um serviço.`,
    );
  }

  const porCodigo = new Map<string, AliquotaEncontrada[]>();
  for (const l of e.linhas) porCodigo.set(l.codigoServico, [...(porCodigo.get(l.codigoServico) ?? []), l]);
  const codigos = [...porCodigo.keys()].sort();
  const frases: string[] = [];
  let divergente = false;
  for (const codigo of codigos.slice(0, MAX_CODIGOS_LISTADOS)) {
    const registros = porCodigo.get(codigo) ?? [];
    const vigentes = registros.filter((l) => vigenteEm(l, e.data));
    if (vigentes.length === 0) {
      const validos = registros.filter((l) => l.fim === null || l.fim >= l.inicio);
      const ultimo = validos.at(-1);
      frases.push(
        ultimo === undefined
          ? `código ${codigo}: nenhum registro vigente em ${dataBr(e.data)} (só registros cancelados no cadastro)`
          : `código ${codigo}: nenhum registro vigente em ${dataBr(e.data)}; o último registro é ${percentual(ultimo.aliquota)} de ${dataBr(ultimo.inicio)}${ultimo.fim === null ? '' : ` a ${dataBr(ultimo.fim)}`} ${citar(ultimo)}`,
      );
      continue;
    }
    const distintas = new Set(vigentes.map((l) => l.aliquota));
    if (distintas.size > 1) {
      divergente = true;
      frases.push(`código ${codigo}: a tabela traz registros vigentes com alíquotas diferentes, ${vigentes.map((l) => `${percentual(l.aliquota)} ${citar(l)}`).join(' e ')}`);
      continue;
    }
    const l = vigentes.at(-1);
    if (l === undefined) continue;
    frases.push(`código ${codigo}: ${percentual(l.aliquota)}, desde ${dataBr(l.inicio)}${l.fim === null ? '' : ` até ${dataBr(l.fim)}`} ${citar(l)}`);
  }
  if (divergente) avisos.push('Há registros vigentes divergentes para o mesmo código; a plataforma não escolhe entre eles. Confirme com a prefeitura.');
  const resto = codigos.length > MAX_CODIGOS_LISTADOS ? `; e mais ${codigos.length - MAX_CODIGOS_LISTADOS} códigos (informe o código completo para ver um só)` : '';
  return resposta('respondida', `${abertura}, em ${dataBr(e.data)}: ${frases.join('; ')}${resto}.`);
}
