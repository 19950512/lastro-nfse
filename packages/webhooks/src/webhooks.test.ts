import { criarLookupSeguro } from '@lastro/ingest';
import { describe, expect, it } from 'vitest';
import { assinar, verificarAssinatura } from './assinatura.ts';
import { criarEnviadorHttps } from './envio.ts';
import { montarCorpo, type EventoParaEnvio } from './payload.ts';
import { validarUrlWebhook } from './url.ts';

describe('validarUrlWebhook', () => {
  it('aceita HTTPS com nome público', () => {
    expect(validarUrlWebhook('https://hooks.cliente.com.br/lastro').valida).toBe(true);
    expect(validarUrlWebhook('https://hooks.slack.com/services/T/B/X').valida).toBe(true);
  });

  it.each([
    ['http://cliente.com.br/x', 'HTTPS'],
    ['https://user:senha@cliente.com.br/x', 'credenciais'],
    ['https://127.0.0.1/x', 'IP literal'],
    ['https://169.254.169.254/latest', 'IP literal'],
    ['https://[::1]/x', 'IP literal'],
    ['https://localhost/x', 'domínio público'],
    ['https://metadata.google.internal/x', 'interno'],
    ['https://nas.local/x', 'interno'],
    ['file:///etc/passwd', 'HTTPS'],
    ['nada', 'inválida'],
  ])('recusa %s', (url, motivo) => {
    const r = validarUrlWebhook(url);
    expect(r.valida).toBe(false);
    if (!r.valida) expect(r.motivo).toContain(motivo);
  });
});

describe('assinatura HMAC', () => {
  const agora = new Date('2026-11-16T12:00:00Z');

  it('verifica a própria assinatura e recusa corpo alterado', () => {
    const cabecalho = assinar('s'.repeat(64), '{"id":1}', agora);
    expect(cabecalho).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verificarAssinatura('s'.repeat(64), '{"id":1}', cabecalho, agora)).toBe(true);
    expect(verificarAssinatura('s'.repeat(64), '{"id":2}', cabecalho, agora)).toBe(false);
    expect(verificarAssinatura('outro-segredo', '{"id":1}', cabecalho, agora)).toBe(false);
  });

  it('recusa reenvio fora da tolerância (replay)', () => {
    const cabecalho = assinar('s'.repeat(64), 'x', agora);
    expect(verificarAssinatura('s'.repeat(64), 'x', cabecalho, new Date(agora.getTime() + 301_000))).toBe(false);
  });

  it('recusa cabeçalho malformado sem lançar', () => {
    expect(verificarAssinatura('s', 'x', 'lixo', agora)).toBe(false);
    expect(verificarAssinatura('s', 'x', 't=1,v1=zz', agora)).toBe(false);
  });
});

describe('montarCorpo', () => {
  const evento: EventoParaEnvio = {
    id: 'e1',
    tipo: 'nova-versao',
    fonteId: 'nfse-rtc',
    documentoId: 'd1',
    url: 'https://www.gov.br/nfse/<b>&x',
    detectadoEm: '2026-11-16T12:00:00.000Z',
    anomalia: 'texto encolheu',
  };

  it('formato lastro leva só identificação e links', () => {
    const corpo = JSON.parse(montarCorpo(evento, 'lastro', 'https://api.lastro.example/')) as Record<string, unknown>;
    expect(corpo).toEqual({
      id: 'e1',
      tipo: 'nova-versao',
      fonte_id: 'nfse-rtc',
      detectado_em: '2026-11-16T12:00:00.000Z',
      revisao_pendente: true,
      links: {
        documento: 'https://api.lastro.example/v1/documentos/d1',
        mudancas: 'https://api.lastro.example/v1/mudancas?desde=2026-11-16T12%3A00%3A00.000Z',
      },
    });
  });

  it('remove barras finais da URL pública em tempo linear', () => {
    const corpo = JSON.parse(montarCorpo(evento, 'lastro', 'https://api.lastro.example///')) as { links: { documento: string } };
    expect(corpo.links.documento).toBe('https://api.lastro.example/v1/documentos/d1');
    const inicio = performance.now();
    montarCorpo(evento, 'lastro', `https://a${'/'.repeat(40_000)}a`);
    expect(performance.now() - inicio).toBeLessThan(50);
  });

  it('formato slack escapa marcação', () => {
    const corpo = JSON.parse(montarCorpo(evento, 'slack', 'https://api.lastro.example')) as { text: string };
    expect(corpo.text).toContain('https://www.gov.br/nfse/&lt;b&gt;&amp;x');
    expect(corpo.text).toContain('marcado para revisão');
  });
});

describe('criarEnviadorHttps', () => {
  it('não conecta em host que resolve para rede interna', async () => {
    const seguro = criarLookupSeguro((_h, _o, cb) => {
      cb(null, [{ address: '10.0.0.5', family: 4 }]);
    });
    const r = await criarEnviadorHttps({ lookup: seguro, timeoutMs: 2000 })('https://hooks.cliente.com.br/x', '{}', {});
    expect(r).toEqual({ ok: false, status: null, erro: 'host resolve para endereço não público' });
  });

  it('recusa URL inválida sem tentar conexão', async () => {
    expect(await criarEnviadorHttps()('http://cliente.com.br/x', '{}', {})).toMatchObject({ ok: false, erro: 'só HTTPS é aceito' });
  });
});
