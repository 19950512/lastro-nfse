import { describe, expect, it } from 'vitest';
import { verificarOrigem, verificarOrigemRobots } from './origem.ts';

describe('verificarOrigem', () => {
  it.each([
    'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc',
    'https://www.gov.br/receitafederal/pt-br/assuntos/noticias',
    'https://WWW.GOV.BR/nfse/pt-br',
    'https://www.gov.br./nfse/pt-br',
    'https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214.htm',
    'https://www.cgibs.gov.br/inicial',
    'https://cgibs.gov.br/upload/arquivos/202611/13061456-ato-conjunto-7-rfb-cgibs-alteracao-ato-4.pdf',
  ])('aceita origem oficial %s', (url) => {
    expect(verificarOrigem(url).permitido).toBe(true);
  });

  it.each([
    ['http://www.gov.br/nfse/pt-br', 'protocolo'],
    ['https://www.gov.br/mre/pt-br', 'fora da lista'],
    ['https://www.gov.br/', 'fora da lista'],
    ['https://www.gov.br/nfsefake/x', 'fora da lista'],
    ['https://gov.br/nfse/pt-br', 'fora da lista'],
    ['https://www.gov.br.atacante.com/nfse/pt-br', 'fora da lista'],
    ['https://atacante.com/www.gov.br/nfse/', 'fora da lista'],
    ['https://user:senha@www.gov.br/nfse/pt-br', 'credenciais'],
    ['https://www.gov.br:8443/nfse/pt-br', 'porta'],
    ['https://169.254.169.254/latest/meta-data', 'IP literal'],
    ['https://[::1]/nfse/', 'IP literal'],
    ['https://www.gov.br/nfse/..%2F..%2Fmre/x', 'sequência codificada'],
    ['https://www.gov.br/nfse/%2e%2e/mre/x', 'fora da lista'],
    ['https://www.gov.br/nfse/a%5c..%5cmre', 'sequência codificada'],
    ['https://www.planalto.gov.br/outra-coisa', 'fora da lista'],
    ['não é url', 'inválida'],
    ['javascript:alert(1)', 'protocolo'],
    ['file:///etc/passwd', 'protocolo'],
  ])('recusa %s (%s)', (url, motivo) => {
    const r = verificarOrigem(url);
    expect(r.permitido).toBe(false);
    if (!r.permitido) expect(r.motivo).toContain(motivo);
  });

  it('resolve ../ antes de checar o prefixo', () => {
    expect(verificarOrigem('https://www.gov.br/nfse/../mre/x').permitido).toBe(false);
  });

  it('identifica o órgão pelo prefixo no host compartilhado', () => {
    const r = verificarOrigem('https://www.gov.br/fazenda/pt-br');
    expect(r.permitido && r.origem.orgao).toBe('Ministério da Fazenda');
  });
});

describe('verificarOrigemRobots', () => {
  it('aceita só /robots.txt de host da lista', () => {
    expect(verificarOrigemRobots('https://www.gov.br/robots.txt').permitido).toBe(true);
    expect(verificarOrigemRobots('https://www.gov.br/mre/robots.txt').permitido).toBe(false);
    expect(verificarOrigemRobots('https://www.gov.br/robots.txt?x=1').permitido).toBe(false);
    expect(verificarOrigemRobots('https://exemplo.com/robots.txt').permitido).toBe(false);
    expect(verificarOrigemRobots('http://www.gov.br/robots.txt').permitido).toBe(false);
  });
});
