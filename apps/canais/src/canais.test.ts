import { createHmac } from 'node:crypto';
import { ErroCota, type RespostaPergunta, type ResultadoVerificacao, type ServicoPerguntas, type ServicoVerificacoes } from '@lastro/llm';
import { beforeEach, describe, expect, it } from 'vitest';
import { construirCanais, type DependenciasCanais, type OpcoesCanais } from './app.ts';
import { escaparSlack, interpretarComando, mensagemResposta, urlRespostaValida, verificarAssinaturaSlack } from './slack.ts';

const SEGREDO = 'segredo-do-slack-'.repeat(2);
const AGORA = new Date('2026-11-17T12:00:00Z');
const TS = String(Math.floor(AGORA.getTime() / 1000));
const TEAM = 'T0LASTRO1';
const CLIENTE = '99999999-9999-4999-8999-99999999999b';
const URL_RESPOSTA = 'https://hooks.slack.com/commands/T0LASTRO1/123/abc';
const MALICIOSO = '<!channel> <https://atacante.example|clique> & <@U123>';

const resposta: RespostaPergunta = {
  situacao: 'respondida',
  rota: 'prazo',
  resposta: `Vale em 01/01/2027 [1]. ${MALICIOSO}`,
  posicao_em: '2026-11-17',
  fontes: [
    {
      id: 1,
      titulo: 'nt-009|<!here>.pdf',
      orgao: 'SE/CGNFS-e',
      nivel: 'N2',
      url: 'https://www.gov.br/nfse/nt-009.pdf?a=1|b>c',
      secao: null,
      pagina: 2,
      trecho: 'passa a valer',
      coletado_em: '2026-11-16T10:00:00.000Z',
      confirmado_em: '2026-11-16T12:00:00.000Z',
      sha256: 'c'.repeat(64),
      snapshot_id: '33333333-3333-4333-8333-333333333333',
      documento_id: '11111111-1111-4111-8111-111111111111',
      original: '/v1/snapshots/33333333-3333-4333-8333-333333333333/original',
    },
  ],
  avisos: [],
  limites: [],
  aviso: 'Não substitui orientação profissional.',
  checagem: { citacoes_invalidas: 0, frases_sem_citacao_removidas: 0, conteudo_removido: 0 },
};

const resultado = {
  situacao: 'verificada',
  posicao_em: '2026-11-17',
  alegacoes: [{ id: 'C1', alegacao: `MEI é obrigado ${MALICIOSO}`, rotulo: 'FALSO', explicacao: 'A fonte diz outra coisa.' }],
  avisos: [],
  limites: [],
  aviso: 'Não substitui orientação profissional.',
  checagem: { citacoes_invalidas: 0, vereditos_rebaixados: 0 },
} as unknown as ResultadoVerificacao;

const chamadas: string[] = [];
const respostas: { url: string; text: string }[] = [];

const perguntas: ServicoPerguntas = {
  responder: (s, p) => {
    chamadas.push(`pergunta:${s.canal}:${s.clienteId}:${p}`);
    return Promise.resolve({ id: '66666666-6666-4666-8666-666666666666', resposta });
  },
  obter: () => Promise.resolve(undefined),
};

const verificacoes: ServicoVerificacoes = {
  verificar: (s, texto) => {
    chamadas.push(`verificacao:${s.canal}:${s.clienteId}:${texto}`);
    return Promise.resolve({ id: '14141414-1414-4414-8414-141414141414', criadaEm: '', expiraEm: '', resultado });
  },
  obter: () => Promise.resolve(undefined),
  compartilhar: () => Promise.resolve('t'.repeat(43)),
  revogarCompartilhamento: () => Promise.resolve(false),
  obterCompartilhada: () => Promise.resolve(undefined),
};

function canais(extras: Partial<DependenciasCanais> = {}, opcoes: OpcoesCanais = {}) {
  return construirCanais(
    {
      perguntas,
      verificacoes,
      clienteDoSlack: (team) => Promise.resolve(team === TEAM ? CLIENTE : undefined),
      segredoSlack: SEGREDO,
      responder: (url, corpo) => {
        respostas.push({ url, text: corpo.text });
        return Promise.resolve();
      },
      urlPublicaApi: 'https://api.lastro.example',
      agora: () => AGORA,
      ...extras,
    },
    opcoes,
  );
}

function comando(campos: Record<string, string>, cabecalhos: Record<string, string> = {}, segredo = SEGREDO, ts = TS) {
  const corpo = new URLSearchParams({ team_id: TEAM, user_id: 'U0ANA', command: '/lastro', response_url: URL_RESPOSTA, ...campos }).toString();
  const assinatura = `v0=${createHmac('sha256', segredo).update(`v0:${ts}:${corpo}`).digest('hex')}`;
  return {
    method: 'POST' as const,
    url: '/slack/comandos',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': assinatura, ...cabecalhos },
    payload: corpo,
  };
}

beforeEach(() => {
  chamadas.length = 0;
  respostas.length = 0;
});

describe('autenticidade do pedido', () => {
  it.each([
    ['segredo errado', comando({ text: 'Quando vale?' }, {}, 'outro-segredo-qualquer')],
    ['pedido velho (reenvio)', comando({ text: 'Quando vale?' }, {}, SEGREDO, String(Number(TS) - 301))],
    ['sem assinatura', { ...comando({ text: 'Quando vale?' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
  ])('recusa %s sem consultar nada', async (_nome, pedido) => {
    const app = canais();
    expect((await app.inject(pedido)).statusCode).toBe(401);
    await app.close();
    expect(chamadas).toHaveLength(0);
  });

  it('corpo alterado depois de assinado é recusado', async () => {
    const pedido = comando({ text: 'Quando vale?' });
    const r = await canais().inject({ ...pedido, payload: pedido.payload.replace('Quando', 'Quanto') });
    expect(r.statusCode).toBe(401);
  });

  it('reenvio do Slack e ssl_check respondem 200 sem processar', async () => {
    const app = canais();
    expect((await app.inject(comando({ text: 'Quando vale?' }, { 'x-slack-retry-num': '1' }))).statusCode).toBe(200);
    expect((await app.inject(comando({ ssl_check: '1' }))).statusCode).toBe(200);
    await app.close();
    expect(chamadas).toHaveLength(0);
  });

  it('response_url fora do Slack é recusada (SSRF)', async () => {
    const app = canais();
    const r = await app.inject(comando({ text: 'Quando vale?', response_url: 'https://169.254.169.254/latest' }));
    expect(r.statusCode).toBe(400);
    await app.close();
    expect(chamadas).toHaveLength(0);
  });
});

describe('comandos', () => {
  it('pergunta: confirma na hora e responde depois na response_url, em nome do cliente do workspace', async () => {
    const app = canais();
    const r = await app.inject(comando({ text: 'Quando vale o IBS?' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ response_type: 'ephemeral', text: 'Consultando as fontes oficiais…' });
    await app.close();
    expect(chamadas).toEqual([`pergunta:slack:${CLIENTE}:Quando vale o IBS?`]);
    expect(respostas).toHaveLength(1);
    expect(respostas[0]?.url).toBe(URL_RESPOSTA);
    const texto = respostas[0]?.text ?? '';
    expect(texto).not.toContain('<!channel>');
    expect(texto).not.toContain('<@U123>');
    expect(texto).toContain('&lt;!channel&gt;');
    expect(texto).toContain('<https://www.gov.br/nfse/nt-009.pdf?a=1%7Cb%3Ec|nt-009¦&lt;!here&gt;.pdf>');
  });

  it('checar: verifica e manda o link público da verificação', async () => {
    const app = canais();
    const r = await app.inject(comando({ text: 'checar MEI é obrigado a emitir NFS-e nacional' }));
    expect(r.json()).toMatchObject({ text: 'Verificando as alegações nas fontes oficiais…' });
    await app.close();
    expect(chamadas).toEqual([`verificacao:slack:${CLIENTE}:MEI é obrigado a emitir NFS-e nacional`]);
    expect(respostas[0]?.text).toContain('*FALSO*');
    expect(respostas[0]?.text).toContain(`<https://api.lastro.example/verificacoes/${'t'.repeat(43)}|abrir verificação>`);
    expect(respostas[0]?.text).not.toContain('<!channel>');
  });

  it('ajuda não consulta o vínculo nem o modelo', async () => {
    let consultado = false;
    const app = canais({ clienteDoSlack: () => ((consultado = true), Promise.resolve(CLIENTE)) });
    const r = await app.inject(comando({ text: '' }));
    expect(r.json<{ text: string }>().text).toContain('/lastro checar');
    expect(consultado).toBe(false);
  });

  it('workspace sem vínculo recebe aviso e não gasta nada', async () => {
    const app = canais();
    const r = await app.inject(comando({ text: 'Quando vale?', team_id: 'T0OUTRO' }));
    expect(r.json<{ text: string }>().text).toContain('não está vinculado');
    await app.close();
    expect(chamadas).toHaveLength(0);
  });

  it('cota esgotada vira mensagem amigável na response_url', async () => {
    const app = canais({ perguntas: { ...perguntas, responder: () => Promise.reject(new ErroCota('cota-mensal')) } });
    await app.inject(comando({ text: 'Quando vale?' }));
    await app.close();
    expect(respostas[0]?.text).toContain('cota do plano');
  });

  it('limite por usuário por hora', async () => {
    const app = canais({}, { limitePorHoraUsuario: 2 });
    for (let i = 0; i < 2; i++) expect((await app.inject(comando({ text: 'Quando vale?' }))).json<{ text: string }>().text).toBe('Consultando as fontes oficiais…');
    expect((await app.inject(comando({ text: 'Quando vale?' }))).json<{ text: string }>().text).toContain('na última hora');
    expect((await app.inject(comando({ text: 'Quando vale?', user_id: 'U0BIA' }))).json<{ text: string }>().text).toBe('Consultando as fontes oficiais…');
    await app.close();
    expect(chamadas).toHaveLength(3);
  });
});

describe('funções do Slack', () => {
  it('interpreta comandos', () => {
    expect(interpretarComando('  ')).toEqual({ tipo: 'ajuda' });
    expect(interpretarComando('AJUDA')).toEqual({ tipo: 'ajuda' });
    expect(interpretarComando('Checar   texto do post')).toEqual({ tipo: 'verificacao', texto: 'texto do post' });
    expect(interpretarComando('checaram o prazo?')).toEqual({ tipo: 'pergunta', texto: 'checaram o prazo?' });
  });

  it.each([
    ['https://hooks.slack.com/commands/T1/2/3', true],
    ['https://hooks.slack.com/services/T1/2/3', false],
    ['http://hooks.slack.com/commands/T1/2/3', false],
    ['https://hooks.slack.com.atacante.example/commands/x', false],
    ['https://hooks.slack.com:8443/commands/x', false],
    ['https://u:p@hooks.slack.com/commands/x', false],
    ['nada', false],
  ])('response_url %s → %s', (url, valida) => {
    expect(urlRespostaValida(url)).toBe(valida);
  });

  it('assinatura: formato e janela de tempo', () => {
    const corpo = 'a=1';
    const ok = `v0=${createHmac('sha256', SEGREDO).update(`v0:${TS}:${corpo}`).digest('hex')}`;
    expect(verificarAssinaturaSlack(SEGREDO, TS, corpo, ok, AGORA)).toBe(true);
    expect(verificarAssinaturaSlack(SEGREDO, TS, corpo, ok, new Date(AGORA.getTime() + 301_000))).toBe(false);
    expect(verificarAssinaturaSlack(SEGREDO, 'abc', corpo, ok, AGORA)).toBe(false);
    expect(verificarAssinaturaSlack(SEGREDO, TS, corpo, 'v1=zz', AGORA)).toBe(false);
  });

  it('mensagem escapa texto e mantém link só https', () => {
    expect(escaparSlack('<a> & b')).toBe('&lt;a&gt; &amp; b');
    const m = mensagemResposta({ ...resposta, fontes: [{ ...(resposta.fontes[0] ?? ({} as never)), url: 'javascript:alert(1)' }] });
    expect(m).not.toContain('javascript:');
  });
});
