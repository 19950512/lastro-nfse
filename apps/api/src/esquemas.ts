import { TIPOS_EVENTO } from '@lastro/ingest';
import { z } from 'zod';

const dataConsulta = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  // why: data sem hora é interpretada no fuso de Brasília, como o usuário a lê no Diário Oficial.
  .transform((s) => new Date(s.length === 10 ? `${s}T00:00:00-03:00` : s));

const limite = z.coerce.number().int().min(1).max(500).default(100);
const cursor = z.string().max(4096);
const idFonte = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const ConsultaMudancas = z.strictObject({
  desde: dataConsulta.optional(),
  ate: dataConsulta.optional(),
  fonte: idFonte.optional(),
  tipo: z
    .string()
    .max(200)
    .transform((s) => s.split(','))
    .pipe(z.array(z.enum(TIPOS_EVENTO)).min(1))
    .optional(),
  anomalia: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limite,
  cursor: cursor.optional(),
});

export const ConsultaDocumentos = z.strictObject({
  fonte: idFonte.optional(),
  limite,
  cursor: cursor.optional(),
});

export const ParametroId = z.strictObject({ id: z.uuid() });

const Links = z.object({ documento: z.string(), original: z.string().nullable() });

export const Mudanca = z.object({
  id: z.uuid(),
  tipo: z.enum(TIPOS_EVENTO),
  fonte_id: z.string(),
  documento_id: z.uuid(),
  url: z.url(),
  snapshot_anterior: z.uuid().nullable(),
  snapshot_novo: z.uuid().nullable(),
  detectado_em: z.iso.datetime(),
  resumo: z.string(),
  anomalia: z.string().nullable().describe('Motivo quando a mudança precisa de revisão humana; null = normal'),
  links: Links,
});

export const PaginaMudancas = z.object({
  mudancas: z.array(Mudanca),
  proximo: z.string().nullable().describe('Cursor da próxima página; null quando acabou'),
});

export const ResumoDocumento = z.object({
  id: z.uuid(),
  fonte_id: z.string(),
  url: z.url(),
  versoes: z.number().int(),
  ultima_versao_em: z.iso.datetime().nullable(),
  ultima_verificacao_em: z.iso.datetime().nullable(),
  mime: z.string().nullable(),
  situacao: z.enum(['disponivel', 'indisponivel']),
});

export const PaginaDocumentos = z.object({ documentos: z.array(ResumoDocumento), proximo: z.string().nullable() });

export const DetalheDocumento = ResumoDocumento.extend({
  criado_em: z.iso.datetime(),
  historico: z.array(
    z.object({
      id: z.uuid(),
      coletado_em: z.iso.datetime(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int(),
      mime: z.string(),
      url_final: z.url(),
      original: z.string(),
    }),
  ),
  eventos: z.array(Mudanca),
});

export const Fonte = z.object({
  id: z.string(),
  nome: z.string(),
  orgao: z.string(),
  nivel: z.enum(['N1', 'N2', 'N3']),
  sementes: z.array(z.url()),
  sla_horas: z.number(),
  documentos: z.number().int(),
  ultima_versao_em: z.iso.datetime().nullable(),
  ultima_verificacao_em: z.iso.datetime().nullable(),
  atrasada: z.boolean().describe('Última verificação mais velha que o SLA da fonte'),
});

export const ListaFontes = z.object({ fontes: z.array(Fonte) });

export const Erro = z.object({
  erro: z.string(),
  detalhes: z.array(z.object({ campo: z.string(), mensagem: z.string() })).optional(),
});
