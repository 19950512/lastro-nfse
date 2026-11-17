import type { Rota } from './roteador.ts';

/** Um item que pode ser citado: trecho de documento, linha de tabela oficial ou campo do leiaute. */
export interface Evidencia {
  readonly tipo: 'trecho' | 'linha-tabela' | 'campo-leiaute';
  readonly id: string;
  readonly titulo: string;
  readonly texto: string;
  readonly secao: string | null;
  readonly paginaIni: number | null;
  readonly paginaFim: number | null;
  readonly url: string;
  readonly fonteId: string;
  readonly documentoId: string;
  readonly snapshotId: string;
  readonly sha256: string;
  readonly coletadoEm: string;
  readonly confirmadoEm: string;
  readonly documentoIndisponivel: boolean;
  /** Ato que revogou o documento (relação aprovada no grafo, com efeito já iniciado); ausente se vigente. */
  readonly revogadoPor?: string | null;
}

export type SituacaoResposta = 'respondida' | 'sem-resposta' | 'fora-do-escopo' | 'rejeitada';

export interface FonteCitada {
  readonly id: number;
  readonly titulo: string;
  readonly orgao: string;
  readonly nivel: 'N1' | 'N2' | 'N3';
  readonly url: string;
  readonly secao: string | null;
  readonly pagina: number | null;
  readonly trecho: string;
  readonly coletado_em: string;
  readonly confirmado_em: string;
  readonly sha256: string;
  readonly snapshot_id: string;
  readonly documento_id: string;
  readonly original: string;
}

/** Formato da resposta (ARQUITETURA.md §2.8). */
export interface RespostaPergunta {
  readonly situacao: SituacaoResposta;
  readonly rota: Rota;
  readonly resposta: string;
  readonly posicao_em: string;
  readonly fontes: readonly FonteCitada[];
  readonly avisos: readonly string[];
  readonly limites: readonly string[];
  readonly aviso: string;
  readonly checagem: {
    readonly citacoes_invalidas: number;
    readonly frases_sem_citacao_removidas: number;
    readonly conteudo_removido: number;
  };
}
