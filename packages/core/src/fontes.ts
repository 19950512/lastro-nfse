/**
 * Catálogo de fontes oficiais (espelho executável de docs/FONTES-OFICIAIS.md).
 *
 * invariant: toda semente precisa passar em verificarOrigem(); o teste fontes.test.ts falha se não passar.
 */

export type Nivel = 'N1' | 'N2' | 'N3';

export type Formato = 'html' | 'pdf' | 'xlsx' | 'zip' | 'xsd' | 'xml' | 'doc';

/** Município cuja legislação a fonte publica (Fase 5, ISS). */
export interface MunicipioFonte {
  /** Código IBGE de 7 dígitos. */
  readonly codigoIbge: string;
  readonly nome: string;
  readonly uf: string;
}

export interface Fonte {
  readonly id: string;
  readonly nome: string;
  readonly orgao: string;
  readonly nivel: Nivel;
  /** Páginas de entrada coletadas a cada rodada. */
  readonly sementes: readonly string[];
  /** Formatos esperados nesta fonte, segundo o catálogo. */
  readonly formatos: readonly Formato[];
  /** Se os links de documentos (PDF, XLSX, ZIP…) das sementes também são coletados. */
  readonly colherDocumentos: boolean;
  readonly frequenciaHoras: number;
  /** Prazo máximo entre publicação na fonte e disponibilidade na plataforma (ROADMAP, "Frescor"). */
  readonly slaHoras: number;
  /** Coluna "Validado" de FONTES-OFICIAIS.md antes da Fase 0. */
  readonly validadaNoCatalogo: boolean;
  /** Presente só em fonte de legislação municipal (ISS). */
  readonly municipio?: MunicipioFonte;
}

const NFSE = 'https://www.gov.br/nfse/pt-br';
const DOC_TEC = `${NFSE}/biblioteca/documentacao-tecnica`;
const PLANALTO = 'https://www.planalto.gov.br/ccivil_03';
const SP_LEGISLACAO = 'https://legislacao.prefeitura.sp.gov.br';

export const FONTES: readonly Fonte[] = [
  {
    id: 'planalto-legislacao',
    nome: 'Planalto – legislação federal',
    orgao: 'Presidência da República',
    nivel: 'N1',
    sementes: [
      `${PLANALTO}/leis/lcp/lcp214.htm`,
      `${PLANALTO}/leis/lcp/lcp116.htm`,
      `${PLANALTO}/leis/lcp/lcp227.htm`,
      `${PLANALTO}/constituicao/emendas/emc/emc132.htm`,
      `${PLANALTO}/_ato2023-2026/2026/decreto/d12955.htm`,
    ],
    formatos: ['html', 'doc'],
    colherDocumentos: false,
    frequenciaHoras: 24,
    slaHoras: 24,
    validadaNoCatalogo: true,
  },
  {
    id: 'dou',
    nome: 'Diário Oficial da União',
    orgao: 'Imprensa Nacional',
    nivel: 'N1',
    sementes: ['https://www.in.gov.br/inicio', 'https://inlabs.in.gov.br/'],
    formatos: ['html', 'xml'],
    colherDocumentos: false,
    frequenciaHoras: 24,
    slaHoras: 24,
    validadaNoCatalogo: false,
  },
  {
    id: 'receita-sijut',
    nome: 'Base de normas da Receita Federal (SIJUT)',
    orgao: 'Receita Federal do Brasil',
    nivel: 'N1',
    sementes: ['https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action'],
    formatos: ['html'],
    colherDocumentos: false,
    frequenciaHoras: 24,
    slaHoras: 24,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-resolucoes',
    nome: 'Portal NFS-e – Portarias e Resoluções do CGNFS-e',
    orgao: 'CGNFS-e',
    nivel: 'N1',
    sementes: [`${NFSE}/biblioteca/portarias-e-resolucoes-cgnfs-e`],
    formatos: ['pdf'],
    colherDocumentos: true,
    frequenciaHoras: 6,
    slaHoras: 24,
    validadaNoCatalogo: true,
  },
  {
    id: 'cgibs',
    nome: 'Comitê Gestor do IBS',
    orgao: 'CGIBS',
    nivel: 'N1',
    sementes: [
      'https://www.cgibs.gov.br/inicial',
      'https://www.cgibs.gov.br/atos-conjuntos',
      'https://www.cgibs.gov.br/atos-tecnicos-conjuntos',
      'https://www.cgibs.gov.br/resolucoes',
    ],
    formatos: ['pdf', 'html'],
    colherDocumentos: true,
    frequenciaHoras: 6,
    slaHoras: 24,
    validadaNoCatalogo: false,
  },
  {
    id: 'lexml',
    nome: 'LexML',
    orgao: 'LexML Brasil',
    nivel: 'N1',
    sementes: ['https://www.lexml.gov.br/'],
    formatos: ['html', 'xml'],
    colherDocumentos: false,
    frequenciaHoras: 24,
    slaHoras: 24,
    validadaNoCatalogo: false,
  },
  {
    id: 'nfse-rtc',
    nome: 'Portal NFS-e – Documentação RTC',
    orgao: 'SE/CGNFS-e',
    nivel: 'N2',
    sementes: [`${DOC_TEC}/rtc`],
    formatos: ['pdf', 'xlsx', 'zip'],
    colherDocumentos: true,
    frequenciaHoras: 3,
    slaHoras: 6,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-documentacao-atual',
    nome: 'Portal NFS-e – Documentação atual (produção)',
    orgao: 'SE/CGNFS-e',
    nivel: 'N2',
    sementes: [`${DOC_TEC}/documentacao-atual`],
    formatos: ['pdf', 'xlsx', 'zip'],
    colherDocumentos: true,
    frequenciaHoras: 3,
    slaHoras: 6,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-producao-restrita',
    nome: 'Portal NFS-e – Homologação / produção restrita',
    orgao: 'SE/CGNFS-e',
    nivel: 'N2',
    sementes: [`${DOC_TEC}/producao-restrita`],
    formatos: ['pdf', 'xlsx', 'zip'],
    colherDocumentos: true,
    frequenciaHoras: 3,
    slaHoras: 6,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-apis',
    nome: 'Portal NFS-e – APIs',
    orgao: 'SE/CGNFS-e',
    nivel: 'N2',
    sementes: [`${DOC_TEC}/apis-prod-restrita-e-producao`],
    formatos: ['pdf', 'html'],
    colherDocumentos: true,
    frequenciaHoras: 6,
    slaHoras: 12,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-atualizacoes',
    nome: 'Portal NFS-e – Atualizações e implantações',
    orgao: 'SE/CGNFS-e',
    nivel: 'N2',
    sementes: [`${DOC_TEC}/atualizacoes-e-implantacoes`],
    formatos: ['html', 'pdf'],
    colherDocumentos: true,
    frequenciaHoras: 6,
    slaHoras: 12,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-leiautes-antigos',
    nome: 'Portal NFS-e – Leiautes antigos',
    orgao: 'SE/CGNFS-e',
    nivel: 'N2',
    sementes: [`${DOC_TEC}/leiaute-e-esquemas-antigos`],
    formatos: ['pdf', 'zip'],
    colherDocumentos: true,
    frequenciaHoras: 168,
    slaHoras: 168,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-via',
    nome: 'Portal NFS-e – NFS-e Via',
    orgao: 'SE/CGNFS-e',
    nivel: 'N2',
    sementes: [`${NFSE}/nfs-e-via/documentacao-tecnica`, `${NFSE}/nfs-e-via/documentacao-tecnica/notas-tecnicas`],
    formatos: ['pdf', 'zip'],
    colherDocumentos: true,
    frequenciaHoras: 6,
    slaHoras: 12,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-tabelas',
    nome: 'Portal NFS-e – Eventos, Lista de serviços/NBS',
    orgao: 'SE/CGNFS-e',
    nivel: 'N2',
    sementes: [`${NFSE}/biblioteca/eventos_NFS-e`, `${NFSE}/mei-e-demais-empresas/codigos-de-tributacao-nacional-nbs`],
    formatos: ['html', 'xlsx'],
    colherDocumentos: true,
    frequenciaHoras: 24,
    slaHoras: 24,
    validadaNoCatalogo: true,
  },
  {
    // why: cadastro dos municípios no ambiente nacional, publicado pelo CGNFS-e para os 5.571 municípios.
    // Não substitui a lei municipal (Fase 5): é o que o município declarou ao sistema nacional.
    id: 'nfse-aliquotas-iss',
    nome: 'Portal NFS-e – Alíquotas de ISSQN',
    orgao: 'SE/CGNFS-e',
    nivel: 'N2',
    sementes: [`${NFSE}/biblioteca/aliquotas/aliquotas-de-issqn`],
    formatos: ['html', 'zip'],
    colherDocumentos: true,
    frequenciaHoras: 24,
    slaHoras: 48,
    validadaNoCatalogo: true,
  },
  {
    id: 'receita-reforma',
    nome: 'Receita Federal – Reforma Tributária do Consumo',
    orgao: 'Receita Federal do Brasil',
    nivel: 'N2',
    sementes: ['https://www.gov.br/receitafederal/pt-br/assuntos/reforma-tributaria'],
    formatos: ['pdf', 'html'],
    colherDocumentos: true,
    frequenciaHoras: 12,
    slaHoras: 24,
    validadaNoCatalogo: false,
  },
  {
    id: 'nfe-portal',
    nome: 'Portal Nacional da NF-e',
    orgao: 'Portal Nacional da NF-e',
    nivel: 'N2',
    sementes: ['https://www.nfe.fazenda.gov.br/portal/principal.aspx'],
    formatos: ['pdf'],
    colherDocumentos: false,
    frequenciaHoras: 24,
    slaHoras: 48,
    validadaNoCatalogo: false,
  },
  {
    id: 'nfse-noticias',
    nome: 'Notícias do Portal NFS-e',
    orgao: 'CGNFS-e',
    nivel: 'N3',
    sementes: [`${NFSE}/noticias`],
    formatos: ['html'],
    colherDocumentos: false,
    frequenciaHoras: 3,
    slaHoras: 6,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-faq',
    nome: 'Perguntas Frequentes do Portal NFS-e',
    orgao: 'CGNFS-e',
    nivel: 'N3',
    sementes: [`${NFSE}/perguntas-frequentes`],
    formatos: ['html'],
    colherDocumentos: false,
    frequenciaHoras: 24,
    slaHoras: 24,
    validadaNoCatalogo: true,
  },
  {
    id: 'nfse-municipios',
    nome: 'Monitoramento das Adesões / Plano de Implantação',
    orgao: 'CGNFS-e',
    nivel: 'N3',
    sementes: [`${NFSE}/municipios/monitoramento-adesoes`],
    formatos: ['html', 'xlsx'],
    colherDocumentos: true,
    frequenciaHoras: 24,
    slaHoras: 48,
    validadaNoCatalogo: true,
  },
  {
    id: 'receita-noticias',
    nome: 'Notícias da Receita Federal',
    orgao: 'Receita Federal do Brasil',
    nivel: 'N3',
    sementes: ['https://www.gov.br/receitafederal/pt-br/assuntos/noticias'],
    formatos: ['html'],
    colherDocumentos: false,
    frequenciaHoras: 6,
    slaHoras: 12,
    validadaNoCatalogo: true,
  },
  {
    id: 'fazenda-reforma',
    nome: 'Ministério da Fazenda – Reforma Tributária',
    orgao: 'Ministério da Fazenda',
    nivel: 'N3',
    sementes: ['https://www.gov.br/fazenda/pt-br/acesso-a-informacao/acoes-e-programas/reforma-tributaria'],
    formatos: ['html', 'pdf'],
    colherDocumentos: false,
    frequenciaHoras: 24,
    slaHoras: 48,
    validadaNoCatalogo: false,
  },
  /* invariant: legislação municipal do ISS (Fase 5) entra um município por vez, e só se o site oficial passou na
     sondagem: HTTPS válido, robots.txt permite e o texto está no HTML sem depender de script
     (docs/FONTES-OFICIAIS.md, "Legislação municipal"). */
  {
    id: 'municipio-3550308-legislacao',
    nome: 'Prefeitura de São Paulo – Catálogo de Legislação Municipal (ISS)',
    orgao: 'Prefeitura do Município de São Paulo',
    nivel: 'N1',
    // hazard: o catálogo responde 200 com a página inicial genérica para endereço inexistente (soft 404);
    // cada semente foi conferida pelo título do ato em 17/11/2026.
    sementes: [
      `${SP_LEGISLACAO}/lei-13701-de-24-de-dezembro-de-2003`,
      `${SP_LEGISLACAO}/decreto-53151-de-17-de-maio-de-2012`,
      `${SP_LEGISLACAO}/lei-14097-de-08-de-dezembro-de-2005`,
    ],
    formatos: ['html'],
    colherDocumentos: false,
    frequenciaHoras: 24,
    slaHoras: 48,
    validadaNoCatalogo: true,
    municipio: { codigoIbge: '3550308', nome: 'São Paulo', uf: 'SP' },
  },
];

export function buscarFonte(id: string): Fonte | undefined {
  return FONTES.find((f) => f.id === id);
}

export function fontesMunicipais(fontes: readonly Fonte[] = FONTES): Fonte[] {
  return fontes.filter((f) => f.municipio !== undefined);
}
