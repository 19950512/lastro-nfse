import type { Fonte } from '@lastro/core';
import { ErroCursor, type ConsultasArquivo, type Mudanca, type ResumoDocumento } from '@lastro/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, type z } from 'zod';
import {
  ConsultaDocumentos,
  ConsultaMudancas,
  ParametroId,
  type DetalheDocumento,
  type Fonte as FonteSaida,
  type Mudanca as MudancaSaida,
  type ResumoDocumento as ResumoSaida,
} from './esquemas.ts';
import { documentoOpenApi } from './openapi.ts';
import { registrarPainel } from './painel.ts';

export interface DependenciasApi {
  readonly consultas: ConsultasArquivo;
  lerOriginal(sha: string): Promise<Buffer>;
  readonly fontes: readonly Fonte[];
  readonly agora?: () => Date;
}

export interface OpcoesApi {
  readonly logger?: boolean;
}

// why: só estes tipos saem com o próprio Content-Type; o resto (HTML arquivado inclusive) vai como
// octet-stream, para nunca ser interpretado pelo navegador na origem da API (XSS armazenado).
const MIMES_DOWNLOAD = new Map<string, string>([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/zip', 'zip'],
  ['application/x-zip-compressed', 'zip'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['text/csv', 'csv'],
]);

const CSP_API = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function linkOriginal(snapshotId: string | null): string | null {
  return snapshotId === null ? null : `/v1/snapshots/${snapshotId}/original`;
}

export function mudancaParaSaida(m: Mudanca): z.infer<typeof MudancaSaida> {
  return {
    id: m.id,
    tipo: m.tipo,
    fonte_id: m.fonteId,
    documento_id: m.documentoId,
    url: m.url,
    snapshot_anterior: m.snapshotAnterior,
    snapshot_novo: m.snapshotNovo,
    detectado_em: m.detectadoEm,
    resumo: m.resumo,
    anomalia: m.anomalia,
    links: { documento: `/v1/documentos/${m.documentoId}`, original: linkOriginal(m.snapshotNovo) },
  };
}

function resumoParaSaida(d: ResumoDocumento): z.infer<typeof ResumoSaida> {
  return {
    id: d.id,
    fonte_id: d.fonteId,
    url: d.url,
    versoes: d.versoes,
    ultima_versao_em: d.ultimaVersaoEm,
    ultima_verificacao_em: d.ultimaVerificacaoEm,
    mime: d.mime,
    situacao: d.situacao,
  };
}

export async function listarFontes(deps: DependenciasApi): Promise<z.infer<typeof FonteSaida>[]> {
  const agora = (deps.agora ?? (() => new Date()))();
  const resumos = new Map((await deps.consultas.resumoFontes()).map((r) => [r.fonteId, r]));
  return deps.fontes.map((f) => {
    const r = resumos.get(f.id);
    const ultimaVersao = r?.ultimaVersaoEm ?? null;
    const ultimaVerificacao = r?.ultimaVerificacaoEm ?? null;
    const visto = [ultimaVersao, ultimaVerificacao].filter((d): d is string => d !== null).sort().at(-1);
    return {
      id: f.id,
      nome: f.nome,
      orgao: f.orgao,
      nivel: f.nivel,
      sementes: [...f.sementes],
      sla_horas: f.slaHoras,
      documentos: r?.documentos ?? 0,
      ultima_versao_em: ultimaVersao,
      ultima_verificacao_em: ultimaVerificacao,
      atrasada: visto === undefined || agora.getTime() - new Date(visto).getTime() > f.slaHoras * 3_600_000,
    };
  });
}

export function construirApp(deps: DependenciasApi, opcoes: OpcoesApi = {}): FastifyInstance {
  const app = Fastify({
    logger: opcoes.logger === true ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    trustProxy: false,
    bodyLimit: 1024,
    maxParamLength: 100,
    requestTimeout: 30_000,
    return503OnClosing: true,
  });

  app.addHook('onSend', async (_req, resposta) => {
    // invariant: rotas que servem HTML (painel) definem a própria CSP antes; aqui só entra o padrão restrito.
    if (resposta.getHeader('content-security-policy') === undefined) resposta.header('content-security-policy', CSP_API);
    resposta.header('x-content-type-options', 'nosniff');
    resposta.header('referrer-policy', 'no-referrer');
    resposta.header('x-frame-options', 'DENY');
    resposta.header('cross-origin-resource-policy', 'same-origin');
    resposta.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    if (resposta.getHeader('cache-control') === undefined) resposta.header('cache-control', 'no-store');
  });

  app.setErrorHandler((erro, req, resposta) => {
    if (erro instanceof ZodError) {
      return resposta.status(400).send({
        erro: 'requisicao-invalida',
        detalhes: erro.issues.map((i) => ({ campo: i.path.join('.') || '(consulta)', mensagem: i.message })),
      });
    }
    if (erro instanceof ErroCursor) return resposta.status(400).send({ erro: 'cursor-invalido' });
    const status = (erro as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) return resposta.status(status).send({ erro: 'requisicao-invalida' });
    // hazard: nunca devolver mensagem ou pilha do erro interno ao cliente (SEGURANCA.md A10).
    req.log.error(erro);
    return resposta.status(500).send({ erro: 'interno' });
  });

  app.setNotFoundHandler((_req, resposta) => resposta.status(404).send({ erro: 'nao-encontrado' }));

  app.get('/v1/saude', () => ({ situacao: 'ok' }));

  app.get('/v1/openapi.json', () => documentoOpenApi());

  app.get('/v1/fontes', async () => ({ fontes: await listarFontes(deps) }));

  app.get('/v1/mudancas', async (req) => {
    const q = ConsultaMudancas.parse(req.query);
    const pagina = await deps.consultas.listarMudancas({
      desde: q.desde,
      ate: q.ate,
      fonteId: q.fonte,
      tipos: q.tipo,
      anomalia: q.anomalia,
      limite: q.limite,
      cursor: q.cursor,
    });
    return { mudancas: pagina.itens.map(mudancaParaSaida), proximo: pagina.proximo };
  });

  app.get('/v1/documentos', async (req) => {
    const q = ConsultaDocumentos.parse(req.query);
    const pagina = await deps.consultas.listarDocumentos({ fonteId: q.fonte, limite: q.limite, cursor: q.cursor });
    return { documentos: pagina.itens.map(resumoParaSaida), proximo: pagina.proximo };
  });

  app.get('/v1/documentos/:id', async (req, resposta) => {
    const { id } = ParametroId.parse(req.params);
    const d = await deps.consultas.obterDocumento(id);
    if (d === undefined) return resposta.status(404).send({ erro: 'nao-encontrado' });
    const saida: z.infer<typeof DetalheDocumento> = {
      ...resumoParaSaida(d),
      criado_em: d.criadoEm,
      historico: d.historico.map((v) => ({
        id: v.id,
        coletado_em: v.coletadoEm,
        sha256: v.sha256,
        bytes: v.bytes,
        mime: v.mime,
        url_final: v.urlFinal,
        original: `/v1/snapshots/${v.id}/original`,
      })),
      eventos: d.eventos.map(mudancaParaSaida),
    };
    return saida;
  });

  app.get('/v1/snapshots/:id/original', async (req, resposta) => {
    const { id } = ParametroId.parse(req.params);
    const s = await deps.consultas.obterSnapshot(id);
    if (s === undefined) return resposta.status(404).send({ erro: 'nao-encontrado' });
    const corpo = await deps.lerOriginal(s.sha256);
    const extensao = MIMES_DOWNLOAD.get(s.mime) ?? 'bin';
    return resposta
      .header('content-type', MIMES_DOWNLOAD.has(s.mime) ? s.mime : 'application/octet-stream')
      .header('content-disposition', `attachment; filename="lastro-${s.sha256.slice(0, 16)}.${extensao}"`)
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-lastro-sha256', s.sha256)
      .header('x-lastro-coletado-em', s.coletadoEm)
      .send(corpo);
  });

  registrarPainel(app, deps);

  return app;
}
