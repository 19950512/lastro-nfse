import type { TipoEvento } from '@lastro/ingest';
import type pg from 'pg';
import { assinar, CABECALHO_ASSINATURA } from './assinatura.ts';
import type { Enviador } from './envio.ts';
import { montarCorpo, type FormatoWebhook } from './payload.ts';

// why: espera crescente entre tentativas (SEGURANCA.md §9); cobre de uma queda curta a um dia fora do ar.
export const ESPERAS_SEGUNDOS = [60, 300, 1_800, 7_200, 43_200];
export const MAX_TENTATIVAS = ESPERAS_SEGUNDOS.length + 1;
export const FALHAS_PARA_DESATIVAR = 20;

// why: chave fixa do advisory lock; dois despachos simultâneos enviariam o mesmo evento duas vezes.
const TRAVA_DESPACHO = 7_212_027;

export interface ResultadoDespacho {
  readonly enfileiradas: number;
  readonly entregues: number;
  readonly falhas: number;
  readonly desistencias: number;
  readonly desativadas: number;
  readonly emAndamento: boolean;
}

export interface OpcoesDespacho {
  readonly urlPublicaApi: string;
  readonly agora?: () => Date;
  readonly lote?: number;
}

interface LinhaPendente {
  assinatura_id: string;
  evento_id: string;
  tentativas: number;
  url: string;
  formato: FormatoWebhook;
  segredo: string;
  tipo: TipoEvento;
  fonte_id: string;
  documento_id: string;
  doc_url: string;
  detectado_em: Date;
  anomalia: string | null;
}

export async function despachar(pool: pg.Pool, enviar: Enviador, opcoes: OpcoesDespacho): Promise<ResultadoDespacho> {
  const agora = opcoes.agora ?? (() => new Date());
  const cliente = await pool.connect();
  const resultado = { enfileiradas: 0, entregues: 0, falhas: 0, desistencias: 0, desativadas: 0, emAndamento: false };
  try {
    const trava = await cliente.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [TRAVA_DESPACHO]);
    if (trava.rows[0]?.ok !== true) return { ...resultado, emAndamento: true };
    try {
      // invariant: só eventos detectados depois do cadastro; um assinante novo não recebe o histórico inteiro.
      const fila = await cliente.query(
        `INSERT INTO webhook_entrega (assinatura_id, evento_id, situacao, proxima_tentativa)
         SELECT a.id, e.id, 'pendente', $1
           FROM webhook_assinatura a
           JOIN evento_mudanca e ON e.detectado_em >= a.criada_em
                                 AND (a.fontes IS NULL OR e.fonte_id = ANY (a.fontes))
                                 AND (a.tipos IS NULL OR e.tipo = ANY (a.tipos))
          WHERE a.ativa
         ON CONFLICT DO NOTHING`,
        [agora()],
      );
      resultado.enfileiradas = fila.rowCount ?? 0;

      const pendentes = await cliente.query<LinhaPendente>(
        `SELECT w.assinatura_id, w.evento_id, w.tentativas, a.url, a.formato, a.segredo,
                e.tipo, e.fonte_id, e.documento_id, d.url AS doc_url, e.detectado_em, e.anomalia
           FROM webhook_entrega w
           JOIN webhook_assinatura a ON a.id = w.assinatura_id
           JOIN evento_mudanca e ON e.id = w.evento_id
           JOIN documento d ON d.id = e.documento_id
          WHERE w.situacao = 'pendente' AND w.proxima_tentativa <= $1 AND a.ativa
          ORDER BY e.detectado_em, e.id
          LIMIT $2`,
        [agora(), opcoes.lote ?? 500],
      );

      const desativadas = new Set<string>();
      for (const p of pendentes.rows) {
        if (desativadas.has(p.assinatura_id)) continue;
        const corpo = montarCorpo(
          {
            id: p.evento_id,
            tipo: p.tipo,
            fonteId: p.fonte_id,
            documentoId: p.documento_id,
            url: p.doc_url,
            detectadoEm: p.detectado_em.toISOString(),
            anomalia: p.anomalia,
          },
          p.formato,
          opcoes.urlPublicaApi,
        );
        const envio = await enviar(p.url, corpo, {
          [CABECALHO_ASSINATURA]: assinar(p.segredo, corpo, agora()),
          'lastro-evento': p.evento_id,
        });
        const tentativas = p.tentativas + 1;

        if (envio.ok) {
          resultado.entregues++;
          await cliente.query(
            `UPDATE webhook_entrega SET situacao = 'entregue', tentativas = $3, ultimo_status = $4, ultimo_erro = NULL, entregue_em = $5
              WHERE assinatura_id = $1 AND evento_id = $2`,
            [p.assinatura_id, p.evento_id, tentativas, envio.status, agora()],
          );
          await cliente.query('UPDATE webhook_assinatura SET falhas_consecutivas = 0 WHERE id = $1', [p.assinatura_id]);
          continue;
        }

        resultado.falhas++;
        const desistir = tentativas >= MAX_TENTATIVAS;
        if (desistir) resultado.desistencias++;
        const espera = ESPERAS_SEGUNDOS[Math.min(tentativas - 1, ESPERAS_SEGUNDOS.length - 1)] ?? 60;
        await cliente.query(
          `UPDATE webhook_entrega
              SET situacao = $3, tentativas = $4, ultimo_status = $5, ultimo_erro = $6, proxima_tentativa = $7
            WHERE assinatura_id = $1 AND evento_id = $2`,
          [
            p.assinatura_id,
            p.evento_id,
            desistir ? 'falhou' : 'pendente',
            tentativas,
            envio.status,
            envio.erro,
            new Date(agora().getTime() + espera * 1000),
          ],
        );
        const contagem = await cliente.query<{ falhas_consecutivas: number }>(
          'UPDATE webhook_assinatura SET falhas_consecutivas = falhas_consecutivas + 1 WHERE id = $1 RETURNING falhas_consecutivas',
          [p.assinatura_id],
        );
        if ((contagem.rows[0]?.falhas_consecutivas ?? 0) >= FALHAS_PARA_DESATIVAR) {
          await cliente.query(
            `UPDATE webhook_assinatura SET ativa = false, desativada_em = $2, motivo_desativacao = $3 WHERE id = $1 AND ativa`,
            [p.assinatura_id, agora(), `${String(FALHAS_PARA_DESATIVAR)} falhas seguidas; última: ${envio.erro ?? '?'}`],
          );
          desativadas.add(p.assinatura_id);
          resultado.desativadas++;
        }
      }
    } finally {
      await cliente.query('SELECT pg_advisory_unlock($1)', [TRAVA_DESPACHO]);
    }
  } finally {
    cliente.release();
  }
  return resultado;
}
