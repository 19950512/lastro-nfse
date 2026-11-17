import type { ArquivoVersionado } from '@lastro/ingest';
import pg from 'pg';
import { ArquivoPostgres } from './arquivo-postgres.ts';
import { configBanco, configS3, type Papel } from './config.ts';
import { ConsultasPostgres, type ConsultasArquivo } from './consultas.ts';
import { prepararBanco } from './migrar.ts';
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

export function abrirPool(papel: Papel, ambiente: NodeJS.ProcessEnv = process.env): pg.Pool {
  return new pg.Pool(configBanco(papel, ambiente));
}

export async function prepararInfra(ambiente: NodeJS.ProcessEnv = process.env): Promise<{ migracoes: string[] }> {
  const migracoes = await prepararBanco(configBanco('admin', ambiente), {
    coletor: String(configBanco('coletor', ambiente).password),
    leitor: String(configBanco('leitor', ambiente).password),
    notificador: String(configBanco('notificador', ambiente).password),
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
