import { describe, expect, it } from 'vitest';
import { ErroParser } from './erro.ts';
import { camposDeXsd } from './xsd.ts';

const CAB = '<?xml version="1.0" encoding="UTF-8"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" targetNamespace="http://www.sped.fazenda.gov.br/nfse">';
const FIM = '</xs:schema>';

const DPS = `${CAB}<xs:include schemaLocation="tiposComplexos_v1.01.xsd"/>
  <xs:element name="DPS" type="TCDPS"><xs:annotation><xs:documentation>Declaração de Prestação de Serviços</xs:documentation></xs:annotation></xs:element>${FIM}`;

const TIPOS = `${CAB}
  <xs:complexType name="TCDPS">
    <xs:sequence>
      <xs:element name="infDPS" type="TCInfDPS"/>
      <xs:element ref="ds:Signature" minOccurs="0"/>
    </xs:sequence>
    <xs:attribute name="versao" type="TVer" use="required"/>
  </xs:complexType>
  <xs:complexType name="TCInfDPS">
    <xs:sequence>
      <xs:element name="dhEmi" type="TSDateTimeUTC"><xs:annotation><xs:documentation>  Data e hora
        da emissão </xs:documentation></xs:annotation></xs:element>
      <xs:element name="prest" type="TCPrest"/>
      <xs:choice><xs:element name="CNPJ" type="TSCNPJ"/><xs:element name="CPF" type="TSCPF"/></xs:choice>
      <xs:element name="obs" minOccurs="0" maxOccurs="unbounded"><xs:simpleType><xs:restriction base="xs:string"/></xs:simpleType></xs:element>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="TCPrest">
    <xs:complexContent><xs:extension base="TCBase"><xs:sequence><xs:element name="IM" type="xs:string"/></xs:sequence></xs:extension></xs:complexContent>
  </xs:complexType>
  <xs:complexType name="TCBase"><xs:sequence><xs:element name="xNome" type="TSNome"/></xs:sequence></xs:complexType>
  <xs:simpleType name="TSCNPJ"><xs:annotation><xs:documentation>Número do CNPJ</xs:documentation></xs:annotation><xs:restriction base="xs:string"/></xs:simpleType>
${FIM}`;

describe('camposDeXsd', () => {
  it('monta caminhos a partir da raiz, resolvendo tipos, escolhas, herança e documentação', () => {
    const campos = camposDeXsd([
      { nome: 'Schemas/1.01/DPS_v1.01.xsd', conteudo: DPS },
      { nome: 'Schemas/1.01/tiposComplexos_v1.01.xsd', conteudo: TIPOS },
    ]);
    const porCaminho = new Map(campos.map((c) => [c.caminho, c]));
    expect([...porCaminho.keys()]).toEqual([
      'DPS',
      'DPS/infDPS',
      'DPS/infDPS/dhEmi',
      'DPS/infDPS/prest',
      'DPS/infDPS/prest/xNome',
      'DPS/infDPS/prest/IM',
      'DPS/infDPS/CNPJ',
      'DPS/infDPS/CPF',
      'DPS/infDPS/obs',
      'DPS/Signature',
      'DPS/@versao',
    ]);
    expect(porCaminho.get('DPS')?.descricao).toBe('Declaração de Prestação de Serviços');
    expect(porCaminho.get('DPS/infDPS/dhEmi')).toMatchObject({ tipo: 'TSDateTimeUTC', descricao: 'Data e hora da emissão', minOcorrencias: 1, maxOcorrencias: '1', versao: '1.01' });
    expect(porCaminho.get('DPS/infDPS/CNPJ')?.descricao).toBe('Número do CNPJ');
    expect(porCaminho.get('DPS/infDPS/obs')).toMatchObject({ tipo: 'string', minOcorrencias: 0, maxOcorrencias: 'unbounded' });
    expect(porCaminho.get('DPS/Signature')).toMatchObject({ minOcorrencias: 0, tipo: null });
    expect(porCaminho.get('DPS/@versao')).toMatchObject({ tipo: 'TVer', minOcorrencias: 1 });
    expect(porCaminho.get('DPS/infDPS/dhEmi')?.arquivo).toBe('Schemas/1.01/tiposComplexos_v1.01.xsd');
  });

  it('separa versões em pastas diferentes do mesmo ZIP', () => {
    const campos = camposDeXsd([
      { nome: 'Schemas/1.00/DPS_v1.00.xsd', conteudo: DPS },
      { nome: 'Schemas/1.00/tiposComplexos_v1.00.xsd', conteudo: TIPOS.replace('<xs:element name="obs"', '<xs:element name="obsAntigo"') },
      { nome: 'Schemas/1.01/DPS_v1.01.xsd', conteudo: DPS },
      { nome: 'Schemas/1.01/tiposComplexos_v1.01.xsd', conteudo: TIPOS },
    ]);
    expect(campos.filter((c) => c.versao === '1.00').some((c) => c.nome === 'obsAntigo')).toBe(true);
    expect(campos.filter((c) => c.versao === '1.01').some((c) => c.nome === 'obsAntigo')).toBe(false);
  });

  it('para em tipo recursivo e respeita o limite de campos', () => {
    const recursivo = `${CAB}<xs:element name="no" type="TNo"/><xs:complexType name="TNo"><xs:sequence><xs:element name="filho" type="TNo" minOccurs="0"/></xs:sequence></xs:complexType>${FIM}`;
    expect(camposDeXsd([{ nome: 'r.xsd', conteudo: recursivo }]).map((c) => c.caminho)).toEqual(['no', 'no/filho']);
    expect(() => camposDeXsd([{ nome: 'DPS.xsd', conteudo: DPS }, { nome: 'tipos.xsd', conteudo: TIPOS }], { maxCampos: 3 })).toThrow(ErroParser);
  });

  it('ignora arquivo com DTD e o esquema de assinatura (xmldsig)', () => {
    const comDtd = `<!DOCTYPE schema [<!ENTITY x "y">]>${CAB}<xs:element name="Perigo" type="xs:string"/>${FIM}`;
    const dsig = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://www.w3.org/2000/09/xmldsig#"><xs:element name="Signature" type="xs:string"/></xs:schema>';
    const campos = camposDeXsd([
      { nome: 'a.xsd', conteudo: comDtd },
      { nome: 'xmldsig-core-schema.xsd', conteudo: dsig },
      { nome: 'leia.txt', conteudo: '<x/>' },
    ]);
    expect(campos).toEqual([]);
  });
});
