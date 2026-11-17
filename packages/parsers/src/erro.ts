export class ErroParser extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroParser';
  }
}

// invariant: mudar a saída de qualquer extrator exige subir esta versão, para reprocessar os snapshots.
export const VERSAO_EXTRATOR = '1';
