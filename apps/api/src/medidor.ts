import type { ContagemRequisicoes } from '@lastro/db';

const MAX_PENDENTES = 50_000;

/**
 * why: medir cada requisição com um UPDATE no banco dobraria a carga da API; a contagem fica em memória por
 * cliente e dia (UTC) e vai para `uso_diario` em lote.
 *
 * hazard: se o processo cair entre dois lotes, as requisições desse intervalo não entram na medição (subcontagem
 * limitada ao intervalo). Perguntas e verificações não dependem disto: são medidas no banco, na mesma transação.
 */
export class MedidorUso {
  private contagens = new Map<string, number>();
  private readonly gravar: (contagens: ContagemRequisicoes[]) => Promise<void>;
  private readonly agora: () => Date;

  constructor(gravar: (contagens: ContagemRequisicoes[]) => Promise<void>, agora: () => Date = () => new Date()) {
    this.gravar = gravar;
    this.agora = agora;
  }

  contar(clienteId: string): void {
    const chave = `${clienteId}|${this.agora().toISOString().slice(0, 10)}`;
    const atual = this.contagens.get(chave);
    // invariant: memória limitada; com o banco fora do ar por muito tempo, clientes novos deixam de ser contados.
    if (atual === undefined && this.contagens.size >= MAX_PENDENTES) return;
    this.contagens.set(chave, (atual ?? 0) + 1);
  }

  async descarregar(): Promise<void> {
    if (this.contagens.size === 0) return;
    const lote = this.contagens;
    this.contagens = new Map();
    const itens = [...lote].map(([chave, quantidade]) => {
      const [clienteId = '', dia = ''] = chave.split('|');
      return { clienteId, dia, quantidade };
    });
    try {
      await this.gravar(itens);
    } catch (erro) {
      // why: o lote volta para a fila e é somado ao próximo; nada é perdido por uma falha passageira do banco.
      for (const [chave, n] of lote) {
        if (this.contagens.size >= MAX_PENDENTES && !this.contagens.has(chave)) continue;
        this.contagens.set(chave, (this.contagens.get(chave) ?? 0) + n);
      }
      throw erro;
    }
  }
}
