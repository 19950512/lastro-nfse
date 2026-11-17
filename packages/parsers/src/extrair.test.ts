import { describe, expect, it } from 'vitest';
import { extrairDocumento } from './extrair.ts';
import { criarPdf } from './pdf-para-teste.ts';
import { criarZip } from './zip-para-teste.ts';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('extrairDocumento', () => {
  it('HTML vira trechos de texto', async () => {
    const r = await extrairDocumento(Buffer.from('<main><h1>FAQ</h1><p>Resposta oficial.</p></main>'), 'text/html; charset=utf-8', 'https://www.gov.br/nfse/faq');
    expect(r).toEqual({ tipo: 'texto', trechos: [{ ordem: 0, texto: 'FAQ\nResposta oficial.', paginaIni: null, paginaFim: null, secao: 'FAQ' }] });
  });

  it('PDF vira trechos com página', async () => {
    const r = await extrairDocumento(criarPdf(['Art. 1 Texto oficial', 'Art. 2 Outro']), 'application/pdf', 'https://www.gov.br/nfse/x.pdf');
    expect(r.tipo).toBe('texto');
    if (r.tipo !== 'texto') return;
    expect(r.trechos.map((t) => [t.secao, t.paginaIni])).toEqual([
      ['Art. 1', 1],
      ['Art. 2', 2],
    ]);
  });

  it('ZIP com XSD vira dicionário de leiaute; sem XSD é ignorado', async () => {
    const xsd = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="DPS" type="xs:string"><xs:annotation><xs:documentation>Raiz</xs:documentation></xs:annotation></xs:element></xs:schema>';
    const r = await extrairDocumento(criarZip([{ nome: 'DPS_v1.01.xsd', conteudo: xsd }]), 'application/zip', 'https://www.gov.br/nfse/xsd.zip');
    expect(r.tipo).toBe('leiaute');
    if (r.tipo !== 'leiaute') return;
    expect(r.campos).toEqual([{ nome: 'DPS', caminho: 'DPS', tipo: 'string', minOcorrencias: 1, maxOcorrencias: '1', descricao: 'Raiz', arquivo: 'DPS_v1.01.xsd', versao: '1.01' }]);
    expect(r.trechos[0]?.texto).toBe('DPS (string, ocorrência 1-1): Raiz');
    const semXsd = await extrairDocumento(criarZip([{ nome: 'leia.txt', conteudo: 'x' }]), 'application/zip', 'https://www.gov.br/nfse/x.zip');
    expect(semXsd.tipo).toBe('ignorado');
  });

  it('XLSX vira tabelas e um trecho descritivo por tabela', async () => {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const corpo = criarZip([
      { nome: 'xl/workbook.xml', conteudo: `<workbook ${ns}><sheets><sheet name="IndOp" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { nome: 'xl/_rels/workbook.xml.rels', conteudo: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
      {
        nome: 'xl/worksheets/sheet1.xml',
        conteudo: `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Código indOp</t></is></c><c r="B1" t="inlineStr"><is><t>Tipo de operação</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>010101</t></is></c><c r="B2" t="inlineStr"><is><t>Bem móvel</t></is></c></row></sheetData></worksheet>`,
      },
    ]);
    const r = await extrairDocumento(corpo, XLSX, 'https://www.gov.br/nfse/anexo-c-indop-ibscbs-snnfse-v1-01.xlsx');
    expect(r.tipo).toBe('tabelas');
    if (r.tipo !== 'tabelas') return;
    expect(r.tabelas[0]?.slug).toBe('indop-ibscbs');
    expect(r.tabelas[0]?.linhas[0]?.codigos).toEqual(['010101']);
    expect(r.trechos[0]?.texto).toContain('Colunas: Código indOp; Tipo de operação');
  });

  it('tipo sem extrator e página sem texto são ignorados com motivo', async () => {
    expect(await extrairDocumento(Buffer.from('x'), 'application/msword', 'https://www.gov.br/nfse/x.doc')).toEqual({ tipo: 'ignorado', motivo: 'tipo sem extrator: application/msword' });
    expect((await extrairDocumento(Buffer.from('<script>x()</script>'), 'text/html', 'https://www.gov.br/nfse/x')).tipo).toBe('ignorado');
  });
});
