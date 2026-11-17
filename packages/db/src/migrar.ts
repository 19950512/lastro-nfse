import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export const DIRETORIO_MIGRACOES = join(import.meta.dirname, '..', 'migracoes');

// why: chave fixa do advisory lock; duas execuções simultâneas de `preparar` não aplicam a mesma migração.
const TRAVA_MIGRACAO = 7_212_026;

export interface SenhasPapeis {
  readonly coletor: string;
  readonly leitor: string;
  readonly notificador: string;
}

/**
 * Cria os papéis mínimos, aplica as migrações pendentes e define as senhas.
 *
 * As tabelas do arquivo aceitam só inserção em duas camadas (SEGURANCA.md §8): privilégios
 * (o coletor tem SELECT + INSERT; o leitor da API, SELECT) e triggers que recusam UPDATE, DELETE e
 * TRUNCATE até para o dono das tabelas.
 */
export async function prepararBanco(
  admin: pg.ClientConfig,
  senhas: SenhasPapeis,
  diretorio: string = DIRETORIO_MIGRACOES,
): Promise<string[]> {
  const cliente = new pg.Client(admin);
  await cliente.connect();
  const aplicadas: string[] = [];
  try {
    await cliente.query('SELECT pg_advisory_lock($1)', [TRAVA_MIGRACAO]);
    await cliente.query(
      'CREATE TABLE IF NOT EXISTS schema_migracao (versao text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())',
    );

    for (const [papel, senha] of [
      ['lastro_coletor', senhas.coletor],
      ['lastro_leitor', senhas.leitor],
      ['lastro_notificador', senhas.notificador],
    ] as const) {
      const existe = await cliente.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [papel]);
      if (existe.rowCount === 0) await cliente.query(`CREATE ROLE ${cliente.escapeIdentifier(papel)}`);
      // hazard: ALTER ROLE não aceita parâmetro; a senha vai escapada por escapeLiteral. Não ligue
      // log_statement=all no servidor, ou a senha aparece no log.
      await cliente.query(
        `ALTER ROLE ${cliente.escapeIdentifier(papel)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${cliente.escapeLiteral(senha)}`,
      );
    }

    const feitas = new Set(
      (await cliente.query<{ versao: string }>('SELECT versao FROM schema_migracao')).rows.map((r) => r.versao),
    );
    const arquivos = (await readdir(diretorio)).filter((a) => a.endsWith('.sql')).sort();
    for (const arquivo of arquivos) {
      if (feitas.has(arquivo)) continue;
      const sql = await readFile(join(diretorio, arquivo), 'utf8');
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO schema_migracao (versao) VALUES ($1)', [arquivo]);
        await cliente.query('COMMIT');
        aplicadas.push(arquivo);
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      }
    }
  } finally {
    await cliente.query('SELECT pg_advisory_unlock($1)', [TRAVA_MIGRACAO]).catch(() => undefined);
    await cliente.end();
  }
  return aplicadas;
}
