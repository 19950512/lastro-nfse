import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArquivoPostgres, configBanco, configS3, prepararInfra, StorageWorm } from '@lastro/db';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verificarAssinatura } from './assinatura.ts';
import { criarAssinatura } from './assinaturas.ts';
import { FALHAS_PARA_DESATIVAR, despachar } from './despacho.ts';
import { criarEnviadorHttps } from './envio.ts';

const ambiente = { ...process.env, LASTRO_PG_BANCO: 'lastro_teste', LASTRO_S3_BUCKET: 'lastro-testes', LASTRO_S3_RETENCAO_DIAS: '1' };
const FONTE = 'teste-webhook';
const URL_API = 'https://api.lastro.example';

interface Recebido {
  corpo: string;
  cabecalhos: IncomingHttpHeaders;
}

let admin: pg.Pool;
let notificador: pg.Pool;
let coletorPool: pg.Pool;
let arquivo: ArquivoPostgres;
let storage: StorageWorm;
let receptor: https.Server;
let porta: number;
let certificado: Buffer;
let recebidos: Recebido[] = [];
let resposta: { status: number; location?: string } = { status: 204 };

// why: no teste o "host do cliente" é o próprio receptor local; em produção o lookup é o seguro, que recusa 127.0.0.1.
const lookupReceptor = ((_h: string, opcoes: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) => {
  if (opcoes.all === true) cb(null, [{ address: '127.0.0.1', family: 4 }]);
  else cb(null, '127.0.0.1', 4);
}) as unknown as LookupFunction;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lastro-webhook-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', join(dir, 'chave.pem'), '-out', join(dir, 'cert.pem'), '-days', '1',
    '-subj', '/CN=receptor.teste', '-addext', 'subjectAltName=DNS:receptor.teste',
  ], { stdio: 'ignore' });
  certificado = readFileSync(join(dir, 'cert.pem'));
  receptor = https.createServer({ key: readFileSync(join(dir, 'chave.pem')), cert: certificado }, (req, res) => {
    const partes: Buffer[] = [];
    req.on('data', (p: Buffer) => partes.push(p));
    req.on('end', () => {
      recebidos.push({ corpo: Buffer.concat(partes).toString(), cabecalhos: req.headers });
      res.writeHead(resposta.status, resposta.location === undefined ? {} : { location: resposta.location });
      res.end();
    });
  });
  await new Promise<void>((ok) => receptor.listen(0, '127.0.0.1', ok));
  porta = (receptor.address() as AddressInfo).port;

  const servidor = new pg.Client({ ...configBanco('admin', process.env), database: 'postgres' });
  await servidor.connect();
  if ((await servidor.query("SELECT 1 FROM pg_database WHERE datname = 'lastro_teste'")).rowCount === 0) {
    await servidor.query('CREATE DATABASE lastro_teste');
  }
  await servidor.end();
  await prepararInfra(ambiente);

  admin = new pg.Pool(configBanco('admin', ambiente));
  notificador = new pg.Pool(configBanco('notificador', ambiente));
  coletorPool = new pg.Pool(configBanco('coletor', ambiente));
  storage = StorageWorm.criar(configS3(ambiente));
  arquivo = new ArquivoPostgres(coletorPool, storage);
});

afterAll(async () => {
  await Promise.all([admin.end(), notificador.end(), coletorPool.end()]);
  storage.destruir();
  await new Promise((ok) => receptor.close(ok));
});

beforeEach(async () => {
  await admin.query("UPDATE webhook_assinatura SET ativa = false, motivo_desativacao = 'limpeza de teste' WHERE ativa");
  recebidos = [];
  resposta = { status: 204 };
});

async function assinar(): Promise<{ id: string; segredo: string }> {
  return criarAssinatura(admin, { url: `https://receptor.teste:${String(porta)}/hook`, formato: 'lastro', fontes: [FONTE] }, new Set([FONTE]), () =>
    Promise.resolve(['200.152.38.155']),
  );
}

async function evento(n: number): Promise<void> {
  await arquivo.registrarEvento({
    tipo: 'nova-versao',
    fonteId: FONTE,
    url: `https://www.gov.br/nfse/teste-webhook/${crypto.randomUUID()}.pdf`,
    snapshotAnterior: null,
    snapshotNovo: null,
    detectadoEm: new Date(Date.now() + n).toISOString(),
    resumo: `evento ${String(n)}`,
    anomalia: null,
  });
}

const enviar = () => criarEnviadorHttps({ lookup: lookupReceptor, ca: certificado, timeoutMs: 5000 });

describe('webhooks (Postgres real + receptor HTTPS)', () => {
  it('entrega assinada, uma vez só', async () => {
    const { segredo } = await assinar();
    await evento(1);
    await evento(2);

    const r = await despachar(notificador, enviar(), { urlPublicaApi: URL_API });
    expect(r).toMatchObject({ enfileiradas: 2, entregues: 2, falhas: 0 });
    expect(recebidos).toHaveLength(2);
    for (const { corpo, cabecalhos } of recebidos) {
      expect(verificarAssinatura(segredo, corpo, String(cabecalhos['lastro-assinatura']), new Date())).toBe(true);
      expect(JSON.parse(corpo)).toMatchObject({ tipo: 'nova-versao', fonte_id: FONTE });
    }

    const segunda = await despachar(notificador, enviar(), { urlPublicaApi: URL_API });
    expect(segunda).toMatchObject({ enfileiradas: 0, entregues: 0 });
    expect(recebidos).toHaveLength(2);
  });

  it('falha agenda nova tentativa no futuro; redirecionamento conta como falha', async () => {
    await assinar();
    await evento(1);
    resposta = { status: 302, location: 'https://169.254.169.254/' };
    const r = await despachar(notificador, enviar(), { urlPublicaApi: URL_API });
    expect(r).toMatchObject({ entregues: 0, falhas: 1 });

    const linha = await admin.query<{ ultimo_erro: string; proxima_tentativa: Date }>(
      "SELECT ultimo_erro, proxima_tentativa FROM webhook_entrega w JOIN webhook_assinatura a ON a.id = w.assinatura_id WHERE a.ativa AND w.situacao = 'pendente'",
    );
    expect(linha.rows[0]?.ultimo_erro).toBe('redirecionamento não é seguido');
    expect(linha.rows[0]?.proxima_tentativa.getTime()).toBeGreaterThan(Date.now() + 50_000);

    resposta = { status: 204 };
    expect((await despachar(notificador, enviar(), { urlPublicaApi: URL_API })).entregues).toBe(0);
  });

  it(`desativa a assinatura após ${String(FALHAS_PARA_DESATIVAR)} falhas seguidas`, async () => {
    const { id } = await assinar();
    for (let i = 0; i < FALHAS_PARA_DESATIVAR + 2; i++) await evento(i);
    resposta = { status: 500 };
    const r = await despachar(notificador, enviar(), { urlPublicaApi: URL_API });
    expect(r.desativadas).toBe(1);
    expect(recebidos).toHaveLength(FALHAS_PARA_DESATIVAR);
    const a = await admin.query<{ ativa: boolean; motivo_desativacao: string }>('SELECT ativa, motivo_desativacao FROM webhook_assinatura WHERE id = $1', [id]);
    expect(a.rows[0]).toMatchObject({ ativa: false });
    expect(a.rows[0]?.motivo_desativacao).toContain('HTTP 500');
  });

  it('papel notificador não altera o histórico nem lê snapshots', async () => {
    await expect(notificador.query("UPDATE evento_mudanca SET resumo = 'x'")).rejects.toThrow(/permission denied/);
    await expect(notificador.query('SELECT * FROM snapshot LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(notificador.query("INSERT INTO webhook_assinatura (url, formato, segredo) VALUES ('https://x.example', 'lastro', repeat('a', 32))")).rejects.toThrow(
      /permission denied/,
    );
  });

  it('cadastro recusa host que resolve para rede interna', async () => {
    await expect(
      criarAssinatura(admin, { url: 'https://cliente.example/h', formato: 'lastro' }, new Set(), () => Promise.resolve(['10.1.2.3'])),
    ).rejects.toThrow(/não público/);
  });
});
