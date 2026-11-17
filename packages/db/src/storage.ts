import {
  CreateBucketCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  PutObjectCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { sha256 } from '@lastro/ingest';
import type { ConfigS3 } from './config.ts';

export class ErroStorage extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroStorage';
  }
}

const SHA_VALIDO = /^[0-9a-f]{64}$/;

function status(erro: unknown): number | undefined {
  return (erro as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
}

/**
 * Bytes originais dos snapshots em S3 com Object Lock (SEGURANCA.md §8, "storage imutável").
 *
 * invariant: chave = SHA-256 do conteúdo, gravação com `If-None-Match: *` e checksum SHA-256
 * conferido pelo servidor. Em modo COMPLIANCE nem a conta raiz apaga ou sobrescreve antes do prazo.
 */
export class StorageWorm {
  private readonly cliente: S3Client;
  private readonly bucket: string;

  constructor(cliente: S3Client, bucket: string) {
    this.cliente = cliente;
    this.bucket = bucket;
  }

  static criar(config: ConfigS3): StorageWorm {
    const cliente = new S3Client({
      endpoint: config.endpoint,
      region: config.regiao,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
      maxAttempts: 3,
    });
    return new StorageWorm(cliente, config.bucket);
  }

  chave(sha: string): string {
    if (!SHA_VALIDO.test(sha)) throw new ErroStorage(`sha256 inválido: ${sha}`);
    return `sha256/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
  }

  async gravar(sha: string, corpo: Buffer, mime: string): Promise<'gravado' | 'ja-existia'> {
    if (sha256(corpo) !== sha) throw new ErroStorage(`hash divergente para ${sha}`);
    try {
      await this.cliente.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.chave(sha),
          Body: corpo,
          ContentType: mime,
          ChecksumSHA256: Buffer.from(sha, 'hex').toString('base64'),
          IfNoneMatch: '*',
        }),
      );
      return 'gravado';
    } catch (erro) {
      if (status(erro) !== 412) throw erro;
      // invariant: objeto já existente só é aceito se o conteúdo bater com a chave.
      await this.ler(sha);
      return 'ja-existia';
    }
  }

  async ler(sha: string): Promise<Buffer> {
    const resposta = await this.cliente.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.chave(sha) }));
    if (resposta.Body === undefined) throw new ErroStorage(`objeto ${sha} sem corpo`);
    const corpo = Buffer.from(await resposta.Body.transformToByteArray());
    if (sha256(corpo) !== sha) throw new ErroStorage(`objeto ${sha} adulterado ou corrompido`);
    return corpo;
  }

  async verificarWorm(): Promise<void> {
    // hazard: um bucket sem Object Lock aceitaria sobrescrita; a coleta recusa começar nesse caso.
    let configuracao;
    try {
      configuracao = await this.cliente.send(new GetObjectLockConfigurationCommand({ Bucket: this.bucket }));
    } catch (erro) {
      throw new ErroStorage(`bucket ${this.bucket} sem Object Lock (${erro instanceof Error ? erro.name : 'erro'}); rode o comando preparar`);
    }
    const lock = configuracao.ObjectLockConfiguration;
    if (lock?.ObjectLockEnabled !== 'Enabled' || lock.Rule?.DefaultRetention?.Mode !== 'COMPLIANCE') {
      throw new ErroStorage(`bucket ${this.bucket} sem retenção padrão COMPLIANCE`);
    }
  }

  async preparar(retencaoDias: number): Promise<void> {
    try {
      await this.cliente.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (erro) {
      if (status(erro) !== 404) throw erro;
      await this.cliente.send(new CreateBucketCommand({ Bucket: this.bucket, ObjectLockEnabledForBucket: true }));
    }
    await this.cliente.send(
      new PutObjectLockConfigurationCommand({
        Bucket: this.bucket,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: retencaoDias } },
        },
      }),
    );
    await this.verificarWorm();
  }

  destruir(): void {
    this.cliente.destroy();
  }
}
