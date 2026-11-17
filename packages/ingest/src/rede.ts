import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * Aceita só endereço unicast público (SEGURANCA.md §8).
 *
 * invariant: lista positiva. Qualquer faixa que o ipaddr.js classifique como especial (privada,
 * loopback, link-local com 169.254.169.254, CGNAT, 6to4, Teredo, NAT64…) é recusada, inclusive
 * faixas que venham a ser adicionadas à biblioteca no futuro.
 */
export function enderecoPublico(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let endereco = ipaddr.parse(ip);
  if (endereco instanceof ipaddr.IPv6 && endereco.isIPv4MappedAddress()) {
    endereco = endereco.toIPv4Address();
  }
  return endereco.range() === 'unicast';
}

export class EnderecoBloqueado extends Error {
  readonly host: string;
  constructor(host: string, endereco: string) {
    super(`host ${host} resolve para endereço não público (${endereco})`);
    this.name = 'EnderecoBloqueado';
    this.host = host;
  }
}

type ResolverTodos = (
  host: string,
  opcoes: LookupAllOptions,
  callback: (erro: NodeJS.ErrnoException | null, enderecos: LookupAddress[]) => void,
) => void;

const resolverPadrao: ResolverTodos = (host, opcoes, callback) => {
  dnsLookup(host, opcoes, callback);
};

/**
 * Função `lookup` para `https.request`.
 *
 * invariant: o socket conecta exatamente no endereço validado aqui, então não há janela entre
 * checagem e uso (DNS rebinding) — a fixação do DNS exigida em SEGURANCA.md §8.
 * hazard: se qualquer endereço da resposta for não público, recusa tudo; escolher só os públicos
 * deixaria um DNS controlado por terceiros sondar a rede interna em outra tentativa.
 */
export function criarLookupSeguro(resolver: ResolverTodos = resolverPadrao): LookupFunction {
  const lookupSeguro = (
    host: string,
    opcoes: { family?: number | string; all?: boolean },
    callback: (erro: NodeJS.ErrnoException | null, endereco: string | LookupAddress[], familia?: number) => void,
  ): void => {
    const familia = opcoes.family === 'IPv4' || opcoes.family === 4 ? 4 : opcoes.family === 'IPv6' || opcoes.family === 6 ? 6 : 0;
    resolver(host, { all: true, family: familia }, (erro, enderecos) => {
      if (erro !== null) {
        callback(erro, []);
        return;
      }
      const recusado = enderecos.find((e) => !enderecoPublico(e.address));
      const primeiro = enderecos[0];
      if (recusado !== undefined || primeiro === undefined) {
        callback(new EnderecoBloqueado(host, recusado?.address ?? 'nenhum'), []);
        return;
      }
      if (opcoes.all === true) callback(null, enderecos);
      else callback(null, primeiro.address, primeiro.family);
    });
  };
  return lookupSeguro as unknown as LookupFunction;
}
