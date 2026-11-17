import type { ArquivoVersionado } from '@lastro/ingest';
import pg from 'pg';
import { ArquivoPostgres } from './arquivo-postgres.ts';
import { configBanco, configS3, type Papel } from './config.ts';
import { ClientesPostgres, retencaoConsultasDias, type RepositorioClientes } from './clientes.ts';
import { ConhecimentoPostgres, type ConsultasConhecimento } from './conhecimento.ts';
import { CuradoriaPostgres, type RepositorioCuradoria } from './curadoria.ts';
import { FatosPostgres, type ConsultasFatos } from './fatos.ts';
import { IssPostgres, type ConsultasIss } from './iss.ts';
import { processarNormasPorRegras, type ResumoNormativo } from './normativo.ts';
import { VerificacoesPostgres, type RepositorioVerificacoes } from './verificacoes.ts';
import { ConsultasPostgres, type ConsultasArquivo } from './consultas.ts';
import { prepararBanco } from './migrar.ts';
import { processarPendentes, type ResultadoProcessamento } from './processamento.ts';
import { StorageWorm } from './storage.ts';

export interface ArquivoAberto {
  readonly arquivo: ArquivoVersionado;
  fechar(): Promise<void>;
}

/**
 * Abre o arquivo com o papel de banco mínimo para a tarefa: `coletor` (lê e insere) ou `leitor` (só lê).
 *
 * invariant: o coletor só começa se o bucket estiver com Object Lock COMPLIANCE (falha fechada).
 */
export async function abrirArquivoPostgres(
  papel: 'coletor' | 'leitor',
  ambiente: NodeJS.ProcessEnv = process.env,
): Promise<ArquivoAberto> {
  const storage = StorageWorm.criar(configS3(ambiente));
  const pool = new pg.Pool(configBanco(papel, ambiente));
  try {
    if (papel === 'coletor') await storage.verificarWorm();
    await pool.query('SELECT 1');
  } catch (erro) {
    await pool.end();
    storage.destruir();
    throw erro;
  }
  return {
    arquivo: new ArquivoPostgres(pool, storage),
    fechar: async () => {
      await pool.end();
      storage.destruir();
    },
  };
}

export interface ConsultasAbertas {
  readonly consultas: ConsultasArquivo;
  readonly pool: pg.Pool;
  readonly lerOriginal: (sha: string) => Promise<Buffer>;
  fechar(): Promise<void>;
}

export async function abrirConsultas(ambiente: NodeJS.ProcessEnv = process.env): Promise<ConsultasAbertas> {
  const storage = StorageWorm.criar(configS3(ambiente));
  const pool = new pg.Pool(configBanco('leitor', ambiente));
  try {
    await pool.query('SELECT 1');
  } catch (erro) {
    await pool.end();
    storage.destruir();
    throw erro;
  }
  return {
    consultas: new ConsultasPostgres(pool),
    pool,
    lerOriginal: (sha) => storage.ler(sha),
    fechar: async () => {
      await pool.end();
      storage.destruir();
    },
  };
}

export interface ApiAberta {
  readonly consultas: ConsultasArquivo;
  readonly conhecimento: ConsultasConhecimento;
  readonly clientes: RepositorioClientes;
  readonly fatos: ConsultasFatos;
  readonly verificacoes: RepositorioVerificacoes;
  readonly iss: ConsultasIss;
  readonly lerOriginal: (sha: string) => Promise<Buffer>;
  /** why: repositórios de outros pacotes (alertas em @lastro/webhooks) usam o mesmo pool e papel. */
  readonly pool: pg.Pool;
  fechar(): Promise<void>;
}

/** Abre o banco com o papel `lastro_api`: lê arquivo e conhecimento, autentica chaves e registra consultas (RLS). */
export async function abrirApi(ambiente: NodeJS.ProcessEnv = process.env): Promise<ApiAberta> {
  const retencao = retencaoConsultasDias(ambiente);
  const storage = StorageWorm.criar(configS3(ambiente));
  const pool = new pg.Pool(configBanco('api', ambiente));
  try {
    await pool.query('SELECT 1');
  } catch (erro) {
    await pool.end();
    storage.destruir();
    throw erro;
  }
  return {
    consultas: new ConsultasPostgres(pool),
    conhecimento: new ConhecimentoPostgres(pool),
    clientes: new ClientesPostgres(pool, retencao),
    fatos: new FatosPostgres(pool),
    verificacoes: new VerificacoesPostgres(pool, retencao),
    iss: new IssPostgres(pool),
    lerOriginal: (sha) => storage.ler(sha),
    pool,
    fechar: async () => {
      await pool.end();
      storage.destruir();
    },
  };
}

export async function processarComPapel(
  opcoes: { limite: number; aoProcessar?: (r: ResultadoProcessamento) => void },
  ambiente: NodeJS.ProcessEnv = process.env,
): Promise<ResultadoProcessamento[]> {
  const storage = StorageWorm.criar(configS3(ambiente));
  const pool = new pg.Pool(configBanco('processador', ambiente));
  try {
    return await processarPendentes({ pool, lerOriginal: (sha) => storage.ler(sha) }, opcoes);
  } finally {
    await pool.end();
    storage.destruir();
  }
}

/** Grafo normativo por regras (sem LLM), com o papel `lastro_processador`: só propõe, nunca aprova. */
export async function processarNormasComPapel(
  opcoes: { limite: number; aoProcessar?: (r: ResumoNormativo) => void },
  ambiente: NodeJS.ProcessEnv = process.env,
): Promise<ResumoNormativo[]> {
  const pool = new pg.Pool(configBanco('processador', ambiente));
  try {
    return await processarNormasPorRegras(pool, opcoes);
  } finally {
    await pool.end();
  }
}

export interface CuradoriaAberta {
  readonly curadoria: RepositorioCuradoria;
  fechar(): Promise<void>;
}

/** Painel de curadoria com o papel `lastro_curadoria` (sem UPDATE nem DELETE em fatos, relações e decisões). */
export async function abrirCuradoria(ambiente: NodeJS.ProcessEnv = process.env): Promise<CuradoriaAberta> {
  const pool = new pg.Pool(configBanco('curadoria', ambiente));
  try {
    await pool.query('SELECT 1');
  } catch (erro) {
    await pool.end();
    throw erro;
  }
  return { curadoria: new CuradoriaPostgres(pool), fechar: () => pool.end() };
}

export function abrirPool(papel: Papel, ambiente: NodeJS.ProcessEnv = process.env): pg.Pool {
  return new pg.Pool(configBanco(papel, ambiente));
}

export async function prepararInfra(ambiente: NodeJS.ProcessEnv = process.env): Promise<{ migracoes: string[] }> {
  const migracoes = await prepararBanco(configBanco('admin', ambiente), {
    coletor: String(configBanco('coletor', ambiente).password),
    leitor: String(configBanco('leitor', ambiente).password),
    notificador: String(configBanco('notificador', ambiente).password),
    processador: String(configBanco('processador', ambiente).password),
    api: String(configBanco('api', ambiente).password),
    curadoria: String(configBanco('curadoria', ambiente).password),
  });
  const s3 = configS3(ambiente);
  const storage = StorageWorm.criar(s3);
  try {
    await storage.preparar(s3.retencaoDias);
  } finally {
    storage.destruir();
  }
  return { migracoes };
}
