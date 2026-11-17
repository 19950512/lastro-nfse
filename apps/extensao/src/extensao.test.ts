import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_TEXTO, montarUrlVerificacao, validarPortal } from './url.js';

describe('validarPortal', () => {
  it.each([
    ['https://lastro.example/qualquer/caminho?x=1', 'https://lastro.example'],
    ['  https://lastro.example  ', 'https://lastro.example'],
    ['http://127.0.0.1:8082', 'http://127.0.0.1:8082'],
    ['http://localhost:8082/', 'http://localhost:8082'],
    ['http://lastro.example', null],
    ['https://user:senha@lastro.example', null],
    ['javascript:alert(1)', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (entrada, esperado) => {
    expect(validarPortal(entrada)).toBe(esperado);
  });
});

describe('montarUrlVerificacao', () => {
  it('leva o texto só no fragmento, codificado e cortado no limite do portal', () => {
    const url = montarUrlVerificacao('https://lastro.example', '  MEI #obrigado & 100% ?x=1  ');
    expect(url).toBe('https://lastro.example/verificar#texto=MEI%20%23obrigado%20%26%20100%25%20%3Fx%3D1');
    const u = new URL(url ?? '');
    expect(u.search).toBe('');
    expect(decodeURIComponent(u.hash.slice('#texto='.length))).toBe('MEI #obrigado & 100% ?x=1');
    const longo = montarUrlVerificacao('https://lastro.example', 'a'.repeat(MAX_TEXTO + 50)) ?? '';
    expect(decodeURIComponent(longo.split('#texto=')[1] ?? '')).toHaveLength(MAX_TEXTO);
  });

  it('sem portal válido ou sem texto, não monta nada', () => {
    expect(montarUrlVerificacao('http://lastro.example', 'texto')).toBeNull();
    expect(montarUrlVerificacao('https://lastro.example', '   ')).toBeNull();
    expect(montarUrlVerificacao(null, 'texto')).toBeNull();
  });
});

describe('manifest', () => {
  it('pede só menu de contexto e armazenamento; nenhum acesso a sites', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['contextMenus', 'storage']);
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest).not.toHaveProperty('content_scripts');
  });
});
