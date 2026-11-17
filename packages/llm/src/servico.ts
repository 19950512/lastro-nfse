import type { Fonte } from '@lastro/core';
import type { CampoEncontrado, Canal, ConsultaRegistrada,ConsultasConhecimento, ConsultasFatos, LinhaEncontrada, RepositorioClientes, TrechoEncontrado } from '@lastro/db';
import { dataIsoBrasil } from './checagem.ts';
import type { ClienteModelo } from './modelo.ts';
import { responderPergunta, type DependenciasPipeline, type SituacaoNormativa } from './pipeline.ts';
import { evidenciaDeArquivada } from './verificacao.ts';
import type { Evidencia, RespostaPergunta } from './tipos.ts';

export type MotivoRecusa = 'cliente-inativo' | 'cota-mensal' | 'orcamento-cliente' | 'orcamento-global';

export class ErroCota extends Error {
  readonly motivo: MotivoRecusa;
  constructor(motivo: MotivoRecusa) {
    super(`pergunta recusada: ${motivo}`);
    this.name = 'ErroCota';
    this.motivo = motivo;
  }
}

export interface Solicitante {
  readonly clienteId: string;
  readonly chaveId: string | null;
  readonly canal: Canal;
}

export interface ServicoPerguntas {
  responder(solicitante: Solicitante, pergunta: string): Promise<{ id: string; resposta: RespostaPergunta }>;
  obter(clienteId: string, id: string): Promise<ConsultaRegistrada | undefined>;
}

export interface DependenciasServico {
  readonly clientes: RepositorioClientes;
  readonly conhecimento: ConsultasConhecimento;
  /** Fatos e grafo aprovados pela curadoria (Fase 3); sem eles, a pergunta usa só a busca. */
  readonly fatos?: ConsultasFatos;
  readonly modelo: ClienteModelo;
  readonly fontes: readonly Fonte[];
  /** Disjuntor global: soma do custo de LLM de todos os clientes desde 00:00 UTC. */
  readonly orcamentoDiarioUsd: number;
  readonly agora?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function evidenciaDeTrecho(t: TrechoEncontrado): Evidencia {
  return {
    tipo: 'trecho',
    id: t.id,
    titulo: decodeURIComponent(new URL(t.url).pathname.split('/').filter((p) => p !== '').at(-1) ?? t.url),
    texto: t.texto,
    secao: t.secao,
    paginaIni: t.paginaIni,
    paginaFim: t.paginaFim,
    url: t.url,
    fonteId: t.fonteId,
    documentoId: t.documentoId,
    snapshotId: t.snapshotId,
    sha256: t.sha256,
    coletadoEm: t.coletadoEm,
    confirmadoEm: t.confirmadoEm,
    documentoIndisponivel: t.documentoIndisponivel,
  };
}

export function evidenciaDeLinha(l: LinhaEncontrada): Evidencia {
  const t = l.tabela;
  return {
    tipo: 'linha-tabela',
    id: `${t.snapshotId}:${t.slug}:${l.ordem}`,
    titulo: t.titulo,
    texto: `Tabela "${t.titulo}", planilha "${t.planilha}", linha ${l.ordem + 1}. ${Object.entries(l.dados)
      .filter(([, v]) => v.trim() !== '')
      .map(([k, v]) => `${k}: ${v}.`)
      .join(' ')}`,
    secao: t.planilha,
    paginaIni: null,
    paginaFim: null,
    url: t.url,
    fonteId: t.fonteId,
    documentoId: t.documentoId,
    snapshotId: t.snapshotId,
    sha256: t.sha256,
    coletadoEm: t.coletadoEm,
    confirmadoEm: t.coletadoEm,
    documentoIndisponivel: false,
  };
}

export function evidenciaDeCampo(c: CampoEncontrado): Evidencia {
  return {
    tipo: 'campo-leiaute',
    id: `${c.snapshotId}:${c.caminho}`,
    titulo: `Leiaute ${decodeURIComponent(new URL(c.url).pathname.split('/').at(-1) ?? '')} — ${c.arquivo}`,
    texto: `Campo ${c.nome}${c.versao === null ? '' : ` (leiaute versão ${c.versao})`}. Caminho: ${c.caminho}. Tipo: ${c.tipo ?? 'não declarado'}. Ocorrências: mínimo ${c.minOcorrencias}, máximo ${c.maxOcorrencias}.${c.descricao === null ? '' : ` Descrição: ${c.descricao}`}`,
    secao: c.caminho,
    paginaIni: null,
    paginaFim: null,
    url: c.url,
    fonteId: c.fonteId,
    documentoId: c.documentoId,
    snapshotId: c.snapshotId,
    sha256: c.sha256,
    coletadoEm: c.coletadoEm,
    confirmadoEm: c.coletadoEm,
    documentoIndisponivel: false,
  };
}

function grafoEFatos(fatos: ConsultasFatos, hoje: string): Pick<DependenciasPipeline, 'buscarFatos' | 'situacaoNormativa'> {
  return {
    buscarFatos: async (consulta, limite) =>
      (await fatos.listarFatos({ consulta, limite })).map((f) => {
        const ev = evidenciaDeArquivada(f.evidencia);
        return { ...ev, titulo: `Fato aprovado pela curadoria: ${f.enunciado} — ${ev.titulo}` };
      }),
    situacaoNormativa: async (ids): Promise<SituacaoNormativa> => {
      const revogadoPor = new Map<string, string>();
      const evidenciasDosAtos = [];
      for (const r of await fatos.relacoesDosDocumentos(ids)) {
        // invariant: só revogação aprovada e já em efeito marca o ato como revogado; a futura ("a partir de 2033") não.
        if (r.tipo !== 'revoga' || r.destinoDocumentoId === null || !ids.includes(r.destinoDocumentoId)) continue;
        if (r.efeitoEm !== null && r.efeitoEm > hoje) continue;
        revogadoPor.set(r.destinoDocumentoId, r.origemTitulo ?? r.origemUrl);
        evidenciasDosAtos.push(evidenciaDeArquivada(r.evidencia));
      }
      return { revogadoPor, evidenciasDosAtos };
    },
  };
}

function inicioDoDiaUtc(agora: Date): Date {
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
}

/**
 * invariant: cota mensal do tipo pedido, orçamento do cliente e disjuntor global são conferidos antes de qualquer
 * chamada ao modelo. Pergunta e verificação têm cotas próprias no plano; o orçamento em dólar é um só.
 */
export async function conferirCotas(
  clientes: RepositorioClientes,
  clienteId: string,
  momento: Date,
  orcamentoDiarioUsd: number,
  tipo: 'pergunta' | 'verificacao' = 'pergunta',
): Promise<void> {
  const uso = await clientes.usoMensal(clienteId, momento);
  if (uso === undefined) throw new ErroCota('cliente-inativo');
  const esgotada = tipo === 'pergunta' ? uso.perguntas >= uso.cotaMensalPerguntas : uso.verificacoes >= uso.cotaMensalVerificacoes;
  if (esgotada) throw new ErroCota('cota-mensal');
  if (uso.gastoUsd >= uso.orcamentoMensalUsd) throw new ErroCota('orcamento-cliente');
  if ((await clientes.gastoGlobalDesde(inicioDoDiaUtc(momento))) >= orcamentoDiarioUsd) throw new ErroCota('orcamento-global');
}

/**
 * Pergunta com cotas, disjuntor de gasto e registro (SEGURANCA.md §11 e §13). Usado pela API e pelo MCP,
 * para que os dois canais tenham exatamente as mesmas regras.
 *
 * hazard: cota e orçamento são conferidos antes da chamada; perguntas simultâneas podem passar do limite
 * por no máximo o número de requisições em voo (o limite por minuto da chave segura esse número).
 */
export function criarServicoPerguntas(deps: DependenciasServico): ServicoPerguntas {
  const agora = deps.agora ?? (() => new Date());
  return {
    async responder(solicitante, pergunta) {
      const inicio = performance.now();
      const momento = agora();
      await conferirCotas(deps.clientes, solicitante.clienteId, momento, deps.orcamentoDiarioUsd);

      const resultado = await responderPergunta(pergunta, {
        modelo: deps.modelo,
        fontes: deps.fontes,
        agora: () => momento,
        buscarTrechos: async (consulta, limite) => (await deps.conhecimento.buscarTrechos({ consulta, limite })).map(evidenciaDeTrecho),
        buscarCodigos: async (codigos) =>
          (await Promise.all(codigos.map((c) => deps.conhecimento.consultarReferencia(null, c, 3)))).flat().slice(0, 6).map(evidenciaDeLinha),
        buscarCampos: async (nomes) =>
          (await Promise.all(nomes.map((n) => deps.conhecimento.buscarCampos(n, 2)))).flat().slice(0, 6).map(evidenciaDeCampo),
        ...(deps.fatos === undefined ? {} : grafoEFatos(deps.fatos, dataIsoBrasil(momento))),
      });

      const id = await deps.clientes.registrarConsulta(solicitante.clienteId, solicitante.chaveId, {
        canal: solicitante.canal,
        rota: resultado.resposta.rota,
        situacao: resultado.resposta.situacao,
        pergunta: resultado.perguntaMinimizada,
        resposta: resultado.resposta,
        trechos: resultado.evidenciasCitadas.filter((e) => e.tipo === 'trecho' && UUID.test(e.id)).map((e) => e.id),
        modelo: resultado.uso?.modelo ?? null,
        tokensEntrada: (resultado.uso?.tokensEntrada ?? 0) + (resultado.uso?.tokensCacheLeitura ?? 0) + (resultado.uso?.tokensCacheEscrita ?? 0),
        tokensSaida: resultado.uso?.tokensSaida ?? 0,
        custoUsd: resultado.custoUsd,
        latenciaMs: Math.round(performance.now() - inicio),
      });
      return { id, resposta: resultado.resposta };
    },
    obter: (clienteId, id) => deps.clientes.obterConsulta(clienteId, id),
  };
}
