import type { ConsultasConhecimento, ConsultasFatos, ContagemRequisicoes, Credencial, FatoPublico, FiltroFatos, TabelaDisponivel, TrechoEncontrado } from '@lastro/db';
import { ErroAssinatura, ErroLimiteAlertas, type NovoAlerta, type RepositorioAlertas } from '@lastro/webhooks';
import type { RespostaPergunta, ResultadoVerificacao, ServicoPerguntas, ServicoVerificacoes } from '@lastro/llm';
import type { Autenticador, DependenciasApi } from './app.ts';

export const CHAVE_LEITURA = `lastro_leitura00000a_${'a'.repeat(43)}`;
export const CHAVE_TUDO = `lastro_tudo00000000b_${'b'.repeat(43)}`;
export const CHAVE_LENTA = `lastro_lenta0000000c_${'c'.repeat(43)}`;
export const CHAVE_VERIFICACOES = `lastro_verif000000d_${'d'.repeat(43)}`;

const credenciais: Record<string, Credencial> = {
  [CHAVE_LEITURA]: { chaveId: 'k-leitura', clienteId: '99999999-9999-4999-8999-999999999991', escopos: ['leitura'], limitePorMinuto: 10_000 },
  [CHAVE_TUDO]: { chaveId: 'k-tudo', clienteId: '99999999-9999-4999-8999-999999999992', escopos: ['leitura', 'perguntas', 'verificacoes'], limitePorMinuto: 10_000 },
  [CHAVE_VERIFICACOES]: { chaveId: 'k-verif', clienteId: '99999999-9999-4999-8999-999999999994', escopos: ['verificacoes'], limitePorMinuto: 10_000 },
  [CHAVE_LENTA]: { chaveId: 'k-lenta', clienteId: '99999999-9999-4999-8999-999999999993', escopos: ['leitura'], limitePorMinuto: 2 },
};

export const autenticadorFalso: Autenticador = { autenticar: (chave) => Promise.resolve(credenciais[chave]) };

const SNAP = '33333333-3333-4333-8333-333333333333';
const DOC = '11111111-1111-4111-8111-111111111111';

export const trechoFalso: TrechoEncontrado = {
  id: '77777777-7777-4777-8777-777777777777',
  texto: 'A obrigatoriedade passa a valer em 01/01/2027.',
  secao: 'Art. 1º',
  paginaIni: 2,
  paginaFim: 2,
  snapshotId: SNAP,
  sha256: 'c'.repeat(64),
  mime: 'application/pdf',
  coletadoEm: '2026-11-16T10:00:00.000Z',
  confirmadoEm: '2026-11-16T12:00:00.000Z',
  documentoId: DOC,
  url: 'https://www.gov.br/nfse/pt-br/rtc/nt-009.pdf',
  fonteId: 'nfse-rtc',
  documentoIndisponivel: false,
  pontuacao: 0.03,
};

export const tabelaFalsa: TabelaDisponivel = {
  slug: 'correlacao-item-nbs-indop-cclasstrib',
  titulo: 'Anexo VIII — correlação',
  planilha: 'Correlação',
  colunas: ['Item LC 116', 'cClassTrib'],
  linhas: 10,
  documentoId: DOC,
  url: 'https://www.gov.br/nfse/pt-br/rtc/anexo-viii.xlsx',
  snapshotId: SNAP,
  sha256: 'd'.repeat(64),
  coletadoEm: '2026-11-16T10:00:00.000Z',
  fonteId: 'nfse-rtc',
};

export const buscasRecebidas: unknown[] = [];

export const conhecimentoFalso: ConsultasConhecimento = {
  buscarTrechos: (filtro) => {
    buscasRecebidas.push(filtro);
    return Promise.resolve([trechoFalso, { ...trechoFalso, id: '88888888-8888-4888-8888-888888888888', fonteId: 'fonte-fora-do-catalogo' }]);
  },
  listarTabelas: () => Promise.resolve([tabelaFalsa]),
  consultarReferencia: (slug, codigo) =>
    Promise.resolve(slug === tabelaFalsa.slug && codigo === '000001' ? [{ tabela: tabelaFalsa, ordem: 0, dados: { 'Item LC 116': '1.05', cClassTrib: '000001' } }] : []),
  buscarCampos: (nome) =>
    Promise.resolve(
      nome.toLowerCase() === 'indfinal'
        ? [
            {
              nome: 'indFinal',
              caminho: 'DPS/infDPS/IBSCBS/indFinal',
              tipo: 'TSIndFinal',
              minOcorrencias: 1,
              maxOcorrencias: '1',
              descricao: 'Indica operação de uso ou consumo pessoal',
              arquivo: 'DPS_v1.01.xsd',
              versao: '1.01',
              documentoId: DOC,
              url: 'https://www.gov.br/nfse/pt-br/esquemas.zip',
              snapshotId: SNAP,
              sha256: 'e'.repeat(64),
              coletadoEm: '2026-11-16T10:00:00.000Z',
              fonteId: 'nfse-documentacao-atual',
            },
          ]
        : [],
    ),
};

export const respostaFalsa: RespostaPergunta = {
  situacao: 'respondida',
  rota: 'prazo',
  resposta: 'Vale em 01/01/2027. [1]',
  posicao_em: '2026-11-16',
  fontes: [
    {
      id: 1,
      titulo: 'nt-009.pdf',
      orgao: 'SE/CGNFS-e',
      nivel: 'N2',
      url: trechoFalso.url,
      secao: 'Art. 1º',
      pagina: 2,
      trecho: trechoFalso.texto,
      coletado_em: trechoFalso.coletadoEm,
      confirmado_em: trechoFalso.confirmadoEm,
      sha256: trechoFalso.sha256,
      snapshot_id: SNAP,
      documento_id: DOC,
      original: `/v1/snapshots/${SNAP}/original`,
    },
  ],
  avisos: [],
  limites: ['Não cobre ISS.'],
  aviso: 'Não substitui orientação profissional.',
  checagem: { citacoes_invalidas: 0, frases_sem_citacao_removidas: 0, conteudo_removido: 0 },
};

export const ID_PERGUNTA = '66666666-6666-4666-8666-666666666666';
export const perguntasRecebidas: { clienteId: string; pergunta: string }[] = [];

export const perguntasFalsas: ServicoPerguntas = {
  responder: (solicitante, pergunta) => {
    perguntasRecebidas.push({ clienteId: solicitante.clienteId, pergunta });
    return Promise.resolve({ id: ID_PERGUNTA, resposta: respostaFalsa });
  },
  obter: (clienteId, id) =>
    Promise.resolve(
      id === ID_PERGUNTA && clienteId === credenciais[CHAVE_TUDO]?.clienteId
        ? { id, criadaEm: '2026-11-16T12:00:00.000Z', rota: 'prazo', situacao: 'respondida', pergunta: 'Quando?', resposta: respostaFalsa }
        : undefined,
    ),
};

export const fatoFalso: FatoPublico = {
  id: '12121212-1212-4212-8212-121212121212',
  tipo: 'prazo',
  tema: 'ibs-cbs-nfse',
  enunciado: 'A obrigatoriedade do grupo IBS/CBS na NFS-e começa em 01/01/2027.',
  publico: 'contribuintes do grupo A',
  dataEfeito: '2027-01-01',
  situacao: 'aprovado',
  aprovadoEm: '2026-11-16T12:00:00.000Z',
  evidenciaAtual: true,
  evidenciaTexto: 'passa a valer em 01/01/2027',
  substitui: null,
  evidencia: {
    trechoId: trechoFalso.id,
    texto: trechoFalso.texto,
    secao: trechoFalso.secao,
    paginaIni: 2,
    paginaFim: 2,
    documentoId: DOC,
    snapshotId: SNAP,
    url: trechoFalso.url,
    fonteId: 'nfse-rtc',
    sha256: trechoFalso.sha256,
    coletadoEm: trechoFalso.coletadoEm,
  },
};

export const filtrosFatos: FiltroFatos[] = [];

export const fatosFalsos: ConsultasFatos = {
  listarFatos: (f) => {
    filtrosFatos.push(f);
    return Promise.resolve([fatoFalso, { ...fatoFalso, id: '13131313-1313-4313-8313-131313131313', evidencia: { ...fatoFalso.evidencia, fonteId: 'fonte-fora-do-catalogo' } }]);
  },
  obterFatos: (ids) => Promise.resolve(ids.includes(fatoFalso.id) ? [fatoFalso] : []),
  listarTemas: () => Promise.resolve([{ tema: 'ibs-cbs-nfse', fatos: 1 }]),
  relacoesDosDocumentos: () => Promise.resolve([]),
  obterRelacoes: () => Promise.resolve([]),
};

export const XSS = '"><script>alert(1)</script><img src=x onerror=alert(2)>';

export const resultadoVerificacaoFalso: ResultadoVerificacao = {
  situacao: 'verificada',
  posicao_em: '2026-11-17',
  alegacoes: [
    {
      id: 'C1',
      alegacao: `O IBS começa em 2027 ${XSS}`,
      tipo: 'prazo',
      data_mencionada: null,
      veredito: 'confirmado',
      rotulo: 'CONFIRMADO',
      veredito_proposto: 'confirmado',
      rebaixado: false,
      explicacao: 'A fonte oficial citada afirma o mesmo que a alegação.',
      evidencias: [
        {
          titulo: `nt-009.pdf ${XSS}`,
          orgao: 'SE/CGNFS-e',
          nivel: 'N2',
          url: 'javascript:alert(3)',
          secao: 'Art. 1º',
          pagina: 2,
          trecho: `passa a valer em 01/01/2027 ${XSS}`,
          coletado_em: '2026-11-16T10:00:00.000Z',
          sha256: 'c'.repeat(64),
          snapshot_id: SNAP,
          documento_id: DOC,
          original: `/v1/snapshots/${SNAP}/original`,
          revogado_por: null,
        },
      ],
      fatos: [],
      relacoes: [],
      avisos: [],
      busca: { consulta: 'IBS 2027', fontes_consultadas: 3 },
    },
  ],
  avisos: [],
  limites: ['Não cobre ISS.'],
  aviso: 'Não substitui orientação profissional.',
  checagem: { citacoes_invalidas: 0, vereditos_rebaixados: 0 },
};

export const ID_VERIFICACAO = '14141414-1414-4414-8414-141414141414';
export const TOKEN_COMPARTILHADO = 't'.repeat(43);
export const TOKEN_RECALL = 'r'.repeat(43);
export const verificacoesRecebidas: { clienteId: string; texto: string; dataConteudo: string | undefined }[] = [];

export const verificacoesFalsas: ServicoVerificacoes = {
  verificar: (s, texto, opcoes) => {
    verificacoesRecebidas.push({ clienteId: s.clienteId, texto, dataConteudo: opcoes?.dataConteudo });
    return Promise.resolve({ id: ID_VERIFICACAO, criadaEm: '2026-11-17T12:00:00.000Z', expiraEm: '2026-12-17T12:00:00.000Z', resultado: resultadoVerificacaoFalso });
  },
  obter: (clienteId, id) =>
    Promise.resolve(
      id === ID_VERIFICACAO && clienteId === credenciais[CHAVE_TUDO]?.clienteId
        ? { id, criadaEm: '2026-11-17T12:00:00.000Z', expiraEm: '2026-12-17T12:00:00.000Z', resultado: resultadoVerificacaoFalso, correcoes: [], compartilhada: false }
        : undefined,
    ),
  compartilhar: (clienteId, id) => Promise.resolve(id === ID_VERIFICACAO && clienteId === credenciais[CHAVE_TUDO]?.clienteId ? TOKEN_COMPARTILHADO : undefined),
  revogarCompartilhamento: (clienteId, id) => Promise.resolve(id === ID_VERIFICACAO && clienteId === credenciais[CHAVE_TUDO]?.clienteId),
  obterCompartilhada: (token) => {
    const base = { id: ID_VERIFICACAO, criadaEm: '2026-11-17T12:00:00.000Z', expiraEm: '2026-12-17T12:00:00.000Z', resultado: resultadoVerificacaoFalso };
    if (token === TOKEN_COMPARTILHADO) return Promise.resolve({ ...base, correcoes: [] });
    if (token === TOKEN_RECALL) return Promise.resolve({ ...base, correcoes: [{ tipo: 'fato' as const, id: fatoFalso.id, descricao: `Fato errado ${XSS}`, situacao: 'revogado' as const }] });
    return Promise.resolve(undefined);
  },
};

export const CHAVE_ALERTAS = `lastro_alertas00000e_${'e'.repeat(43)}`;
credenciais[CHAVE_ALERTAS] = { chaveId: 'k-alertas', clienteId: '99999999-9999-4999-8999-999999999995', escopos: ['alertas'], limitePorMinuto: 10_000 };

export const contagensGravadas: ContagemRequisicoes[] = [];

export const contasFalsas: DependenciasApi['contas'] = {
  limites: (clienteId) =>
    Promise.resolve(
      Object.values(credenciais).some((c) => c.clienteId === clienteId)
        ? {
            planoId: 'padrao',
            planoNome: 'Padrão',
            limitePorMinuto: 60,
            cotaMensalPerguntas: 1000,
            cotaMensalVerificacoes: 500,
            orcamentoMensalUsd: 50,
            maxAlertas: 2,
          }
        : undefined,
    ),
  usoMensal: () => Promise.resolve({ perguntas: 3, verificacoes: 1, gastoUsd: 0.42, cotaMensalPerguntas: 1000, cotaMensalVerificacoes: 500, orcamentoMensalUsd: 50 }),
  usoPorDia: (_clienteId, desde, ate) =>
    Promise.resolve(
      [
        { dia: '2026-11-15', metrica: 'requisicoes' as const, quantidade: 40, custoUsd: 0 },
        { dia: '2026-11-15', metrica: 'perguntas' as const, quantidade: 2, custoUsd: 0.3 },
        { dia: '2026-11-16', metrica: 'perguntas-fora-do-escopo' as const, quantidade: 1, custoUsd: 0 },
        { dia: '2026-11-16', metrica: 'verificacoes' as const, quantidade: 1, custoUsd: 0.12 },
      ].filter((d) => d.dia >= desde && d.dia <= ate),
    ),
  registrarRequisicoes: (c) => {
    contagensGravadas.push(...c);
    return Promise.resolve();
  },
};

export const XSS_ALERTA = `Alerta ${XSS}`;
export const ID_ALERTA = '16161616-1616-4616-8616-161616161616';
export const alertasCriados: { clienteId: string; novo: NovoAlerta; maxAlertas: number }[] = [];

export const alertasFalsos: RepositorioAlertas = {
  criar: (clienteId, novo, maxAlertas) => {
    if (novo.url.startsWith('https://10.')) return Promise.reject(new ErroAssinatura('IP literal não é aceito; use um nome de host'));
    if (alertasCriados.filter((a) => a.clienteId === clienteId).length >= maxAlertas) return Promise.reject(new ErroLimiteAlertas(maxAlertas));
    alertasCriados.push({ clienteId, novo, maxAlertas });
    return Promise.resolve({ id: ID_ALERTA, segredo: 's'.repeat(64) });
  },
  listar: (clienteId) =>
    Promise.resolve(
      clienteId === credenciais[CHAVE_ALERTAS]?.clienteId
        ? [
            {
              id: ID_ALERTA,
              nome: XSS_ALERTA,
              url: 'https://hooks.cliente.example/lastro',
              formato: 'lastro' as const,
              fontes: null,
              tipos: ['nova-versao', 'fato-aprovado'],
              termos: ['cronograma IBS/CBS'],
              temas: ['cronograma-ibs-cbs'],
              ativo: true,
              criadoEm: '2026-11-17T12:00:00.000Z',
              falhasConsecutivas: 0,
              motivoDesativacao: null,
            },
          ]
        : [],
    ),
  remover: (clienteId, id) => Promise.resolve(id === ID_ALERTA && clienteId === credenciais[CHAVE_ALERTAS]?.clienteId),
};
