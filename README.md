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

pnpm infra:env                  # cria .env com senhas aleatórias (nunca sobrescreve; só acrescenta senhas de papéis novos)
pnpm infra:subir                # Postgres + S3 com Object Lock (só em 127.0.0.1)
pnpm preparar                   # papéis do banco, migrações e bucket WORM (idempotente)
pnpm test:integracao            # testes contra Postgres e S3 reais

pnpm sondar                     # Fase 0: valida as fontes e regenera docs/SONDAGEM-FASE-0.md
pnpm coletar                    # coleta tudo e grava snapshots versionados
pnpm coletar --fonte nfse-rtc --sem-documentos
pnpm mudancas --desde 2026-11-01

pnpm processar                  # extrai trechos, tabelas e leiaute dos snapshots novos
pnpm lastro anomalia listar     # mudanças anômalas fora do índice até revisão humana
pnpm lastro anomalia liberar --evento <uuid> --revisor <nome> --motivo "conferido na fonte"

pnpm lastro plano listar         # planos e limites (padrao e portal-publico vêm na migração, com valores provisórios)
pnpm lastro plano salvar --id pro --nome Pro --limite-minuto 120 --cota-mensal 5000 --cota-verificacoes 2000 --orcamento-mensal 200 --max-alertas 50
pnpm lastro cliente criar --nome "Empresa X" [--plano pro] [--cota-mensal 1000]   # limite informado vira exceção ao plano
pnpm lastro cliente atualizar --id <uuid> --plano padrao [--cota-mensal plano]   # "plano" remove a exceção
pnpm lastro chave criar --cliente <uuid> --escopo leitura --escopo perguntas --escopo verificacoes --escopo alertas   # segredo aparece uma vez
pnpm lastro uso [--mes 2026-11]  # uso medido por cliente no mês (base da cobrança)
pnpm lastro chave revogar --id <uuid>
pnpm api                        # API em http://127.0.0.1:8080 (chave obrigatória) + tela /painel (só local)
pnpm lastro expurgar            # apaga consultas e verificações com retenção vencida (LGPD)

pnpm lastro normas              # grafo normativo por regras (sem LLM): identifica cada ato e propõe relações
pnpm lastro fatos propor        # propõe prazos e obrigações com o Claude (5 documentos N1/N2 por rodada)
pnpm lastro curador criar --emissor https://sso.exemplo --sujeito <sub> --nome "Ana" [--papel supervisor]
pnpm admin                      # painel de curadoria em http://127.0.0.1:8081 (SSO + MFA obrigatórios)

pnpm lastro cliente criar --nome "Portal público" --plano portal-publico   # o id vai em LASTRO_PORTAL_CLIENTE_ID
pnpm portal                     # portal público em http://127.0.0.1:8082 (CAPTCHA obrigatório fora de 127.0.0.1)
pnpm lastro slack vincular --team T0123ABCD --cliente <uuid>
pnpm canais                     # comando /lastro do Slack em http://127.0.0.1:8083/slack/comandos (exige LASTRO_SLACK_SEGREDO_ASSINATURA)

pnpm mcp                        # servidor MCP por stdio (uso local; LASTRO_MCP_CLIENTE_ID libera perguntar_nfse)
pnpm mcp:http                   # MCP remoto (Streamable HTTP + OAuth); exige LASTRO_MCP_URL_RECURSO, _OAUTH_EMISSOR, _OAUTH_JWKS

pnpm lastro webhook adicionar --url https://seu-receptor/lastro [--formato slack] [--fonte nfse-rtc]
pnpm lastro webhook listar
pnpm notificar                  # envia aos assinantes os eventos pendentes
```

Agendamento sugerido: `pnpm coletar; pnpm processar; pnpm lastro normas; pnpm notificar` a cada hora e `pnpm lastro expurgar` uma vez por dia. `coletar`, `processar` e `notificar` saem com código 2 quando há falha, para virar alerta.

Exemplo de pergunta (precisa de credencial da Anthropic no ambiente da API, ex.: `ANTHROPIC_API_KEY`; sem ela a rota responde 503):

```sh
curl -s http://127.0.0.1:8080/v1/perguntas -H "authorization: Bearer $LASTRO_CHAVE" \
  -H 'content-type: application/json' -d '{"pergunta":"O que é o campo indFinal?"}'
```

A resposta traz o texto com marcadores `[n]`, e cada fonte citada traz órgão, nível, URL, trecho exato, página ou seção, data de coleta e SHA-256 do arquivo original. Sem evidência oficial, a resposta é "Não encontrei a resposta em fonte oficial."

Verificação de alegação (escopo `verificacoes`) e link público, que o dono decide gerar:

```sh
curl -s http://127.0.0.1:8080/v1/verificacoes -H "authorization: Bearer $LASTRO_CHAVE" \n  -H 'content-type: application/json' -d '{"texto":"Desde 1º de setembro o Simples é obrigado a usar o emissor nacional.","data_conteudo":"2026-09-10"}'
curl -s -X POST http://127.0.0.1:8080/v1/verificacoes/<id>/compartilhamento -H "authorization: Bearer $LASTRO_CHAVE"
```

Alerta por tema (escopo `alertas`): o cliente recebe no próprio webhook (ou no Slack) as mudanças cujo texto novo cita os termos, e os fatos curados do tema. Plano, limites e uso: `GET /v1/uso`.

```sh
curl -s http://127.0.0.1:8080/v1/alertas -H "authorization: Bearer $LASTRO_CHAVE" -H 'content-type: application/json' \n  -d '{"nome":"Cronograma IBS/CBS","url":"https://hooks.slack.com/services/…","formato":"slack","termos":["cronograma IBS/CBS"],"temas":["cronograma-ibs-cbs"]}'
```

Extensão de navegador: em `chrome://extensions`, "Carregar sem compactação" na pasta [apps/extensao/src](apps/extensao/src) e informar o endereço do portal nas opções.

Cada alegação sai com veredito, trechos oficiais exatos e, quando o modelo propôs um veredito sem a evidência mínima, `rebaixado: true` e SEM RESPALDO OFICIAL. Fatos e relações só contam depois de aprovados por dois curadores no painel (`pnpm admin`); o recall de um fato aparece no link público e vira evento `fato-corrigido` para os webhooks.

O receptor confere o cabeçalho `lastro-assinatura: t=<unix>,v1=<hmac>`: HMAC-SHA256 de `<t>.<corpo>` com o segredo mostrado no cadastro, recusando `t` com mais de 5 minutos de diferença. Referência: `verificarAssinatura` em [packages/webhooks/src/assinatura.ts](packages/webhooks/src/assinatura.ts).

`LASTRO_ARQUIVO=postgres` (padrão do `.env` gerado) grava em Postgres + S3; `disco` grava em `dados/arquivo`, sem precisar de Docker.

| Pacote | Conteúdo |
|---|---|
| [packages/core](packages/core) | Lista fechada de origens oficiais e catálogo de fontes |
| [packages/ingest](packages/ingest) | Cliente HTTPS protegido (SSRF, fixação de DNS, limites), robots.txt, extração de links, impressão digital de conteúdo, arquivo em disco e coletor |
| [packages/parsers](packages/parsers) | PDF, XLSX, ZIP, XSD e HTML com limites contra zip bomb, XXE e PDF malicioso; trechos por artigo/seção, tabelas dos anexos e dicionário do leiaute |
| [packages/db](packages/db) | Arquivo em Postgres + S3 WORM, índice de conhecimento, busca, clientes e chaves com RLS, migrações e papéis mínimos de banco |
| [packages/normas](packages/normas) | Identidade de atos normativos e relações (altera, revoga, prorroga) por regras, sem LLM |
| [packages/llm](packages/llm) | Roteador, geração com citações (Claude), checagem pós-geração, verificação de alegações com regras de veredito em código, extração de fatos para curadoria e serviços com cotas |
| [packages/webhooks](packages/webhooks) | Assinaturas do operador e alertas por tema dos clientes, HMAC, envio protegido contra SSRF e despacho com novas tentativas |
| [apps/worker](apps/worker) | CLI: `preparar`, `sondar`, `coletar`, `processar`, `normas`, `fatos`, `curador`, `mudancas`, `anomalia`, `plano`, `cliente`, `chave`, `uso`, `slack`, `expurgar`, `webhook`, `notificar` |
| [apps/api](apps/api) | API REST autenticada (`/v1/...`), página pública de verificação compartilhada e tela `/painel` local |
| [apps/admin](apps/admin) | Painel de curadoria: SSO (OIDC + PKCE) com MFA, dupla aprovação, recall; HTML sem script |
| [apps/mcp](apps/mcp) | Servidor MCP (stdio e Streamable HTTP com OAuth), só ferramentas de leitura |
| [apps/portal](apps/portal) | Portal público anônimo de perguntas e verificações, com CAPTCHA e limites por IP |
| [apps/canais](apps/canais) | Bot de Slack (`/lastro`): pergunta e checagem com assinatura do Slack e resposta efêmera |
| [apps/extensao](apps/extensao) | Extensão de navegador "checar este post" (Manifest V3) |

`coletar` sai com código 2 quando alguma URL falha ou é bloqueada por robots.txt, para o agendador transformar isso em alerta.

## Decisões já tomadas

- Nome: **Lastro**, com o subtítulo "NFS-e e reforma tributária com fonte oficial". Domínio principal previsto: `lastro-nfse.com.br`. Depende da busca no INPI.
- Somente fontes oficiais (órgãos públicos); nenhuma fonte não oficial é coletada ou citada.
- ISS entra na Fase 5, município a município. A tabela de alíquotas do Portal NFS-e é lida em código, sem modelo; a legislação municipal vem só de site oficial que passe na sondagem (o primeiro é São Paulo).
- Stack: TypeScript / Node.js 24.
- LLM: Claude (Anthropic API), modelo `claude-opus-5-5`.
- Fase 0 (sondagem automatizada das fontes) e Fase 1 (monitor: coleta segura, arquivo versionado WORM, detecção de mudança e de anomalia, API do feed, webhooks e tela) implementadas.
- Fase 2 (perguntas com fonte: parsers, índice, busca léxica, geração com citações e checagem, API autenticada e MCP) implementada, com o braço vetorial da busca aguardando a decisão de embeddings e a geração ainda sem validação contra a API real do Claude. Ver o estado de cada item e as pendências no [ROADMAP.md](docs/ROADMAP.md).
- Fase 3 (grafo normativo, curadoria com dupla aprovação, fatos aprovados, verificador de alegações, link compartilhável e recall) implementada; o painel ainda não foi ligado a um provedor de SSO real e a verificação ainda não rodou contra a API real do Claude.
- Fase 4 (planos e medição de uso, alertas por tema, portal público com CAPTCHA, bot de Slack, extensão de navegador e `security.txt`) implementada; faltam teste de intrusão externo e DAST antes de abrir o portal, escolher o provedor de CAPTCHA, criar o app do Slack, e WhatsApp e Teams.
- Fase 5 (ISS) implementada:
  - tabela oficial de alíquotas de ISSQN, com 1,9 milhão de linhas e 5.341 municípios, consultada sem modelo;
  - legislação de São Paulo;
  - rotas de pergunta próprias, `GET /v1/iss/municipios`, `GET /v1/iss/aliquotas` e a ferramenta MCP `consultar_aliquota_iss`.

  Faltam mais municípios (os demais grandes municípios sondados estão bloqueados, ver FONTES-OFICIAIS.md), a busca em linguagem natural para a lei municipal e a verificação de alegações sobre ISS.
