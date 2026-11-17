import { describe, expect, it } from 'vitest';
import { ErroParser } from './erro.ts';
import { analisarXml, textoCompleto } from './xml.ts';

describe('analisarXml', () => {
  it('monta a árvore com prefixos, atributos, entidades predefinidas e CDATA', () => {
    const raiz = analisarXml('﻿<?xml version="1.0"?><xs:schema a="1"><xs:element name="x">a &amp; b<![CDATA[<c>]]></xs:element><y/></xs:schema>');
    expect(raiz.nome).toBe('xs:schema');
    expect(raiz.atributos).toEqual({ a: '1' });
    expect(raiz.filhos.map((f) => f.nome)).toEqual(['xs:element', 'y']);
    expect(textoCompleto(raiz)).toBe('a & b<c>');
  });

  it('recusa DTD e entidades declaradas (XXE, billion laughs)', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>';
    const risos = '<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><l>&b;</l>';
    expect(() => analisarXml(xxe)).toThrow(ErroParser);
    expect(() => analisarXml(risos)).toThrow(ErroParser);
    expect(() => analisarXml('<r><!ENTITY x "y"></r>')).toThrow(ErroParser);
  });

  it('não expande entidade desconhecida', () => {
    expect(textoCompleto(analisarXml('<r>&inexistente;</r>'))).toBe('&inexistente;');
  });

  it('aplica limites de tamanho, número de elementos e profundidade', () => {
    expect(() => analisarXml('<r>' + 'x'.repeat(2000) + '</r>', { maxBytes: 1000 })).toThrow(/maior/);
    expect(() => analisarXml('<r>' + '<a/>'.repeat(50) + '</r>', { maxNos: 10 })).toThrow(/elementos/);
    expect(() => analisarXml('<a>'.repeat(30) + '</a>'.repeat(30), { maxProfundidade: 20 })).toThrow(/profundidade/);
  });

  it('recusa documento sem raiz ou com duas raízes', () => {
    expect(() => analisarXml('só texto')).toThrow(ErroParser);
    expect(() => analisarXml('<a/><b/>')).toThrow(ErroParser);
  });
});
