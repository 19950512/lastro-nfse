import type { ArquivoVersionado } from '@lastro/ingest';
import pg from 'pg';
import { ArquivoPostgres } from './arquivo-postgres.ts';
import { configBanco, configS3 } from './config.ts';
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

export async function prepararInfra(ambiente: NodeJS.ProcessEnv = process.env): Promise<{ migracoes: string[] }> {
  const migracoes = await prepararBanco(configBanco('admin', ambiente), {
    coletor: String(configBanco('coletor', ambiente).password),
    leitor: String(configBanco('leitor', ambiente).password),
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
