import { describe, expect, it } from 'vitest';
import { obterRobots } from './robots.ts';
import { criarTransporteFalso } from './transporte-falso.ts';

const ROBOTS = 'https://www.lexml.gov.br/robots.txt';

describe('obterRobots', () => {
  it('aplica regras e crawl-delay do arquivo', async () => {
    const { transporte } = criarTransporteFalso({
      [ROBOTS]: {
        cabecalhos: { 'content-type': 'text/plain' },
        corpo: 'User-agent: *\nDisallow: /busca/\nCrawl-delay: 5\n',
      },
    });
    const politica = await obterRobots('www.lexml.gov.br', transporte);
    expect(politica.situacao).toBe('encontrado');
    expect(politica.atrasoSegundos).toBe(5);
    expect(politica.permitido('https://www.lexml.gov.br/urn/x')).toBe(true);
    expect(politica.permitido('https://www.lexml.gov.br/busca/SRU')).toBe(false);
  });

  it('respeita grupo específico do LastroBot', async () => {
    const { transporte } = criarTransporteFalso({
      [ROBOTS]: { cabecalhos: { 'content-type': 'text/plain' }, corpo: 'User-agent: LastroBot\nDisallow: /\n' },
    });
    const politica = await obterRobots('www.lexml.gov.br', transporte);
    expect(politica.permitido('https://www.lexml.gov.br/')).toBe(false);
  });

  it('4xx significa sem restrições (RFC 9309 §2.3.1.3)', async () => {
    const { transporte } = criarTransporteFalso({});
    const politica = await obterRobots('www.lexml.gov.br', transporte);
    expect(politica.situacao).toBe('ausente');
    expect(politica.permitido('https://www.lexml.gov.br/qualquer')).toBe(true);
  });

  it('5xx significa tudo proibido (RFC 9309 §2.3.1.4)', async () => {
    const { transporte } = criarTransporteFalso({ [ROBOTS]: { status: 503 } });
    const politica = await obterRobots('www.lexml.gov.br', transporte);
    expect(politica.situacao).toBe('inacessivel');
    expect(politica.permitido('https://www.lexml.gov.br/')).toBe(false);
  });

  it('redirecionamento para fora da lista conta como inacessível (falha fechada)', async () => {
    const { transporte } = criarTransporteFalso({
      [ROBOTS]: { status: 301, cabecalhos: { location: 'https://atacante.example/robots.txt' } },
    });
    const politica = await obterRobots('www.lexml.gov.br', transporte);
    expect(politica.situacao).toBe('inacessivel');
    expect(politica.permitido('https://www.lexml.gov.br/')).toBe(false);
  });

  it('página HTML no lugar do robots.txt conta como ausente', async () => {
    const { transporte } = criarTransporteFalso({
      [ROBOTS]: { cabecalhos: { 'content-type': 'text/html' }, corpo: '<html>Disallow: /</html>' },
    });
    const politica = await obterRobots('www.lexml.gov.br', transporte);
    expect(politica.situacao).toBe('ausente');
    expect(politica.permitido('https://www.lexml.gov.br/')).toBe(true);
  });

  it('URL de outro host nunca é permitida pela política', async () => {
    const { transporte } = criarTransporteFalso({
      [ROBOTS]: { cabecalhos: { 'content-type': 'text/plain' }, corpo: 'User-agent: *\nAllow: /\n' },
    });
    const politica = await obterRobots('www.lexml.gov.br', transporte);
    expect(politica.permitido('https://www.gov.br/nfse/')).toBe(false);
  });
});
