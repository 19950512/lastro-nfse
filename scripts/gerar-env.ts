import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const SEGREDOS = [
  'LASTRO_PG_ADMIN_SENHA',
  'LASTRO_PG_COLETOR_SENHA',
  'LASTRO_PG_LEITOR_SENHA',
  'LASTRO_PG_NOTIFICADOR_SENHA',
  'LASTRO_S3_ACCESS_KEY',
  'LASTRO_S3_SECRET_KEY',
];

const modelo = await readFile('.env.example', 'utf8');
const preenchido = modelo.replace(/^(\w+)=$/gm, (linha, nome: string) =>
  SEGREDOS.includes(nome) ? `${nome}=${randomBytes(24).toString('hex')}` : linha,
);

try {
  // invariant: `wx` nunca sobrescreve um .env existente, que pode guardar senhas já usadas no banco.
  await writeFile('.env', preenchido, { flag: 'wx', mode: 0o600 });
  console.log('.env criado com senhas aleatórias.');
} catch (erro) {
  if ((erro as NodeJS.ErrnoException).code !== 'EEXIST') throw erro;
  console.log('.env já existe; nada foi alterado.');
}
