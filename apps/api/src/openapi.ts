import { z } from 'zod';
import {
  ConsultaDocumentos,
  ConsultaMudancas,
  DetalheDocumento,
  Erro,
  ListaFontes,
  PaginaDocumentos,
  PaginaMudancas,
  ParametroId,
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
  '404': json('Não encontrado', Erro),
  '500': json('Erro interno (sem detalhes)', Erro),
};

let cache: object | undefined;

// why: a especificação sai dos mesmos schemas Zod que validam as requisições (ARQUITETURA.md §4.1), então não diverge do código.
export function documentoOpenApi(): object {
  cache ??= {
    openapi: '3.1.0',
    info: {
      title: 'Lastro — monitor de fontes oficiais de NFS-e',
      version: '0.1.0',
      description: 'Somente leitura. Documentos e mudanças coletados exclusivamente de órgãos públicos.',
    },
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
    },
  };
  return cache;
}
