import { describe, expect, it } from 'vitest';
import { ErroParser } from './erro.ts';
import { normalizarCodigo, tabelasDeXlsx } from './tabelas.ts';
import { lerXlsx } from './xlsx.ts';
import { criarZip } from './zip-para-teste.ts';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function xlsx(folhas: Record<string, string>, compartilhados: readonly string[], extras: Record<string, string> = {}): Buffer {
  const nomes = Object.keys(folhas);
  return criarZip([
    { nome: 'xl/workbook.xml', conteudo: `<workbook ${NS}><sheets>${nomes.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    {
      nome: 'xl/_rels/workbook.xml.rels',
      conteudo: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${nomes.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    },
    { nome: 'xl/sharedStrings.xml', conteudo: `<sst ${NS}>${compartilhados.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>` },
    ...Object.values(folhas).map((xml, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, conteudo: `<worksheet ${NS}>${xml}</worksheet>` })),
    ...Object.entries(extras).map(([nome, conteudo]) => ({ nome, conteudo })),
  ]);
}

describe('lerXlsx', () => {
  it('lê textos compartilhados, inline e valores; nunca avalia nem expõe fórmulas', () => {
    const corpo = xlsx(
      {
        Dados:
          '<sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>inline</t></is></c></row>' +
          '<row r="3"><c r="A3"><v>42</v></c><c r="B3"><f>SUM(A1:A2)+HYPERLINK("http://mal")</f><v>7</v></c></row>' +
          '</sheetData>',
      },
      ['cabeçalho'],
      { 'xl/vbaProject.bin': 'macro maliciosa' },
    );
    const [folha] = lerXlsx(corpo);
    expect(folha?.nome).toBe('Dados');
    expect(folha?.linhas).toEqual([
      ['cabeçalho', '', 'inline'],
      ['42', '7'],
    ]);
    expect(JSON.stringify(folha)).not.toContain('SUM');
  });

  it('propaga o valor de células mescladas para as linhas cobertas', () => {
    const corpo = xlsx(
      {
        T:
          '<sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2"><v>1.01</v></c><c r="B2"><v>100</v></c></row>' +
          '<row r="3"><c r="A3"/><c r="B3"><v>200</v></c></row>' +
          '</sheetData><mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells>',
      },
      ['Item', 'NBS'],
    );
    expect(lerXlsx(corpo)[0]?.linhas).toEqual([
      ['Item', 'NBS'],
      ['1.01', '100'],
      ['1.01', '200'],
    ]);
  });

  it('recusa planilha acima do limite de linhas', () => {
    const linhas = Array.from({ length: 20 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    expect(() => lerXlsx(xlsx({ T: `<sheetData>${linhas}</sheetData>` }, []), { maxLinhas: 10 })).toThrow(ErroParser);
  });

  it('recusa XLSX sem workbook', () => {
    expect(() => lerXlsx(criarZip([{ nome: 'x.txt', conteudo: 'x' }]))).toThrow(/workbook/);
  });
});

describe('tabelasDeXlsx', () => {
  const planilha = {
    nome: 'tabela geral',
    linhas: [
      ['Anexo VIII – Tabela de correlação'],
      ['Item LC 116', 'Descrição Item', 'NBS', 'INDOP', 'cClassTrib', 'nome cClassTrib'],
      ['01.01', 'Análise e desenvolvimento de sistemas.', '1.1502.10.00', '100301', '000001', 'Situações tributadas integralmente'],
      ['01.01', 'Análise e desenvolvimento de sistemas.', '1.1502.20.00'],
    ],
  };

  it('acha o cabeçalho abaixo do título, usa o slug do anexo e extrai códigos normalizados', () => {
    const url = 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/anexo_viii-tabela-correlacao-v01-02-00-20261026.xlsx';
    const [tabela] = tabelasDeXlsx([planilha], url);
    expect(tabela?.slug).toBe('correlacao-item-nbs-indop-cclasstrib');
    expect(tabela?.colunas).toEqual(['Item LC 116', 'Descrição Item', 'NBS', 'INDOP', 'cClassTrib', 'nome cClassTrib']);
    expect(tabela?.linhas).toHaveLength(2);
    expect(tabela?.linhas[0]?.dados.cClassTrib).toBe('000001');
    expect(tabela?.linhas[0]?.codigos).toEqual(expect.arrayContaining(['01.01', '0101', '1.1502.10.00', '115021000', '100301', '000001']));
    expect(tabela?.linhas[0]?.codigos.join(' ')).not.toContain('ANÁLISE');
    expect(tabela?.titulo).toContain('Anexo VIII');
  });

  it('dá slug por planilha quando há mais de uma útil e slug estável (sem versão) para anexo desconhecido', () => {
    const outra = { nome: 'REGRA OP', linhas: [['Código', 'Descrição'], ['1', 'x']] };
    const tabelas = tabelasDeXlsx([planilha, outra, { nome: 'vazia', linhas: [] }], 'https://www.gov.br/nfse/anexo_iv-adn-snnfse-v1-00-20251216.xlsx');
    expect(tabelas.map((t) => t.slug)).toEqual(['anexo-iv-adn-snnfse-tabela-geral', 'anexo-iv-adn-snnfse-regra-op']);
    for (const t of tabelas) expect(t.slug).toMatch(/^[a-z0-9-]{1,120}$/);
  });

  it('não confunde o anexo IV (leiaute ADN) com o anexo VI', () => {
    const [t] = tabelasDeXlsx([planilha], 'https://www.gov.br/nfse/anexoiv-leiautesrn_adn-snnfse_v1-00-02-producao.xlsx');
    expect(t?.slug.startsWith('anexo-vi-')).toBe(false);
  });

  it('normalizarCodigo remove espaços e põe em maiúsculas', () => {
    expect(normalizarCodigo('  1 01 1 01 ')).toBe('101101');
    expect(normalizarCodigo('cClassTrib')).toBe('CCLASSTRIB');
  });
});
