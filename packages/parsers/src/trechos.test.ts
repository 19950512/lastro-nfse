import { describe, expect, it } from 'vitest';
import { blocosDeHtml, decodificarHtml } from './html.ts';
import { secaoDeArtigo, trechosDeHtml, trechosDePdf } from './trechos.ts';

describe('decodificarHtml', () => {
  it('honra o charset declarado e cai para windows-1252 quando os bytes não são UTF-8', () => {
    const latin = Buffer.from('<p>Disposições</p>', 'latin1');
    expect(decodificarHtml(latin)).toBe('<p>Disposições</p>');
    expect(decodificarHtml(Buffer.from('<p>Disposições</p>', 'utf8'))).toBe('<p>Disposições</p>');
    const declarado = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">'), latin]);
    expect(decodificarHtml(declarado)).toContain('Disposições');
  });
});

describe('blocosDeHtml', () => {
  it('usa só a área principal e descarta script, menu e texto riscado (revogado)', () => {
    const html = `<html><head><title>x</title><script>alert(1)</script></head><body>
      <nav><a>Menu</a></nav>
      <div id="content"><h1>Título</h1><p>Primeiro &amp; único</p><p>Antigo <strike>texto revogado</strike> e vigente</p>
      <table><tr><td>a</td><td>b</td></tr></table></div><footer>Rodapé</footer></body></html>`;
    expect(blocosDeHtml(html)).toEqual([
      { tipo: 'titulo', texto: 'Título', nivel: 1 },
      { tipo: 'paragrafo', texto: 'Primeiro & único', nivel: null },
      { tipo: 'paragrafo', texto: 'Antigo e vigente', nivel: null },
      { tipo: 'paragrafo', texto: 'a | b', nivel: null },
    ]);
  });

  it('sem área principal, usa a página toda', () => {
    expect(blocosDeHtml('<body><p>um</p><p>dois<br>três</p></body>').map((b) => b.texto)).toEqual(['um', 'dois', 'três']);
  });
});

describe('trechosDeHtml', () => {
  const p = (texto: string) => ({ tipo: 'paragrafo' as const, texto, nivel: null });

  it('reconhece artigos com sufixo e ordinal', () => {
    expect(secaoDeArtigo('Art. 62-A. Texto')).toBe('Art. 62-A');
    expect(secaoDeArtigo('Art. 1º Fica')).toBe('Art. 1');
    expect(secaoDeArtigo('Art. 10. Considera-se')).toBe('Art. 10');
    expect(secaoDeArtigo('Artigo qualquer')).toBeUndefined();
  });

  it('em texto legal, um trecho por artigo, com títulos estruturais junto do artigo seguinte', () => {
    const trechos = trechosDeHtml([
      p('LEI COMPLEMENTAR Nº 214'),
      p('CAPÍTULO I'),
      p('DISPOSIÇÕES GERAIS'),
      p('Art. 1º Fica instituído o IBS.'),
      p('Parágrafo único. Vale para todos.'),
      p('Art. 2º Outro.'),
      p('Art. 3º Mais um.'),
    ]);
    expect(trechos.map((t) => [t.secao, t.texto])).toEqual([
      [null, 'LEI COMPLEMENTAR Nº 214'],
      ['Art. 1', 'CAPÍTULO I\nDISPOSIÇÕES GERAIS\nArt. 1º Fica instituído o IBS.\nParágrafo único. Vale para todos.'],
      ['Art. 2', 'Art. 2º Outro.'],
      ['Art. 3', 'Art. 3º Mais um.'],
    ]);
  });

  it('divide artigo longo nos parágrafos, mantendo a seção, sem passar do limite', () => {
    const paragrafos = Array.from({ length: 6 }, (_, i) => p(`§ ${i + 1}º ${'palavra '.repeat(30)}`));
    const trechos = trechosDeHtml([p('Art. 5º Caput.'), ...paragrafos, p('Art. 6º x'), p('Art. 7º y')], { maxCaracteres: 500 });
    const do5 = trechos.filter((t) => t.secao === 'Art. 5');
    expect(do5.length).toBeGreaterThan(1);
    for (const t of trechos) expect(t.texto.length).toBeLessThanOrEqual(500);
    expect(trechos.map((t) => t.ordem)).toEqual(trechos.map((_, i) => i));
  });

  it('fora de texto legal, títulos abrem seções', () => {
    const trechos = trechosDeHtml([{ tipo: 'titulo', texto: 'Notícia', nivel: 1 }, p('Corpo da notícia.'), { tipo: 'titulo', texto: 'Outra', nivel: 2 }, p('Mais.')]);
    expect(trechos.map((t) => t.secao)).toEqual(['Notícia', 'Outra']);
  });
});

describe('trechosDePdf', () => {
  it('guarda páginas, descarta número de página, detecta títulos e ignora o sumário', () => {
    const paginas = [
      'Nota Técnica 009\nSumário\n2.1 CNPJ Alfanumérico ........................ 3\n1',
      '2\n2. Atualizações\n2.1 CNPJ Alfanumérico\nOs campos CNPJ passam a aceitar letras.\nContinua na próxima página',
      'e termina aqui.\n2.2 Notas de Ajuste\nTexto das notas.\nPágina 3 de 3',
    ];
    const trechos = trechosDePdf(paginas);
    expect(trechos.map((t) => [t.secao, t.paginaIni, t.paginaFim])).toEqual([
      [null, 1, 1],
      ['2.1 CNPJ Alfanumérico', 2, 3],
      ['2.2 Notas de Ajuste', 3, 3],
    ]);
    expect(trechos[1]?.texto).toBe('2. Atualizações 2.1 CNPJ Alfanumérico Os campos CNPJ passam a aceitar letras. Continua na próxima página e termina aqui.');
    expect(trechos.every((t) => !/\b1$|Página 3/.test(t.texto))).toBe(true);
  });

  it('não trata frase numerada como título e respeita o limite de tamanho', () => {
    const trechos = trechosDePdf(['1 Os contribuintes devem emitir a nota.\n' + 'linha de texto comum. '.repeat(200)], { maxCaracteres: 400 });
    expect(trechos.every((t) => t.secao === null)).toBe(true);
    expect(trechos.every((t) => t.texto.length <= 400 && t.texto.length > 0)).toBe(true);
  });

  it('documento sem texto não gera trecho', () => {
    expect(trechosDePdf(['', '  \n ', '7'])).toEqual([]);
  });
});
