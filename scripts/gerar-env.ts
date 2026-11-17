import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';

const SEGREDOS = [
  'LASTRO_PG_ADMIN_SENHA',
  'LASTRO_PG_COLETOR_SENHA',
  'LASTRO_PG_LEITOR_SENHA',
  'LASTRO_PG_NOTIFICADOR_SENHA',
  'LASTRO_PG_PROCESSADOR_SENHA',
  'LASTRO_PG_API_SENHA',
  'LASTRO_PG_CURADORIA_SENHA',
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
  const atual = await readFile('.env', 'utf8');
  const definidas = new Set([...atual.matchAll(/^(\w+)=/gm)].map((m) => m[1]));
  const faltando = SEGREDOS.filter((nome) => !definidas.has(nome));
  if (faltando.length === 0) {
    console.log('.env já existe; nada foi alterado.');
  } else {
    // invariant: só acrescenta segredos de papéis novos; nenhuma linha existente é alterada.
    await appendFile('.env', `${atual.endsWith('\n') ? '' : '\n'}${faltando.map((n) => `${n}=${randomBytes(24).toString('hex')}`).join('\n')}\n`);
    console.log(`.env já existe; acrescentados: ${faltando.join(', ')}.`);
  }
}
