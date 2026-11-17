import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArquivoEmDisco, ErroArquivo, type NovoSnapshot } from './arquivo.ts';
import { sha256 } from './http.ts';

const URL_PDF = 'https://www.gov.br/nfse/pt-br/a.pdf';

function novo(conteudo: string, url = URL_PDF): NovoSnapshot {
  const corpo = Buffer.from(conteudo);
  const sha = sha256(corpo);
  return { fonteId: 'f', url, urlFinal: url, mime: 'application/pdf', etag: null, ultimaModificacao: null, corpo, sha256: sha, impressao: sha };
}

let raiz: string;
beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'lastro-arquivo-'));
});
afterEach(async () => {
  await rm(raiz, { recursive: true, force: true });
});

describe('ArquivoEmDisco', () => {
  it('grava, indexa e relê com o mesmo hash', async () => {
    const arquivo = new ArquivoEmDisco(raiz);
    const s = await arquivo.gravarSnapshot(novo('v1'), new Date('2026-11-16T12:00:00Z'));
    expect((await arquivo.ultimoSnapshot(URL_PDF))?.id).toBe(s.id);
    expect((await arquivo.lerConteudo(s.sha256)).toString()).toBe('v1');

    const recarregado = new ArquivoEmDisco(raiz);
    expect((await recarregado.ultimoSnapshot(URL_PDF))?.sha256).toBe(s.sha256);
  });

  it('nova versão vira novo registro; o anterior continua legível', async () => {
    const arquivo = new ArquivoEmDisco(raiz);
    const v1 = await arquivo.gravarSnapshot(novo('v1'), new Date());
    const v2 = await arquivo.gravarSnapshot(novo('v2'), new Date());
    expect((await arquivo.ultimoSnapshot(URL_PDF))?.id).toBe(v2.id);
    expect((await arquivo.lerConteudo(v1.sha256)).toString()).toBe('v1');
    const linhas = (await readFile(join(raiz, 'snapshots.ndjson'), 'utf8')).trim().split('\n');
    expect(linhas).toHaveLength(2);
  });

  it('recusa snapshot de origem fora da lista (segunda barreira)', async () => {
    const arquivo = new ArquivoEmDisco(raiz);
    await expect(arquivo.gravarSnapshot(novo('x', 'https://blog.example/a.pdf'), new Date())).rejects.toThrow(ErroArquivo);
    const final = { ...novo('x'), urlFinal: 'https://www.gov.br/mre/a.pdf' };
    await expect(arquivo.gravarSnapshot(final, new Date())).rejects.toThrow(/fora da lista/);
  });

  it('recusa hash declarado diferente do conteúdo', async () => {
    const arquivo = new ArquivoEmDisco(raiz);
    await expect(arquivo.gravarSnapshot({ ...novo('x'), sha256: sha256(Buffer.from('y')) }, new Date())).rejects.toThrow(
      /hash divergente/,
    );
  });

  it('detecta objeto adulterado na leitura', async () => {
    const arquivo = new ArquivoEmDisco(raiz);
    const s = await arquivo.gravarSnapshot(novo('original'), new Date());
    const caminho = join(raiz, 'objetos', s.sha256.slice(0, 2), s.sha256.slice(2, 4), s.sha256);
    await chmod(caminho, 0o644);
    await writeFile(caminho, 'adulterado');
    await expect(arquivo.lerConteudo(s.sha256)).rejects.toThrow(/adulterado/);
  });

  it('recusa sha256 malformado (travessia de caminho)', async () => {
    await expect(new ArquivoEmDisco(raiz).lerConteudo('../../etc/passwd')).rejects.toThrow(/inválido/);
  });

  it('filtra eventos por data', async () => {
    const arquivo = new ArquivoEmDisco(raiz);
    const base = { tipo: 'nova-versao' as const, fonteId: 'f', url: URL_PDF, snapshotAnterior: null, snapshotNovo: null, resumo: '', anomalia: null };
    await arquivo.registrarEvento({ ...base, detectadoEm: '2026-11-01T00:00:00.000Z' });
    await arquivo.registrarEvento({ ...base, detectadoEm: '2026-11-15T00:00:00.000Z' });
    expect(await arquivo.listarEventos(new Date('2026-11-10T00:00:00Z'))).toHaveLength(1);
    expect(await arquivo.listarEventos()).toHaveLength(2);
  });
});
