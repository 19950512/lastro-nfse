import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { sha256 } from '@lastro/ingest';
import { CABECALHO_ALIQUOTAS_ISS } from '@lastro/parsers';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArquivoPostgres } from './arquivo-postgres.ts';
import { configBanco, configS3 } from './config.ts';
import { IssPostgres } from './iss.ts';
import { prepararBanco } from './migrar.ts';
import { processarPendentes } from './processamento.ts';
import { StorageWorm } from './storage.ts';

const BANCO = 'lastro_teste';
const ambiente = { ...process.env, LASTRO_PG_BANCO: BANCO, LASTRO_S3_BUCKET: 'lastro-testes', LASTRO_S3_RETENCAO_DIAS: '1' };
const rodada = randomUUID();
const base = `https://www.gov.br/nfse/teste-integracao/${rodada}`;

let admin: pg.Pool;
let coletor: pg.Pool;
let processador: pg.Pool;
let api: pg.Pool;
let storage: StorageWorm;
let arquivo: ArquivoPostgres;
let iss: IssPostgres;
// why: o banco de teste é só inserção e vale o pacote de data mais recente; cada rodada precisa de datas maiores que as
// de todas as rodadas anteriores, senão o pacote de uma rodada velha continua sendo o vigente.
let dataPacote1 = '';
let dataPacote2 = '';
const somarDias = (dias: number): string => new Date(Date.UTC(2100, 0, 1) + dias * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/** ZIP com entradas armazenadas (sem compressão), suficiente para o leitor do processamento. */
function zipArmazenado(entradas: readonly { nome: string; conteudo: Buffer }[]): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;
  for (const e of entradas) {
    const nome = Buffer.from(e.nome, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc32(e.conteudo), 14);
    local.writeUInt32LE(e.conteudo.length, 18);
    local.writeUInt32LE(e.conteudo.length, 22);
    local.writeUInt16LE(nome.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc32(e.conteudo), 16);
    central.writeUInt32LE(e.conteudo.length, 20);
    central.writeUInt32LE(e.conteudo.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    locais.push(local, nome, e.conteudo);
    centrais.push(central, nome);
    deslocamento += 30 + nome.length + e.conteudo.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, diretorio, fim]);
}

const csv = (linhas: readonly string[]): Buffer => Buffer.from(`${String.fromCodePoint(0xfeff)}${[CABECALHO_ALIQUOTAS_ISS, ...linhas].join('\r\n')}\r\n`, 'utf8');

const SP_V1 = [
  '3500105;SP;Adamantina;01.05.01.000;01.05.01.000;2;2025-08-01T00:00:00;',
  '3500105;SP;Adamantina;07.02.01.000;07.02.01.000;2,5;2025-08-01T00:00:00;2026-06-23T00:00:00',
  '3500105;SP;Adamantina;07.02.01.000;07.02.01.000;3;2026-06-24T00:00:00;',
  "3545803;SP;Santa Bárbara d'Oeste;01.05.01.000;01.05.01.000;;2026-01-01T00:00:00;",
];
const PI_V1 = ['2201804;PI;Bom Jesus;01.05.01.000;01.05.01.000;5;2026-01-01T00:00:00;'];

async function gravarPacote(data: string, sp: readonly string[]): Promise<void> {
  const corpo = zipArmazenado([
    { nome: 'SP.csv', conteudo: csv(sp) },
    { nome: 'PI.csv', conteudo: csv(PI_V1) },
    { nome: `aliquotas-municipios-${data}.txt`, conteudo: Buffer.from('repete os CSV') },
  ]);
  const url = `${base}/aliquotas-municipios-${data}-extr1.zip`;
  const sha = sha256(corpo);
  await arquivo.gravarSnapshot(
    { fonteId: 'nfse-aliquotas-iss', url, urlFinal: url, mime: 'application/zip', etag: null, ultimaModificacao: null, corpo, sha256: sha, impressao: `bytes:${sha}` },
    new Date(),
  );
}

beforeAll(async () => {
  const servidor = new pg.Client({ ...configBanco('admin', process.env), database: 'postgres' });
  await servidor.connect();
  if ((await servidor.query('SELECT 1 FROM pg_database WHERE datname = $1', [BANCO])).rowCount === 0) await servidor.query(`CREATE DATABASE ${BANCO}`);
  await servidor.end();
  const senha = (p: Parameters<typeof configBanco>[0]) => configBanco(p, ambiente).password as string;
  await prepararBanco(configBanco('admin', ambiente), {
    coletor: senha('coletor'),
    leitor: senha('leitor'),
    notificador: senha('notificador'),
    processador: senha('processador'),
    api: senha('api'),
    curadoria: senha('curadoria'),
  });
  const s3 = configS3(ambiente);
  storage = StorageWorm.criar(s3);
  await storage.preparar(s3.retencaoDias);
  admin = new pg.Pool(configBanco('admin', ambiente));
  coletor = new pg.Pool(configBanco('coletor', ambiente));
  processador = new pg.Pool(configBanco('processador', ambiente));
  api = new pg.Pool(configBanco('api', ambiente));
  arquivo = new ArquivoPostgres(coletor, storage);
  iss = new IssPostgres(api);
  const anteriores = (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM tabela_aliquota_iss')).rows[0]?.n ?? 0;
  dataPacote1 = somarDias(2 * anteriores);
  dataPacote2 = somarDias(2 * anteriores + 1);
});

afterAll(async () => {
  await Promise.all([admin.end(), coletor.end(), processador.end(), api.end()]);
  storage.destruir();
});

describe('alíquotas de ISSQN (Fase 5)', () => {
  it('processa o pacote oficial e a API lê a linha publicada exata', async () => {
    await gravarPacote(dataPacote1, SP_V1);
    const resultados = await processarPendentes({ pool: processador, lerOriginal: (sha) => storage.ler(sha) }, { limite: 1000 });
    const meu = resultados.find((r) => r.url.startsWith(base));
    expect(meu).toMatchObject({ tipo: 'aliquotas', itens: 5 });

    const tabela = await iss.tabelaVigente();
    expect(tabela).toMatchObject({ fonteId: 'nfse-aliquotas-iss', dataReferencia: iso(dataPacote1), linhas: 5, recusadas: 0, arquivos: ['PI.csv', 'SP.csv'] });
    if (tabela === undefined) return;
    expect(tabela.url.startsWith(base)).toBe(true);

    const linhas = await iss.aliquotas(tabela.extracaoId, '3500105', ['07.02.'], 100);
    expect(linhas.map((l) => [l.codigoServico, l.aliquota, l.inicio, l.fim, l.linha])).toEqual([
      ['07.02.01.000', '2,5', '2025-08-01', '2026-06-23', 3],
      ['07.02.01.000', '3', '2026-06-24', null, 4],
    ]);
    expect(linhas.map((l) => l.textoPublicado)).toEqual([SP_V1[1], SP_V1[2]]);
    const vazia = await iss.aliquotas(tabela.extracaoId, '3545803', null, 100);
    expect(vazia.map((l) => [l.aliquota, l.textoPublicado])).toEqual([[null, SP_V1[3]]]);
  });

  it('busca município sem acento, por UF e por código; curinga do LIKE não vaza', async () => {
    const tabela = await iss.tabelaVigente();
    if (tabela === undefined) throw new Error('sem tabela');
    expect((await iss.buscarMunicipios(tabela.extracaoId, { nome: 'santa barbara', limite: 5 })).map((m) => m.codigoIbge)).toEqual(['3545803']);
    expect((await iss.buscarMunicipios(tabela.extracaoId, { uf: 'PI', limite: 5 })).map((m) => m.nome)).toEqual(['Bom Jesus']);
    expect(await iss.buscarMunicipios(tabela.extracaoId, { nome: '%', limite: 5 })).toEqual([]);
    expect(await iss.aliquotas(tabela.extracaoId, '3500105', ['%'], 100)).toEqual([]);
    expect((await iss.municipios(tabela.extracaoId)).length).toBe(3);
  });

  it('pacote com data de extração mais recente passa a ser o vigente; o anterior continua arquivado', async () => {
    const anterior = await iss.tabelaVigente();
    await gravarPacote(dataPacote2, [SP_V1[0] ?? '']);
    await processarPendentes({ pool: processador, lerOriginal: (sha) => storage.ler(sha) }, { limite: 1000 });
    const atual = await iss.tabelaVigente();
    expect(atual?.dataReferencia).toBe(iso(dataPacote2));
    expect(atual?.extracaoId).not.toBe(anterior?.extracaoId);
    expect((await admin.query('SELECT count(*)::int AS n FROM aliquota_iss WHERE extracao_id = $1', [anterior?.extracaoId])).rows[0]).toEqual({ n: 5 });
  });

  it('só inserção, até para o dono; papéis mínimos', async () => {
    await expect(admin.query("UPDATE aliquota_iss SET aliquota = '1' WHERE linha = 2")).rejects.toThrow();
    await expect(admin.query('DELETE FROM municipio_iss')).rejects.toThrow();
    await expect(admin.query('TRUNCATE tabela_aliquota_iss CASCADE')).rejects.toThrow();
    await expect(api.query("INSERT INTO tabela_aliquota_iss (extracao_id, snapshot_id, documento_id, fonte_id, linhas, recusadas, arquivos) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', 1, 0, '{}')")).rejects.toThrow(/permission denied/);
    await expect(processador.query('SELECT count(*) FROM aliquota_iss')).rejects.toThrow(/permission denied/);
    await expect(admin.query("INSERT INTO aliquota_iss (extracao_id, arquivo, linha, codigo_ibge, codigo_servico, incidencia, aliquota, inicio) VALUES (gen_random_uuid(), 'SP.csv', 2, '3500105', '1.05', '1.05', '2', '2026-01-01')")).rejects.toThrow();
  });
});
