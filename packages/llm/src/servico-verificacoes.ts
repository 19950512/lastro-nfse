import type { Fonte } from '@lastro/core';
import type { ConsultasConhecimento, ConsultasFatos, RepositorioClientes, RepositorioVerificacoes } from '@lastro/db';
import type { ClienteModelo } from './modelo.ts';
import { conferirCotas, evidenciaDeTrecho, type Solicitante } from './servico.ts';
import { verificarAlegacoes, type ResultadoVerificacao } from './verificacao.ts';

/** Fato ou relação usado na verificação que a curadoria revogou ou substituiu depois (recall, SEGURANCA.md §13). */
export interface Correcao {
  readonly tipo: 'fato' | 'relacao';
  readonly id: string;
  readonly descricao: string;
  readonly situacao: 'revogado' | 'superado';
}

export interface VerificacaoRegistrada {
  readonly id: string;
  readonly criadaEm: string;
  readonly expiraEm: string;
  readonly resultado: ResultadoVerificacao;
}

export interface VerificacaoConsultada {
  readonly id: string;
  readonly criadaEm: string;
  readonly expiraEm: string;
  /** Payload gravado; a API valida o formato antes de devolver. */
  readonly resultado: unknown;
  readonly correcoes: readonly Correcao[];
  readonly compartilhada: boolean;
}

export interface ServicoVerificacoes {
  verificar(solicitante: Solicitante, texto: string, opcoes?: { dataConteudo?: string | undefined }): Promise<VerificacaoRegistrada>;
  obter(clienteId: string, id: string): Promise<VerificacaoConsultada | undefined>;
  compartilhar(clienteId: string, id: string): Promise<string | undefined>;
  revogarCompartilhamento(clienteId: string, id: string): Promise<boolean>;
  obterCompartilhada(token: string): Promise<Omit<VerificacaoConsultada, 'compartilhada'> | undefined>;
}

export interface DependenciasServicoVerificacoes {
  readonly clientes: RepositorioClientes;
  readonly verificacoes: RepositorioVerificacoes;
  readonly conhecimento: ConsultasConhecimento;
  readonly fatos: ConsultasFatos;
  readonly modelo: ClienteModelo;
  readonly fontes: readonly Fonte[];
  readonly orcamentoDiarioUsd: number;
  readonly agora?: () => Date;
}

export function criarServicoVerificacoes(deps: DependenciasServicoVerificacoes): ServicoVerificacoes {
  const agora = deps.agora ?? (() => new Date());

  async function correcoes(fatos: readonly string[], relacoes: readonly string[]): Promise<Correcao[]> {
    const [f, r] = await Promise.all([deps.fatos.obterFatos(fatos), deps.fatos.obterRelacoes(relacoes)]);
    return [
      ...f.flatMap((x): Correcao[] => (x.situacao === 'aprovado' ? [] : [{ tipo: 'fato', id: x.id, descricao: x.enunciado, situacao: x.situacao }])),
      ...r.flatMap((x): Correcao[] => (x.situacao === 'revogado' ? [{ tipo: 'relacao', id: x.id, descricao: `${x.tipo} ${x.destinoDescricao}`, situacao: 'revogado' }] : [])),
    ];
  }

  return {
    async verificar(solicitante, texto, opcoes = {}) {
      const inicio = performance.now();
      const momento = agora();
      await conferirCotas(deps.clientes, solicitante.clienteId, momento, deps.orcamentoDiarioUsd, 'verificacao');
      const r = await verificarAlegacoes(texto, {
        modelo: deps.modelo,
        fontes: deps.fontes,
        agora: () => momento,
        buscarTrechos: async (consulta, limite) => (await deps.conhecimento.buscarTrechos({ consulta, limite })).map(evidenciaDeTrecho),
        buscarFatos: (consulta, limite) => deps.fatos.listarFatos({ consulta, limite }),
        relacoesDosDocumentos: (ids) => deps.fatos.relacoesDosDocumentos(ids),
      }, opcoes);
      const salva = await deps.verificacoes.registrar(solicitante.clienteId, solicitante.chaveId, {
        canal: solicitante.canal,
        entrada: r.entradaMinimizada,
        resultado: r.resultado,
        fatos: r.fatos,
        relacoes: r.relacoes,
        trechos: r.trechos,
      });
      const entrada = r.usos.reduce((s, u) => s + u.tokensEntrada + u.tokensCacheLeitura + u.tokensCacheEscrita, 0);
      // invariant: o custo entra em consulta_log, onde valem a cota mensal, o orçamento do cliente e o disjuntor global.
      await deps.clientes.registrarConsulta(solicitante.clienteId, solicitante.chaveId, {
        canal: solicitante.canal,
        rota: 'verificacao',
        situacao: r.resultado.situacao,
        pergunta: `verificação ${salva.id}`,
        resposta: { verificacao_id: salva.id },
        trechos: r.trechos,
        modelo: r.usos.at(-1)?.modelo ?? null,
        tokensEntrada: entrada,
        tokensSaida: r.usos.reduce((s, u) => s + u.tokensSaida, 0),
        custoUsd: r.custoUsd,
        latenciaMs: Math.round(performance.now() - inicio),
      });
      return { ...salva, resultado: r.resultado };
    },

    async obter(clienteId, id) {
      const v = await deps.verificacoes.obter(clienteId, id);
      if (v === undefined) return undefined;
      return { id: v.id, criadaEm: v.criadaEm, expiraEm: v.expiraEm, resultado: v.resultado, compartilhada: v.compartilhada, correcoes: await correcoes(v.fatos, v.relacoes) };
    },

    compartilhar: (clienteId, id) => deps.verificacoes.compartilhar(clienteId, id),
    revogarCompartilhamento: (clienteId, id) => deps.verificacoes.revogarCompartilhamento(clienteId, id),

    async obterCompartilhada(token) {
      const v = await deps.verificacoes.obterCompartilhada(token);
      if (v === undefined) return undefined;
      return { id: v.id, criadaEm: v.criadaEm, expiraEm: v.expiraEm, resultado: v.resultado, correcoes: await correcoes(v.fatos, v.relacoes) };
    },
  };
}
