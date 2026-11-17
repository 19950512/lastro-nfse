# Lastro — NFS-e e reforma tributária com fonte oficial

> Nome escolhido, **pendente de busca de marca no INPI** (ver decisões em aberto no [ROADMAP.md](docs/ROADMAP.md)).

Plataforma que responde perguntas sobre NFS-e no Brasil **somente com base em canais oficiais**, sempre com fonte, data e versão do documento. Também classifica alegações que circulam na internet (posts, vídeos, mensagens) como confirmadas, falsas, desatualizadas ou sem respaldo oficial.

## Por que existe

Para saber o estado real da NFS-e hoje é preciso acompanhar pelo menos: Portal Nacional da NFS-e, resoluções do Comitê Gestor da NFS-e, Receita Federal, Comitê Gestor do IBS, Simples Nacional, Diário Oficial e a legislação da reforma tributária. Cada canal publica em um formato (notícia, PDF de Nota Técnica, planilha, XSD, resolução no DOU), e as datas mudam com frequência. Enquanto isso, perfis em redes sociais e blogs publicam interpretações que muitas vezes estão desatualizadas ou erradas, e empresas tomam decisões com base nelas.

Exemplo real (16/11/2026): circulam várias datas diferentes para a obrigatoriedade de IBS/CBS na NFS-e. O cronograma do Ato Conjunto RFB/CGIBS nº 4/2026 mostrava que todas existiam, mas cada uma valia para um grupo diferente de contribuintes. Depois, o Ato Conjunto nº 7/2026 (DOU de 13/11/2026) adiou as datas de 01/12/2026 para 01/01/2027 e 01/03/2027. Quem divulga uma só data está generalizando, e quem ainda divulga "1º de dezembro" está desatualizado. O levantamento manual deste plano só percebeu a mudança quando a sondagem automatizada da Fase 0 encontrou a notícia (ver [FONTES-OFICIAIS.md](docs/FONTES-OFICIAIS.md)). É esse o tipo de ruído a eliminar.

## Princípios inegociáveis

1. **Somente fontes oficiais.** A plataforma coleta, indexa e cita apenas publicações de órgãos públicos com competência sobre o tema, a partir de uma lista fechada de domínios e órgãos. Nada de blogs, consultorias, associações privadas ou redes sociais.
2. **Nada sem fonte.** Toda frase factual da resposta aponta para um trecho de documento oficial arquivado.
3. **Ausência de evidência não é "fake".** Só se declara algo falso quando uma fonte oficial o contradiz explicitamente.
4. **Tempo importa.** Toda resposta diz "em vigor em DD/MM/AAAA", separa o que vale hoje do que tem vigência futura e mostra o que foi revogado ou prorrogado.
5. **Hierarquia normativa.** Lei Complementar > Resolução/Ato Conjunto > Nota Técnica > FAQ > notícia oficial. Conflitos são mostrados, não escondidos.
6. **Prova reproduzível.** Cada documento é guardado com hash e data de coleta, para mostrar o que a fonte dizia em qualquer data passada.
7. **Não é consultoria jurídica.** A plataforma informa o que as fontes oficiais dizem; não substitui o profissional.

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Componentes, fluxos, modelo de dados, stack, interfaces (API e MCP) |
| [docs/FONTES-OFICIAIS.md](docs/FONTES-OFICIAIS.md) | Catálogo das fontes por nível de autoridade, forma de coleta e status de validação |
| [docs/VERIFICACAO-DE-ALEGACOES.md](docs/VERIFICACAO-DE-ALEGACOES.md) | Como a plataforma decide se uma alegação é verdadeira, falsa ou desatualizada |
| [docs/SEGURANCA.md](docs/SEGURANCA.md) | Modelo de ameaças, XSS, CORS/CSRF, OWASP Top 10 (web, API, LLM), MCP, SSRF, LGPD e requisitos por fase |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Fases de entrega, métricas de qualidade, riscos e decisões em aberto |
| [docs/SONDAGEM-FASE-0.md](docs/SONDAGEM-FASE-0.md) | Relatório gerado da validação técnica das fontes (robots.txt, acesso, formato, estabilidade) |

## Como rodar

Requer Node.js 24+ e pnpm 11. O código TypeScript roda direto no Node (remoção de tipos nativa), sem etapa de build.

```sh
pnpm install
pnpm check                      # typecheck + lint + testes unitários

pnpm infra:env                  # cria .env com senhas aleatórias (nunca sobrescreve)
pnpm infra:subir                # Postgres + S3 com Object Lock (só em 127.0.0.1)
pnpm preparar                   # papéis do banco, migrações e bucket WORM (idempotente)
pnpm test:integracao            # testes contra Postgres e S3 reais

pnpm sondar                     # Fase 0: valida as fontes e regenera docs/SONDAGEM-FASE-0.md
pnpm coletar                    # coleta tudo e grava snapshots versionados
pnpm coletar --fonte nfse-rtc --sem-documentos
pnpm mudancas --desde 2026-11-01

pnpm api                        # API somente leitura + tela em http://127.0.0.1:8080/painel
pnpm lastro webhook adicionar --url https://seu-receptor/lastro [--formato slack] [--fonte nfse-rtc]
pnpm lastro webhook listar
pnpm notificar                  # envia aos assinantes os eventos pendentes
```

Agendamento sugerido: `pnpm coletar; pnpm notificar` a cada hora. As duas saem com código 2 quando há falha, para virar alerta.

O receptor confere o cabeçalho `lastro-assinatura: t=<unix>,v1=<hmac>`: HMAC-SHA256 de `<t>.<corpo>` com o segredo mostrado no cadastro, recusando `t` com mais de 5 minutos de diferença. Referência: `verificarAssinatura` em [packages/webhooks/src/assinatura.ts](packages/webhooks/src/assinatura.ts).

`LASTRO_ARQUIVO=postgres` (padrão do `.env` gerado) grava em Postgres + S3; `disco` grava em `dados/arquivo`, sem precisar de Docker.

| Pacote | Conteúdo |
|---|---|
| [packages/core](packages/core) | Lista fechada de origens oficiais e catálogo de fontes |
| [packages/ingest](packages/ingest) | Cliente HTTPS protegido (SSRF, fixação de DNS, limites), robots.txt, extração de links, impressão digital de conteúdo, arquivo em disco e coletor |
| [packages/db](packages/db) | Arquivo em Postgres + S3 WORM, consultas de leitura, migrações e papéis mínimos de banco |
| [packages/webhooks](packages/webhooks) | Assinaturas, HMAC, envio protegido contra SSRF e despacho com novas tentativas |
| [apps/worker](apps/worker) | CLI: `preparar`, `sondar`, `coletar`, `mudancas`, `webhook`, `notificar` |
| [apps/api](apps/api) | API REST somente leitura (`/v1/...`) e tela `/painel` |

`coletar` sai com código 2 quando alguma URL falha ou é bloqueada por robots.txt, para o agendador transformar isso em alerta.

## Decisões já tomadas

- Nome: **Lastro**, com o subtítulo "NFS-e e reforma tributária com fonte oficial". Domínio principal previsto: `lastro-nfse.com.br`. Depende da busca no INPI.
- Somente fontes oficiais (órgãos públicos); nenhuma fonte não oficial é coletada ou citada.
- ISS fica para uma fase posterior: legislação municipal, alíquotas, apuração e sites de prefeituras. A lista de serviços da LC 116 entra só como tabela de códigos usada no leiaute da NFS-e.
- Stack: TypeScript / Node.js 24.
- LLM: Claude (Anthropic API), modelo `claude-opus-5-5`.
- Fase 0 (sondagem automatizada das fontes) e Fase 1 (monitor: coleta segura, arquivo versionado WORM, detecção de mudança e de anomalia, API do feed, webhooks e tela) implementadas. Ver o estado de cada item e as pendências no [ROADMAP.md](docs/ROADMAP.md).
