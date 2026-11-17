import { Parser } from 'htmlparser2';
import { ErroParser } from './erro.ts';

export interface NoXml {
  readonly nome: string;
  readonly atributos: Readonly<Record<string, string>>;
  readonly filhos: readonly NoXml[];
  /** Texto direto do elemento (sem o dos filhos), na ordem em que aparece. */
  readonly texto: string;
}

export interface OpcoesXml {
  readonly maxBytes?: number;
  readonly maxNos?: number;
  readonly maxProfundidade?: number;
}

export interface ManipuladorXml {
  abrir(nome: string, atributos: Record<string, string>): void;
  texto(texto: string): void;
  fechar(nome: string): void;
}

const MAX_BYTES_PADRAO = 64 * 1024 * 1024;
const MAX_NOS_PADRAO = 5_000_000;
const MAX_PROFUNDIDADE_PADRAO = 256;

/**
 * Percorre XML em fluxo, sem montar árvore.
 *
 * hazard: o XML vem de site externo. DTD é recusada antes do parse (XXE, "billion laughs"); o
 * htmlparser2 em modo XML só decodifica as entidades predefinidas e numéricas, nunca entidades
 * declaradas, e nunca busca recurso externo (SEGURANCA.md §8).
 */
export function percorrerXml(texto: string, manipulador: ManipuladorXml, opcoes: OpcoesXml = {}): void {
  const maxBytes = opcoes.maxBytes ?? MAX_BYTES_PADRAO;
  const maxNos = opcoes.maxNos ?? MAX_NOS_PADRAO;
  const maxProfundidade = opcoes.maxProfundidade ?? MAX_PROFUNDIDADE_PADRAO;
  if (Buffer.byteLength(texto, 'utf8') > maxBytes) throw new ErroParser(`XML maior que ${maxBytes} bytes`);
  if (/<!DOCTYPE|<!ENTITY/i.test(texto)) throw new ErroParser('XML com DTD ou declaração de entidade recusado');

  let nos = 0;
  let profundidade = 0;
  let erro: ErroParser | undefined;
  const parser = new Parser(
    {
      onopentag(nome, atributos) {
        if (erro !== undefined) return;
        nos++;
        profundidade++;
        if (nos > maxNos) erro = new ErroParser(`XML com mais de ${maxNos} elementos`);
        else if (profundidade > maxProfundidade) erro = new ErroParser(`XML com profundidade maior que ${maxProfundidade}`);
        else manipulador.abrir(nome, atributos);
      },
      ontext(t) {
        if (erro === undefined) manipulador.texto(t);
      },
      onclosetag(nome) {
        if (erro !== undefined) return;
        profundidade--;
        manipulador.fechar(nome);
      },
      onprocessinginstruction(nome) {
        if (erro === undefined && nome.startsWith('!')) erro = new ErroParser('XML com declaração recusada');
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeCDATA: true, recognizeSelfClosing: true },
  );
  try {
    parser.write(texto);
    parser.end();
  } catch (e) {
    if (e instanceof ErroParser) throw e;
    throw new ErroParser(`XML inválido: ${e instanceof Error ? e.message : 'erro'}`);
  }
  if (erro !== undefined) throw erro;
}

interface NoMutavel {
  nome: string;
  atributos: Record<string, string>;
  filhos: NoMutavel[];
  texto: string;
}

export function analisarXml(texto: string, opcoes: OpcoesXml = {}): NoXml {
  const pilha: NoMutavel[] = [];
  let raiz: NoMutavel | undefined;
  percorrerXml(
    texto.startsWith('﻿') ? texto.slice(1) : texto,
    {
      abrir(nome, atributos) {
        const no: NoMutavel = { nome, atributos: { ...atributos }, filhos: [], texto: '' };
        const pai = pilha.at(-1);
        if (pai === undefined) {
          if (raiz !== undefined) throw new ErroParser('XML com mais de um elemento raiz');
          raiz = no;
        } else {
          pai.filhos.push(no);
        }
        pilha.push(no);
      },
      texto(t) {
        const atual = pilha.at(-1);
        if (atual !== undefined) atual.texto += t;
      },
      fechar() {
        pilha.pop();
      },
    },
    opcoes,
  );
  if (raiz === undefined) throw new ErroParser('XML sem elemento raiz');
  return raiz;
}

/** Texto do elemento e de todos os descendentes, na ordem do documento. */
export function textoCompleto(no: NoXml): string {
  return no.texto + no.filhos.map(textoCompleto).join('');
}

/** Nome local, sem prefixo de namespace (`xs:element` → `element`). */
export function nomeLocal(nome: string): string {
  const i = nome.indexOf(':');
  return i === -1 ? nome : nome.slice(i + 1);
}
