import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { criarLookupSeguro, EnderecoBloqueado, enderecoPublico } from './rede.ts';

describe('enderecoPublico', () => {
  it.each(['200.152.38.155', '8.8.8.8', '2804:214:8000::1', '2001:4860:4860::8888'])('aceita %s', (ip) => {
    expect(enderecoPublico(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.0.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '2002:7f00:1::1',
    '64:ff9b::a00:1',
    '2001::1',
    'não é ip',
  ])('recusa %s', (ip) => {
    expect(enderecoPublico(ip)).toBe(false);
  });
});

function resolverCom(enderecos: LookupAddress[]) {
  return (_host: string, _opcoes: unknown, callback: (erro: NodeJS.ErrnoException | null, e: LookupAddress[]) => void) => {
    callback(null, enderecos);
  };
}

function chamar(lookup: ReturnType<typeof criarLookupSeguro>, all: boolean) {
  return new Promise<{ erro: Error | null; endereco: unknown }>((resolve) => {
    (lookup as unknown as (h: string, o: object, cb: (e: Error | null, a: unknown) => void) => void)(
      'www.gov.br',
      { all },
      (erro, endereco) => {
        resolve({ erro, endereco });
      },
    );
  });
}

describe('criarLookupSeguro', () => {
  it('devolve o endereço público validado', async () => {
    const lookup = criarLookupSeguro(resolverCom([{ address: '200.152.38.155', family: 4 }]));
    expect(await chamar(lookup, false)).toEqual({ erro: null, endereco: '200.152.38.155' });
    expect((await chamar(lookup, true)).endereco).toEqual([{ address: '200.152.38.155', family: 4 }]);
  });

  it('recusa a resposta inteira se qualquer endereço for interno', async () => {
    const lookup = criarLookupSeguro(
      resolverCom([
        { address: '200.152.38.155', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]),
    );
    const { erro } = await chamar(lookup, true);
    expect(erro).toBeInstanceOf(EnderecoBloqueado);
  });

  it('recusa resposta vazia', async () => {
    const { erro } = await chamar(criarLookupSeguro(resolverCom([])), false);
    expect(erro).toBeInstanceOf(EnderecoBloqueado);
  });
});
