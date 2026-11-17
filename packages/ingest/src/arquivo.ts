import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verificarOrigem } from '@lastro/core';
import { sha256 } from './http.ts';

export interface RegistroSnapshot {
  readonly id: string;
  readonly fonteId: string;
  readonly url: string;
  readonly urlFinal: string;
  readonly coletadoEm: string;
  readonly sha256: string;
  /** why: HTML oficial muda bytes sem mudar conteúdo; a detecção de mudança compara este campo (impressao.ts). */
  readonly impressao: string;
  readonly bytes: number;
  readonly mime: string;
  readonly etag: string | null;
  readonly ultimaModificacao: string | null;
}

export interface NovoSnapshot {
  readonly fonteId: string;
  readonly url: string;
  readonly urlFinal: string;
  readonly mime: string;
  readonly etag: string | null;
  readonly ultimaModificacao: string | null;
  readonly corpo: Buffer;
  readonly sha256: string;
  readonly impressao: string;
}

export type TipoEvento = 'documento-novo' | 'nova-versao' | 'link-removido';

export interface EventoMudanca {
  readonly id: string;
  readonly tipo: TipoEvento;
  readonly fonteId: string;
  readonly url: string;
  readonly snapshotAnterior: string | null;
  readonly snapshotNovo: string | null;
  readonly detectadoEm: string;
  readonly resumo: string;
}

export interface RegistroVerificacao {
  readonly url: string;
  readonly sha256: string;
  readonly verificadoEm: string;
}

/**
 * Arquivo versionado de snapshots (ARQUITETURA.md §2.1).
 * A implementação em disco serve para desenvolvimento e para a Fase 0; a Fase 1 troca por
 * Postgres + storage S3 com bloqueio WORM, mantendo esta interface.
 */
export interface ArquivoVersionado {
  ultimoSnapshot(url: string): Promise<RegistroSnapshot | undefined>;
  gravarSnapshot(novo: NovoSnapshot, agora: Date): Promise<RegistroSnapshot>;
  lerConteudo(sha: string): Promise<Buffer>;
  registrarVerificacao(registro: RegistroVerificacao): Promise<void>;
  registrarEvento(evento: Omit<EventoMudanca, 'id'>): Promise<EventoMudanca>;
  listarEventos(desde?: Date): Promise<EventoMudanca[]>;
}

export class ErroArquivo extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroArquivo';
  }
}

const SHA_VALIDO = /^[0-9a-f]{64}$/;

async function lerLinhas<T>(caminho: string): Promise<T[]> {
  let texto: string;
  try {
    texto = await readFile(caminho, 'utf8');
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw erro;
  }
  return texto
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

/**
 * Armazenamento em disco: objetos endereçados por SHA-256 + registros NDJSON só de acréscimo.
 *
 * invariant: nada é sobrescrito nem apagado. Objetos são criados com `wx` (falha se existir) e
 * somente leitura; registros só recebem `append`.
 * hazard: um único processo por diretório; a fila interna não protege contra dois processos
 * gravando ao mesmo tempo.
 */
export class ArquivoEmDisco implements ArquivoVersionado {
  private readonly raiz: string;
  private indice: Map<string, RegistroSnapshot> | undefined;
  private fila: Promise<unknown> = Promise.resolve();

  constructor(raiz: string) {
    this.raiz = raiz;
  }

  private get caminhoSnapshots(): string {
    return join(this.raiz, 'snapshots.ndjson');
  }

  private get caminhoEventos(): string {
    return join(this.raiz, 'eventos.ndjson');
  }

  private get caminhoVerificacoes(): string {
    return join(this.raiz, 'verificacoes.ndjson');
  }

  private caminhoObjeto(sha: string): string {
    if (!SHA_VALIDO.test(sha)) throw new ErroArquivo(`sha256 inválido: ${sha}`);
    return join(this.raiz, 'objetos', sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  private emSerie<T>(tarefa: () => Promise<T>): Promise<T> {
    const resultado = this.fila.then(tarefa, tarefa);
    this.fila = resultado.catch(() => undefined);
    return resultado;
  }

  private async carregarIndice(): Promise<Map<string, RegistroSnapshot>> {
    if (this.indice === undefined) {
      const indice = new Map<string, RegistroSnapshot>();
      for (const registro of await lerLinhas<RegistroSnapshot>(this.caminhoSnapshots)) indice.set(registro.url, registro);
      this.indice = indice;
    }
    return this.indice;
  }

  async ultimoSnapshot(url: string): Promise<RegistroSnapshot | undefined> {
    return (await this.carregarIndice()).get(url);
  }

  gravarSnapshot(novo: NovoSnapshot, agora: Date): Promise<RegistroSnapshot> {
    return this.emSerie(async () => {
      // invariant: segunda barreira de origem (SEGURANCA.md §3, defesa em profundidade). O coletor
      // já validou, mas nada entra no arquivo sem passar de novo pela lista oficial.
      for (const url of [novo.url, novo.urlFinal]) {
        const origem = verificarOrigem(url);
        if (!origem.permitido) throw new ErroArquivo(`snapshot recusado: ${origem.motivo}`);
      }
      const calculado = sha256(novo.corpo);
      if (calculado !== novo.sha256) throw new ErroArquivo(`hash divergente para ${novo.url}`);

      await this.gravarObjeto(calculado, novo.corpo);

      const registro: RegistroSnapshot = {
        id: randomUUID(),
        fonteId: novo.fonteId,
        url: novo.url,
        urlFinal: novo.urlFinal,
        coletadoEm: agora.toISOString(),
        sha256: calculado,
        impressao: novo.impressao,
        bytes: novo.corpo.byteLength,
        mime: novo.mime,
        etag: novo.etag,
        ultimaModificacao: novo.ultimaModificacao,
      };
      await mkdir(this.raiz, { recursive: true });
      await appendFile(this.caminhoSnapshots, `${JSON.stringify(registro)}\n`, { flag: 'a' });
      (await this.carregarIndice()).set(registro.url, registro);
      return registro;
    });
  }

  private async gravarObjeto(sha: string, corpo: Buffer): Promise<void> {
    const caminho = this.caminhoObjeto(sha);
    await mkdir(dirname(caminho), { recursive: true });
    try {
      await writeFile(caminho, corpo, { flag: 'wx', mode: 0o444 });
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code !== 'EEXIST') throw erro;
      await this.lerConteudo(sha);
    }
  }

  async lerConteudo(sha: string): Promise<Buffer> {
    // invariant: o conteúdo é conferido contra o hash a cada leitura; objeto adulterado gera erro.
    const corpo = await readFile(this.caminhoObjeto(sha));
    if (sha256(corpo) !== sha) throw new ErroArquivo(`objeto ${sha} adulterado ou corrompido`);
    return corpo;
  }

  registrarVerificacao(registro: RegistroVerificacao): Promise<void> {
    return this.emSerie(async () => {
      await mkdir(this.raiz, { recursive: true });
      await appendFile(this.caminhoVerificacoes, `${JSON.stringify(registro)}\n`, { flag: 'a' });
    });
  }

  registrarEvento(evento: Omit<EventoMudanca, 'id'>): Promise<EventoMudanca> {
    return this.emSerie(async () => {
      const completo: EventoMudanca = { id: randomUUID(), ...evento };
      await mkdir(this.raiz, { recursive: true });
      await appendFile(this.caminhoEventos, `${JSON.stringify(completo)}\n`, { flag: 'a' });
      return completo;
    });
  }

  async listarEventos(desde?: Date): Promise<EventoMudanca[]> {
    const eventos = await lerLinhas<EventoMudanca>(this.caminhoEventos);
    if (desde === undefined) return eventos;
    return eventos.filter((e) => new Date(e.detectadoEm) >= desde);
  }
}
