import { z } from 'zod';
import {
  CamposLeiaute,
  ConsultaBusca,
  ConsultaCampo,
  ConsultaDocumentos,
  ConsultaMudancas,
  ConsultaReferencia,
  DetalheDocumento,
  Erro,
  LinhasReferencia,
  ListaFontes,
  ListaTabelas,
  PaginaDocumentos,
  PaginaMudancas,
  ParametroCampo,
  ParametroId,
  ParametroTabela,
  PedidoPergunta,
  PerguntaSalva,
  RespostaPergunta,
  ResultadoBusca,
  Compartilhamento,
  ConsultaFatos,
  Fato,
  ListaFatos,
  ListaTemas,
  ParametroToken,
  PedidoVerificacao,
  RespostaVerificacao,
  VerificacaoPublica,
  VerificacaoSalva,
  AlertaCriado,
  ConsultaUso,
  ListaAlertas,
  PedidoAlerta,
  RespostaUso,
} from './esquemas.ts';

interface EsquemaJson {
  properties?: Record<string, unknown>;
  required?: string[];
}

function parametros(esquema: z.ZodObject, local: 'query' | 'path'): object[] {
  const json = z.toJSONSchema(esquema, { io: 'input' }) as EsquemaJson;
  return Object.entries(json.properties ?? {}).map(([name, schema]) => ({
    name,
    in: local,
    required: local === 'path' || (json.required ?? []).includes(name),
    schema,
  }));
}

function json(descricao: string, esquema: z.ZodType): object {
  return { description: descricao, content: { 'application/json': { schema: z.toJSONSchema(esquema) } } };
}

const ERROS = {
  '400': json('Parâmetros inválidos', Erro),
  '401': json('Chave de API ausente ou inválida', Erro),
  '403': json('Chave sem o escopo exigido', Erro),
  '404': json('Não encontrado', Erro),
  '429': json('Limite de requisições ou cota mensal atingidos (ver cabeçalho retry-after)', Erro),
  '500': json('Erro interno (sem detalhes)', Erro),
};

const LEITURA = [{ chave: ['leitura'] }];
const PERGUNTAS = [{ chave: ['perguntas'] }];
const VERIFICACOES = [{ chave: ['verificacoes'] }];
const ALERTAS = [{ chave: ['alertas'] }];

let cache: object | undefined;

// why: a especificação sai dos mesmos schemas Zod que validam as requisições (ARQUITETURA.md §4.1), então não diverge do código.
export function documentoOpenApi(): object {
  cache ??= {
    openapi: '3.1.0',
    info: {
      title: 'Lastro — NFS-e e reforma tributária com fonte oficial',
      version: '0.4.0',
      description:
        'Documentos, mudanças, trechos, tabelas e leiaute coletados exclusivamente de órgãos públicos, e perguntas respondidas só com citação dessas fontes. Autenticação: `Authorization: Bearer <chave>`.',
    },
    components: {
      securitySchemes: {
        chave: { type: 'http', scheme: 'bearer', description: 'Chave de API por cliente (escopos: leitura, perguntas, verificacoes, alertas)' },
      },
    },
    security: LEITURA,
    paths: {
      '/v1/mudancas': {
        get: {
          summary: 'Feed "o que mudou" nas fontes oficiais',
          parameters: parametros(ConsultaMudancas, 'query'),
          responses: { '200': json('Página de mudanças em ordem cronológica', PaginaMudancas), ...ERROS },
        },
      },
      '/v1/fontes': {
        get: { summary: 'Catálogo de fontes com situação da coleta', responses: { '200': json('Fontes', ListaFontes), ...ERROS } },
      },
      '/v1/documentos': {
        get: {
          summary: 'Documentos arquivados',
          parameters: parametros(ConsultaDocumentos, 'query'),
          responses: { '200': json('Página de documentos', PaginaDocumentos), ...ERROS },
        },
      },
      '/v1/documentos/{id}': {
        get: {
          summary: 'Documento com histórico de versões e eventos',
          parameters: parametros(ParametroId, 'path'),
          responses: { '200': json('Documento', DetalheDocumento), ...ERROS },
        },
      },
      '/v1/snapshots/{id}/original': {
        get: {
          summary: 'Bytes originais de uma versão (download; hash no cabeçalho x-lastro-sha256)',
          parameters: parametros(ParametroId, 'path'),
          responses: { '200': { description: 'Arquivo original' }, ...ERROS },
        },
      },
      '/v1/busca': {
        get: {
          summary: 'Trechos oficiais brutos, sem geração (busca léxica + identificadores, fusão RRF)',
          parameters: parametros(ConsultaBusca, 'query'),
          responses: { '200': json('Trechos com origem, versão e hash', ResultadoBusca), ...ERROS },
        },
      },
      '/v1/referencias': {
        get: { summary: 'Tabelas oficiais estruturadas (anexos XLSX)', responses: { '200': json('Tabelas', ListaTabelas), ...ERROS } },
      },
      '/v1/referencias/{tabela}': {
        get: {
          summary: 'Consulta exata por código numa tabela oficial (cClassTrib, NBS, indOp…)',
          parameters: [...parametros(ParametroTabela, 'path'), ...parametros(ConsultaReferencia, 'query')],
          responses: { '200': json('Linhas encontradas', LinhasReferencia), ...ERROS },
        },
      },
      '/v1/leiaute/campos/{nome}': {
        get: {
          summary: 'Definição versionada de campo do leiaute (dicionário extraído dos XSD oficiais)',
          parameters: [...parametros(ParametroCampo, 'path'), ...parametros(ConsultaCampo, 'query')],
          responses: { '200': json('Campos com esse nome, da versão mais recente para a mais antiga', CamposLeiaute), ...ERROS },
        },
      },
      '/v1/perguntas': {
        post: {
          summary: 'Pergunta em linguagem natural → resposta só com citações de fonte oficial',
          security: PERGUNTAS,
          requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(PedidoPergunta) } } },
          responses: {
            '200': json('Resposta checada (pode ser "sem-resposta" ou "fora-do-escopo")', RespostaPergunta),
            ...ERROS,
            '503': json('Orçamento global de LLM esgotado ou provedor indisponível', Erro),
          },
        },
      },
      '/v1/perguntas/{id}': {
        get: {
          summary: 'Resposta já dada a este cliente (retenção limitada)',
          security: PERGUNTAS,
          parameters: parametros(ParametroId, 'path'),
          responses: { '200': json('Pergunta e resposta registradas', PerguntaSalva), ...ERROS },
        },
      },
      '/v1/fatos': {
        get: {
          summary: 'Fatos aprovados por dupla curadoria humana (prazos, obrigações, vigências), com o trecho oficial que os sustenta',
          parameters: parametros(ConsultaFatos, 'query'),
          responses: { '200': json('Fatos', ListaFatos), ...ERROS },
        },
      },
      '/v1/fatos/temas': { get: { summary: 'Temas com fatos aprovados', responses: { '200': json('Temas', ListaTemas), ...ERROS } } },
      '/v1/fatos/{id}': {
        get: {
          summary: 'Fato por id (inclui superados e revogados, para conferir recall)',
          parameters: parametros(ParametroId, 'path'),
          responses: { '200': json('Fato', Fato), ...ERROS },
        },
      },
      '/v1/verificacoes': {
        post: {
          summary: 'Verificação de alegações ("isso é fake?"): vereditos por alegação, só com evidência oficial e regras de evidência em código',
          security: VERIFICACOES,
          requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(PedidoVerificacao) } } },
          responses: {
            '200': json('Verificação checada (pode ser "sem-alegacoes" ou "rejeitada")', RespostaVerificacao),
            ...ERROS,
            '503': json('Orçamento global de LLM esgotado ou provedor indisponível', Erro),
          },
        },
      },
      '/v1/verificacoes/{id}': {
        get: {
          summary: 'Verificação já feita por este cliente, com correções de recall',
          security: VERIFICACOES,
          parameters: parametros(ParametroId, 'path'),
          responses: { '200': json('Verificação', VerificacaoSalva), ...ERROS },
        },
      },
      '/v1/verificacoes/{id}/compartilhamento': {
        post: {
          summary: 'Gera link público permanente (até o fim da retenção); um novo link invalida o anterior',
          security: VERIFICACOES,
          parameters: parametros(ParametroId, 'path'),
          responses: { '200': json('Link', Compartilhamento), ...ERROS },
        },
        delete: {
          summary: 'Revoga o link público',
          security: VERIFICACOES,
          parameters: parametros(ParametroId, 'path'),
          responses: { '204': { description: 'Revogado' }, ...ERROS },
        },
      },
      '/v1/publico/verificacoes/{token}': {
        get: {
          summary: 'Verificação compartilhada (sem chave; sem o texto original enviado)',
          security: [],
          parameters: parametros(ParametroToken, 'path'),
          responses: { '200': json('Verificação', VerificacaoPublica), '404': json('Não encontrada, expirada ou não compartilhada', Erro) },
        },
      },
      '/v1/uso': {
        get: {
          summary: 'Plano, limites e uso medido do cliente (qualquer escopo)',
          security: [{ chave: [] }],
          parameters: parametros(ConsultaUso, 'query'),
          responses: { '200': json('Uso por dia (UTC) e do mês corrente', RespostaUso), ...ERROS },
        },
      },
      '/v1/alertas': {
        post: {
          summary: 'Cria alerta por tema: webhook disparado quando o texto que mudou contém os termos ou quando há fato curado do tema',
          security: ALERTAS,
          requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(PedidoAlerta, { io: 'input' }) } } },
          responses: {
            '201': json('Alerta criado; o segredo HMAC aparece só nesta resposta', AlertaCriado),
            ...ERROS,
            '403': json('Chave sem o escopo alertas ou limite de alertas do plano atingido (erro limite-do-plano)', Erro),
          },
        },
        get: { summary: 'Alertas do cliente', security: ALERTAS, responses: { '200': json('Alertas', ListaAlertas), ...ERROS } },
      },
      '/v1/alertas/{id}': {
        delete: {
          summary: 'Desativa o alerta (o histórico de entregas fica)',
          security: ALERTAS,
          parameters: parametros(ParametroId, 'path'),
          responses: { '204': { description: 'Desativado' }, ...ERROS },
        },
      },
      '/v1/saude': { get: { summary: 'Saúde do serviço', security: [], responses: { '200': { description: 'ok' } } } },
      '/v1/openapi.json': { get: { summary: 'Esta especificação', security: [], responses: { '200': { description: 'OpenAPI 3.1' } } } },
    },
  };
  return cache;
}
