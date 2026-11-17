import { ErroParser } from './erro.ts';
import { analisarXml, nomeLocal, textoCompleto, type NoXml } from './xml.ts';

export interface CampoLeiaute {
  readonly nome: string;
  readonly caminho: string;
  readonly tipo: string | null;
  readonly minOcorrencias: number;
  readonly maxOcorrencias: string;
  readonly descricao: string | null;
  readonly arquivo: string;
  /** Versão do leiaute (pasta `Schemas/1.01/` ou sufixo `_v1.01` do arquivo); null se não declarada. */
  readonly versao: string | null;
}

export interface OpcoesXsd {
  readonly maxCampos?: number;
  readonly maxProfundidade?: number;
}

interface Declaracao {
  readonly no: NoXml;
  readonly arquivo: string;
}

interface Indice {
  readonly elementos: Map<string, Declaracao>;
  readonly complexos: Map<string, Declaracao>;
  readonly simples: Map<string, Declaracao>;
  readonly grupos: Map<string, Declaracao>;
  readonly gruposAtributos: Map<string, Declaracao>;
  readonly referenciados: Set<string>;
}

const colapsar = (s: string): string => s.replace(/\s+/g, ' ').trim();
const NAMESPACE_XMLDSIG = 'http://www.w3.org/2000/09/xmldsig#';

function filhos(no: NoXml, nome: string): NoXml[] {
  return no.filhos.filter((f) => nomeLocal(f.nome) === nome);
}

function documentacao(no: NoXml | undefined): string | null {
  if (no === undefined) return null;
  const textos = filhos(no, 'annotation')
    .flatMap((a) => filhos(a, 'documentation'))
    .map((d) => colapsar(textoCompleto(d)))
    .filter((t) => t !== '');
  return textos.length === 0 ? null : textos.join(' ');
}

function diretorio(nome: string): string {
  const i = nome.lastIndexOf('/');
  return i === -1 ? '' : nome.slice(0, i);
}

function versaoDe(arquivo: string): string | null {
  const daPasta = /(?:^|\/)v?(\d+\.\d+)\//.exec(arquivo)?.[1];
  if (daPasta !== undefined) return daPasta;
  return /_v(\d+\.\d+)\.xsd$/i.exec(arquivo)?.[1] ?? null;
}

function indexar(esquemas: readonly { arquivo: string; raiz: NoXml }[]): Indice {
  const indice: Indice = {
    elementos: new Map(),
    complexos: new Map(),
    simples: new Map(),
    grupos: new Map(),
    gruposAtributos: new Map(),
    referenciados: new Set(),
  };
  const registrar = (mapa: Map<string, Declaracao>, no: NoXml, arquivo: string): void => {
    const nome = no.atributos.name;
    if (nome !== undefined && !mapa.has(nome)) mapa.set(nome, { no, arquivo });
  };
  const marcarReferencias = (no: NoXml): void => {
    if (nomeLocal(no.nome) === 'element' && no.atributos.ref !== undefined) indice.referenciados.add(nomeLocal(no.atributos.ref));
    no.filhos.forEach(marcarReferencias);
  };
  for (const { arquivo, raiz } of esquemas) {
    for (const no of raiz.filhos) {
      const local = nomeLocal(no.nome);
      if (local === 'element') registrar(indice.elementos, no, arquivo);
      else if (local === 'complexType') registrar(indice.complexos, no, arquivo);
      else if (local === 'simpleType') registrar(indice.simples, no, arquivo);
      else if (local === 'group') registrar(indice.grupos, no, arquivo);
      else if (local === 'attributeGroup') registrar(indice.gruposAtributos, no, arquivo);
    }
    marcarReferencias(raiz);
  }
  return indice;
}

class Extrator {
  readonly campos: CampoLeiaute[] = [];
  private readonly indice: Indice;
  private readonly versao: string | null;
  private readonly maxCampos: number;
  private readonly maxProfundidade: number;

  constructor(indice: Indice, versao: string | null, maxCampos: number, maxProfundidade: number) {
    this.indice = indice;
    this.versao = versao;
    this.maxCampos = maxCampos;
    this.maxProfundidade = maxProfundidade;
  }

  private emitir(campo: Omit<CampoLeiaute, 'versao'>): void {
    if (this.campos.length >= this.maxCampos) throw new ErroParser(`leiaute com mais de ${this.maxCampos} campos`);
    this.campos.push({ ...campo, versao: this.versao });
  }

  elemento(no: NoXml, arquivo: string, caminhoPai: string, profundidade: number, pilhaTipos: readonly string[]): void {
    const ref = no.atributos.ref === undefined ? undefined : nomeLocal(no.atributos.ref);
    const global = ref === undefined ? undefined : this.indice.elementos.get(ref);
    const declaracao = global?.no ?? no;
    const arquivoDecl = global?.arquivo ?? arquivo;
    const nome = declaracao.atributos.name ?? ref;
    if (nome === undefined) return;
    const caminho = caminhoPai === '' ? nome : `${caminhoPai}/${nome}`;
    const nomeTipo = declaracao.atributos.type === undefined ? undefined : nomeLocal(declaracao.atributos.type);
    const anonimo = filhos(declaracao, 'complexType')[0];
    const simplesAnonimo = filhos(declaracao, 'simpleType')[0];
    const baseSimples = simplesAnonimo === undefined ? undefined : filhos(simplesAnonimo, 'restriction')[0]?.atributos.base;
    const declTipo = nomeTipo === undefined ? undefined : (this.indice.complexos.get(nomeTipo) ?? this.indice.simples.get(nomeTipo));

    this.emitir({
      nome,
      caminho,
      tipo: nomeTipo ?? (baseSimples === undefined ? null : nomeLocal(baseSimples)),
      minOcorrencias: Number(no.atributos.minOccurs ?? '1') || 0,
      maxOcorrencias: no.atributos.maxOccurs ?? '1',
      descricao: documentacao(declaracao) ?? documentacao(declTipo?.no) ?? documentacao(simplesAnonimo),
      arquivo: arquivoDecl,
    });

    // invariant: tipos recursivos e cadeias profundas param aqui; o campo é emitido, os filhos não.
    if (profundidade >= this.maxProfundidade) return;
    if (anonimo !== undefined) {
      this.complexo(anonimo, arquivoDecl, caminho, profundidade + 1, pilhaTipos);
    } else if (nomeTipo !== undefined && !pilhaTipos.includes(nomeTipo)) {
      const complexo = this.indice.complexos.get(nomeTipo);
      if (complexo !== undefined) this.complexo(complexo.no, complexo.arquivo, caminho, profundidade + 1, [...pilhaTipos, nomeTipo]);
    }
  }

  private atributo(no: NoXml, arquivo: string, caminho: string): void {
    const nome = no.atributos.name ?? (no.atributos.ref === undefined ? undefined : nomeLocal(no.atributos.ref));
    if (nome === undefined) return;
    const nomeTipo = no.atributos.type === undefined ? null : nomeLocal(no.atributos.type);
    this.emitir({
      nome,
      caminho: `${caminho}/@${nome}`,
      tipo: nomeTipo,
      minOcorrencias: no.atributos.use === 'required' ? 1 : 0,
      maxOcorrencias: '1',
      descricao: documentacao(no) ?? documentacao(nomeTipo === null ? undefined : this.indice.simples.get(nomeTipo)?.no),
      arquivo,
    });
  }

  private particula(no: NoXml, arquivo: string, caminho: string, profundidade: number, pilhaTipos: readonly string[]): void {
    for (const filho of no.filhos) {
      const local = nomeLocal(filho.nome);
      if (local === 'element') this.elemento(filho, arquivo, caminho, profundidade, pilhaTipos);
      else if (local === 'sequence' || local === 'choice' || local === 'all') this.particula(filho, arquivo, caminho, profundidade, pilhaTipos);
      else if (local === 'group' && filho.atributos.ref !== undefined) {
        const nomeGrupo = nomeLocal(filho.atributos.ref);
        const grupo = this.indice.grupos.get(nomeGrupo);
        const marca = `grupo:${nomeGrupo}`;
        if (grupo !== undefined && !pilhaTipos.includes(marca)) this.particula(grupo.no, grupo.arquivo, caminho, profundidade, [...pilhaTipos, marca]);
      }
    }
  }

  complexo(no: NoXml, arquivo: string, caminho: string, profundidade: number, pilhaTipos: readonly string[]): void {
    for (const filho of no.filhos) {
      const local = nomeLocal(filho.nome);
      if (local === 'sequence' || local === 'choice' || local === 'all' || local === 'group') {
        this.particula({ ...no, filhos: [filho] }, arquivo, caminho, profundidade, pilhaTipos);
      } else if (local === 'attribute') {
        this.atributo(filho, arquivo, caminho);
      } else if (local === 'attributeGroup' && filho.atributos.ref !== undefined) {
        const nomeGrupo = nomeLocal(filho.atributos.ref);
        const grupo = this.indice.gruposAtributos.get(nomeGrupo);
        const marca = `atributos:${nomeGrupo}`;
        if (grupo !== undefined && !pilhaTipos.includes(marca)) this.complexo(grupo.no, grupo.arquivo, caminho, profundidade, [...pilhaTipos, marca]);
      } else if (local === 'complexContent' || local === 'simpleContent') {
        for (const derivacao of filho.filhos) {
          const tipoDerivacao = nomeLocal(derivacao.nome);
          if (tipoDerivacao !== 'extension' && tipoDerivacao !== 'restriction') continue;
          const base = derivacao.atributos.base === undefined ? undefined : nomeLocal(derivacao.atributos.base);
          const declBase = base === undefined ? undefined : this.indice.complexos.get(base);
          if (tipoDerivacao === 'extension' && base !== undefined && declBase !== undefined && !pilhaTipos.includes(base)) {
            this.complexo(declBase.no, declBase.arquivo, caminho, profundidade, [...pilhaTipos, base]);
          }
          this.complexo(derivacao, arquivo, caminho, profundidade, pilhaTipos);
        }
      }
    }
  }
}

/**
 * Dicionário de campos do leiaute a partir dos XSD de um ZIP oficial.
 *
 * invariant: `include`/`import` só resolvem entre arquivos da mesma pasta do ZIP, pelo índice já
 * montado; nada é buscado fora do arquivo. Arquivos que não passam no parser seguro (ex.: XSD com
 * DTD) ficam de fora, e as referências a eles viram campos sem filhos.
 */
export function camposDeXsd(arquivos: readonly { nome: string; conteudo: string }[], opcoes: OpcoesXsd = {}): CampoLeiaute[] {
  const porPasta = new Map<string, { arquivo: string; raiz: NoXml }[]>();
  for (const a of arquivos) {
    if (!a.nome.toLowerCase().endsWith('.xsd')) continue;
    let raiz: NoXml;
    try {
      raiz = analisarXml(a.conteudo);
    } catch (erro) {
      if (erro instanceof ErroParser) continue;
      throw erro;
    }
    if (nomeLocal(raiz.nome) !== 'schema') continue;
    // why: a assinatura XML (xmldsig) é esquema da W3C embutido no ZIP, não leiaute da NFS-e.
    if (raiz.atributos.targetNamespace === NAMESPACE_XMLDSIG) continue;
    const pasta = diretorio(a.nome);
    porPasta.set(pasta, [...(porPasta.get(pasta) ?? []), { arquivo: a.nome, raiz }]);
  }

  const campos: CampoLeiaute[] = [];
  const maxCampos = opcoes.maxCampos ?? 20_000;
  for (const [pasta, esquemas] of [...porPasta.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const indice = indexar(esquemas);
    const versaoPasta = versaoDe(`${pasta}/`);
    for (const [nome, declaracao] of indice.elementos) {
      if (indice.referenciados.has(nome)) continue;
      const extrator = new Extrator(indice, versaoPasta ?? versaoDe(declaracao.arquivo), maxCampos - campos.length, opcoes.maxProfundidade ?? 40);
      extrator.elemento(declaracao.no, declaracao.arquivo, '', 0, []);
      campos.push(...extrator.campos);
    }
  }
  return campos;
}
