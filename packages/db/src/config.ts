import type { PoolConfig } from 'pg';

export type Papel = 'admin' | 'coletor' | 'leitor';

export interface ConfigS3 {
  readonly endpoint: string;
  readonly regiao: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly retencaoDias: number;
}

export class ErroConfiguracao extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroConfiguracao';
  }
}

function exigir(ambiente: NodeJS.ProcessEnv, nome: string): string {
  const valor = ambiente[nome];
  if (valor === undefined || valor === '') throw new ErroConfiguracao(`variável de ambiente ausente: ${nome} (rode pnpm infra:env)`);
  return valor;
}

export function configBanco(papel: Papel, ambiente: NodeJS.ProcessEnv = process.env): PoolConfig {
  const ssl = ambiente.LASTRO_PG_SSL ?? 'desligado';
  if (ssl !== 'exigir' && ssl !== 'desligado') throw new ErroConfiguracao(`LASTRO_PG_SSL inválido: ${ssl}`);
  const porta = Number(ambiente.LASTRO_PG_PORTA ?? 55432);
  if (!Number.isInteger(porta)) throw new ErroConfiguracao('LASTRO_PG_PORTA inválida');
  return {
    user: papel === 'admin' ? (ambiente.LASTRO_PG_ADMIN_USUARIO ?? 'lastro_admin') : `lastro_${papel}`,
    password: exigir(ambiente, `LASTRO_PG_${papel.toUpperCase()}_SENHA`),
    host: ambiente.LASTRO_PG_HOST ?? '127.0.0.1',
    port: porta,
    database: ambiente.LASTRO_PG_BANCO ?? 'lastro',
    ssl: ssl === 'exigir' ? { rejectUnauthorized: true } : false,
    application_name: `lastro-${papel}`,
    max: 4,
    connectionTimeoutMillis: 10_000,
    // why: timeout em toda chamada externa (SEGURANCA.md A10); consulta presa não pode travar a coleta.
    statement_timeout: 30_000,
  };
}

export function configS3(ambiente: NodeJS.ProcessEnv = process.env): ConfigS3 {
  const retencaoDias = Number(ambiente.LASTRO_S3_RETENCAO_DIAS ?? 3650);
  if (!Number.isInteger(retencaoDias) || retencaoDias < 1) throw new ErroConfiguracao('LASTRO_S3_RETENCAO_DIAS inválido');
  return {
    endpoint: exigir(ambiente, 'LASTRO_S3_ENDPOINT'),
    regiao: ambiente.LASTRO_S3_REGIAO ?? 'us-east-1',
    bucket: exigir(ambiente, 'LASTRO_S3_BUCKET'),
    accessKey: exigir(ambiente, 'LASTRO_S3_ACCESS_KEY'),
    secretKey: exigir(ambiente, 'LASTRO_S3_SECRET_KEY'),
    retencaoDias,
  };
}
