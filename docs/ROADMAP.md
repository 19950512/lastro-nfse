# Roadmap

Fases em ordem de dependência. Cada fase entrega algo utilizável sozinho. Prazos não foram estimados: dependem de equipe e da Fase 0.

Cada fase só termina quando cumpre também os requisitos de segurança listados em [SEGURANCA.md](SEGURANCA.md#15-testes-de-segurança-e-requisitos-por-fase).

## Fase 0 — Validação das fontes

Estado em 16/11/2026: ✅ feito · 🟡 parcial · ⬜ pendente.

- ✅ Confirmar cada fonte marcada como `a validar` em [FONTES-OFICIAIS.md](FONTES-OFICIAIS.md): acesso, robots.txt, formato, estabilidade, existência de feed ou API. Feito por `pnpm sondar` → [SONDAGEM-FASE-0.md](SONDAGEM-FASE-0.md). Duas fontes ficaram **bloqueadas**: DOU (`www.in.gov.br` recusa robôs) e Portal NF-e (exige cookie).
- ✅ Fechar a lista de domínios e órgãos oficiais permitidos: [packages/core/src/origem.ts](../packages/core/src/origem.ts), com host + prefixo por órgão (o `www.gov.br` é compartilhado por todos os ministérios).
- ✅ Localizar o texto oficial do Ato Conjunto RFB/CGIBS nº 4/2026: está em `cgibs.gov.br/atos-conjuntos`. Na busca apareceu também o **Ato Conjunto nº 7/2026**, que altera o nº 4 (ver FONTES-OFICIAIS.md, item 5).
- 🟡 Coleta de uma amostra de cada fonte para testar os parsers: a coleta completa (`pnpm coletar`) arquiva hoje 129 documentos (PDF, XLSX, ZIP com XSD, HTML). Os parsers são da Fase 2.
- ⬜ Montar o **conjunto de referência**: perguntas reais de empresas com resposta e fontes esperadas, e alegações reais com veredito definido por especialista. Depende de especialista.
- ⬜ Definir quem faz a curadoria de fatos (ver decisões em aberto).
- ⬜ Segurança da Fase 0: modelo de ameaças STRIDE e política de dados/LGPD (ver [SEGURANCA.md](SEGURANCA.md#15-testes-de-segurança-e-requisitos-por-fase)).

**Critério de saída**: todas as fontes N1–N3 do MVP com método de coleta comprovado. **Ainda não cumprido** por causa do DOU (decisão em aberto nº 7) e do Portal NF-e.

## Fase 1 — Monitor oficial

- ✅ Adaptadores, arquivo versionado com hash, detecção de mudança:
  - adaptador genérico (página-semente + documentos linkados), cliente HTTPS com as proteções de rede de SEGURANCA.md §8, robots.txt (RFC 9309), limite por host;
  - detecção por impressão digital de conteúdo; tipo da resposta conferido contra a extensão do documento;
  - eventos `documento-novo`, `nova-versao`, `link-removido`, `documento-indisponivel` (só 401/403/404/410, página de erro no lugar do arquivo ou redirecionamento para fora da lista; 5xx e falha de rede não contam) e `documento-restabelecido`;
  - **alerta de anomalia**: nova versão com texto encolhido a menos de 30%, metade dos links de documentos sumida, troca de tipo ou de domínio sai marcada para revisão humana ([anomalia.ts](../packages/ingest/src/anomalia.ts));
  - arquivo em **Postgres + S3 com Object Lock COMPLIANCE** ([packages/db](../packages/db)): bytes endereçados por SHA-256, gravação sem sobrescrita e com checksum conferido pelo servidor, segunda barreira de origem, papéis `lastro_coletor` (SELECT + INSERT), `lastro_leitor` (SELECT) e `lastro_notificador` (lê eventos, escreve só nas tabelas de webhook), e triggers que recusam UPDATE/DELETE/TRUNCATE até para o dono das tabelas.
- ✅ Feed "o que mudou":
  - API somente leitura ([apps/api](../apps/api)): `GET /v1/mudancas` (filtros por data, fonte, tipo e anomalia; paginação por cursor), `/v1/fontes` (com atraso pelo SLA), `/v1/documentos`, `/v1/documentos/{id}`, `/v1/snapshots/{id}/original` e `/v1/openapi.json` gerado dos schemas Zod;
  - webhooks ([packages/webhooks](../packages/webhooks)) com HMAC-SHA256 + timestamp, conteúdo mínimo, formato `lastro` ou `slack`, validação de URL no cadastro e de DNS a cada envio, sem seguir redirecionamento, espera crescente entre tentativas, desistência após 6 tentativas e desativação após 20 falhas seguidas. O Slack entra como formato de webhook; **e-mail ficou de fora** (depende de escolher o provedor de envio).
- ✅ Tela simples de documentos e versões (`/painel`): HTML sem script, CSP sem `script-src`, todo texto vindo das fontes escapado por padrão.
- ✅ Segurança da fase: CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) com CodeQL, OSV-Scanner e Gitleaks, actions fixadas por hash.

Pendências conhecidas, fora do escopo mínimo da fase:
- **Credenciais e rede:** credencial S3 própria do coletor sem permissão de apagar; proxy de egresso.
- **Segredos:** gerenciador de segredos em produção (hoje o local usa `.env`); segredo de webhook cifrado no banco.
- ~~**API:** autenticação e limite de requisições~~ e ~~**Parsers:** limites de ZIP/XML~~: resolvidos na Fase 2.

**Valor**: substitui a ronda manual por 5–7 sites. Funciona sem IA.

## Fase 2 — Perguntas com fonte

Estado em 17/11/2026: ✅ feito · 🟡 parcial · ⬜ pendente.

- ✅ **Parsers** ([packages/parsers](../packages/parsers)) com os limites de SEGURANCA.md §8: ZIP lido com zlib e teto de saída por arquivo e total (zip bomb, inclusive com tamanho declarado falso), recusa de `..`, caminho absoluto, cifragem e zip64; XML sem DTD nem entidade (XXE e "billion laughs" recusados); XLSX só com valores (fórmula e macro ignoradas); PDF em `worker_thread` com teto de memória e tempo. Na coleta real, 129 snapshots extraídos sem falha.
- ✅ **Trechos por estrutura**: lei por artigo (`secao = "Art. 62"`, texto riscado do Planalto descartado), PDF por página e seção numerada, HTML por títulos.
- ✅ **Tabelas estruturadas dos anexos** (77 tabelas na coleta real; Anexo VIII com 1611 linhas por item LC 116 × NBS × indOp × cClassTrib) e **dicionário do leiaute** a partir dos XSD (1650 campos no pacote v1.01, com caminho, tipo, ocorrências, descrição e versão).
- ✅ **Índice imutável e revisão de anomalia**: extração, trechos, tabelas e campos só aceitam inserção; versão marcada como anômala fica fora do índice (a anterior continua valendo) até `pnpm lastro anomalia liberar`.
- 🟡 **Busca híbrida**: braço léxico pronto (full-text português com `unaccent`, peso por raridade do termo, identificadores como "NT 009", "cClassTrib", "IBS/CBS" por trigramas, fusão RRF, filtros por fonte e nível). Bom para identificador, artigo e código; fraco para pergunta em linguagem natural. O braço vetorial depende da decisão em aberto nº 1 (embeddings) e entra na mesma fusão.
- ✅ **Geração com citações** ([packages/llm](../packages/llm)): `claude-opus-5-5`, trechos como blocos `search_result` com citação nativa, `effort` por rota, `fallbacks` do servidor para recusa, nenhuma ferramenta oferecida ao modelo. Roteador recusa ISS municipal e consultoria sem chamar o modelo; sem evidência, responde "não encontrei" sem chamar o modelo. CPF, CNPJ, e-mail e telefone mascarados antes do envio e do registro.
- ✅ **Checagem pós-geração** determinística: citação conferida contra o texto realmente enviado, frase sem citação removida (conectivo só fica se cada número dele estiver no trecho citado ao lado), origem oficial e hash obrigatórios (senão a resposta é rejeitada), aviso de fonte velha pelo SLA, de documento indisponível e de prazo apoiado só em N3; links externos, imagens e HTML removidos da saída.
- ✅ **API** (`/v1/busca`, `/v1/referencias`, `/v1/referencias/{tabela}`, `/v1/leiaute/campos/{nome}`, `POST /v1/perguntas`, `GET /v1/perguntas/{id}`) e **MCP** ([apps/mcp](../apps/mcp)) com `perguntar_nfse`, `buscar_fontes_oficiais`, `obter_documento`, `listar_mudancas`, `consultar_codigo`, `explicar_campo_leiaute` e os recursos `nfse://fontes`, `nfse://mudancas/recentes`, `nfse://documento/{id}`.
- ✅ **Segurança da fase**:
  - chave de API por cliente (só o hash SHA-256 no banco, comparação em tempo constante, escopos `leitura` e `perguntas`), exigida em toda rota de dados;
  - limite por chave e por IP, cota mensal de perguntas e orçamento mensal por cliente, disjuntor global de gasto diário;
  - isolamento por cliente com RLS em `consulta_log` (papel `lastro_api` sem BYPASSRLS; sem cliente na transação, nada é lido nem gravado);
  - MCP remoto com OAuth 2.1 como servidor de recurso: token só aceito se emitido para este recurso (sem repasse), metadados RFC 9728, Host e Origin conferidos, sem sessão;
  - saída do LLM sanitizada;
  - testes adversariais de injeção (pergunta e documento) na checagem.
- ✅ **Retenção (LGPD)**: consultas expiram em `LASTRO_RETENCAO_CONSULTAS_DIAS` (padrão 30) e `pnpm lastro expurgar` apaga as vencidas.

Pendências conhecidas da Fase 2:
- **Nenhuma resposta gerada foi testada contra a API real do Claude.** Os testes usam um modelo falso; a máquina de desenvolvimento não tinha credencial da Anthropic. Antes de abrir `/v1/perguntas` a clientes: rodar perguntas reais, medir citação e abstenção.
- **Conjunto de referência** (perguntas reais com resposta esperada e casos adversariais avaliados pelo modelo real) depende de especialista (Fase 0). Os testes adversariais atuais cobrem a checagem determinística, não o comportamento do modelo.
- **Embeddings** (decisão nº 1) e **OCR**: 4 PDFs oficiais são digitalizados, sem camada de texto (Resoluções CGNFS-e 4/2024, 7/2025 e 8/2025 e um Ato Conjunto RFB/CGIBS) e ficam fora do índice.
- **Grafo normativo** (Fase 3): a regra "citação de ato revogado é rejeitada" e o campo `conflitos` dependem dele.
- **Autorização do MCP**: o servidor de autorização OAuth é externo e precisa ser escolhido e configurado (emissor, JWKS e a claim `lastro_cliente_id`).
- **Operação**:
  - limites de taxa em memória, por processo;
  - cache de respostas idênticas;
  - PDF em contêiner sem rede (hoje só `worker_thread` com teto de memória e tempo);
  - busca leva cerca de 1 s por pergunta na base local.

## Fase 3 — Fatos curados e verificador

Estado em 17/11/2026: ✅ feito · 🟡 parcial · ⬜ pendente.

- ✅ **Metadados normativos e grafo por regras** ([packages/normas](../packages/normas), `pnpm lastro normas`, sem LLM): identidade do ato pelo cabeçalho oficial em caixa alta (chave canônica, ex.: `resolucao-cgibs-11-2026`; minuta não ganha identidade) e relações `altera`, `revoga`, `prorroga`, `regulamenta` só de cláusulas ativas ("Fica revogada a…", "Altera a…", "…passa a vigorar com…"). Revogação de dispositivo vira `altera`; revogação com data futura ("a partir de 1º de janeiro de 2033") guarda `efeito_em`; anotações passivas do texto compilado do Planalto ("Revogado pela…", "Vide…") são ignoradas. Na base local: 96 versões analisadas, 49 atos identificados, 104 relações propostas, 12 com destino arquivado.
- ✅ **Fatos propostos pelo Claude** (`pnpm lastro fatos propor`): prazos, obrigações, vigências, valores e pendências, só de fontes N1/N2, com citação relocalizada como substring exata do trecho.
- ✅ **Curadoria com dupla aprovação** ([apps/admin](../apps/admin), `pnpm admin`): fila, trecho original ao lado com a evidência destacada, aprovação, rejeição, proposta manual de fato e recall. Regras no banco (segunda camada): dois curadores distintos, quem propôs não aprova, decisão presa ao curador da sessão (`lastro.curador_id`), só supervisor faz recall e só do aprovado, evidência literal no trecho, tudo só inserção. Fato cujo documento mudou depois da aprovação sai como `evidencia_atual = false` e não sustenta FALSO nem DESATUALIZADO.
- ✅ **Verificação de alegações** (`POST /v1/verificacoes`, `verificar_alegacao` no MCP): extração de alegações (structured outputs), evidência por alegação (fatos aprovados → grafo → busca), veredito proposto pelo modelo e **regras de evidência em código**, que só rebaixam (para SEM RESPALDO OFICIAL): citação literal do texto enviado, origem oficial com hash, FALSO com N1/N2 e fato aprovado para prazo/obrigação, DESATUALIZADO com relação aprovada já em efeito, AINDA NÃO DEFINIDO com trecho que diz que a definição está pendente, trecho de ato revogado não sustenta CONFIRMADO, explicação com número sem lastro trocada pela padrão. ISS municipal é decidido em código. O texto enviado é mascarado (CPF, CNPJ, e-mail, telefone), não vira fonte e não aparece no link público.
- ✅ **Link compartilhável** (`/verificacoes/{token}` e `/v1/publico/verificacoes/{token}`): gerado só pelo dono, só o hash do token no banco, revogável, expira com a retenção; HTML sem script, CSP `default-src 'none'`, tudo escapado, `noindex`, limite por IP.
- ✅ **Recall de veredito**: revogar um fato aprovado conta as verificações e respostas que o usaram, publica o evento `fato-corrigido` no feed (webhooks) e faz o link público e `GET /v1/verificacoes/{id}` exibirem a correção.
- ✅ **Fatos na API, MCP e perguntas**: `/v1/fatos`, `/v1/fatos/temas`, `/v1/fatos/{id}`, `consultar_prazo` no MCP; a rota de prazo de `/v1/perguntas` usa fatos aprovados primeiro, e frase apoiada só em ato revogado (grafo aprovado) sai da resposta.
- ✅ **Segurança da fase**: painel em origem e processo separados com SSO OIDC (code + PKCE + state + nonce) e MFA exigido pelo `amr` do token (padrão `hwk`, chave física); RBAC curador/supervisor no código e no banco; cookies `__Host-` HttpOnly Secure SameSite=Strict; anti-CSRF por sessão + conferência de `Origin` em todo POST; CSP sem script no painel e no link; testes de XSS nos links compartilháveis e no painel; recall implementado; papel de banco `lastro_curadoria` sem UPDATE/DELETE em fatos e decisões; escopos novos `verificacoes` (chave) e `nfse:verificacoes` (OAuth).

Pendências conhecidas da Fase 3:
- **Nada da verificação nem da extração de fatos rodou contra a API real do Claude** (sem credencial nesta máquina). As regras em código foram testadas com modelo roteirizado e na base real de teste; antes de abrir `/v1/verificacoes`: rodar alegações reais e o conjunto de referência.
- **SSO real**: o painel não foi ligado a um provedor OIDC de verdade. Escolher o provedor, confirmar o valor de `amr` que ele emite para WebAuthn (o padrão `hwk` bloqueia login até isso bater) e cadastrar os curadores (`pnpm lastro curador criar`).
- **Quem cura** (decisão em aberto nº 3): sem curadores, nenhum fato ou relação é aprovado, e FALSO/DESATUALIZADO nunca saem (o sistema rebaixa para SEM RESPALDO OFICIAL, como deve).
- **Grafo**: o extrator de regras é conservador; relação com destino não arquivado fica sem `destino_resolvido` (Resolução CGSN 189/191 não está nas fontes coletadas). Relação proposta manualmente pelo painel e o campo `conflitos` da resposta ficaram de fora.
- **Imagem/print** como entrada da verificação (fase posterior, já prevista em VERIFICACAO-DE-ALEGACOES.md).
- Recall de **relação** aprovada (hoje só fato) e aviso ativo aos clientes cujas verificações usaram o fato (hoje: evento no feed e aviso no link).

## Fase 4 — Produto

Estado em 17/11/2026: ✅ feito · 🟡 parcial · ⬜ pendente.

- ✅ **Multi-cliente: planos, limites e medição de uso** (migração [008](../packages/db/migracoes/008_produto.sql)):
  - tabela `plano` (requisições por minuto, cota mensal de perguntas, cota mensal de verificações, orçamento mensal em dólar, máximo de alertas); o limite efetivo é a exceção do cliente, se houver, senão o valor do plano. Mudar um plano muda todos os clientes do plano sem exceção;
  - pergunta e verificação têm cotas separadas; o orçamento em dólar é um só;
  - medição diária em `uso_diario`, sem conteúdo de cliente, gravada por gatilho na mesma transação da consulta. A cota mensal e o disjuntor global passaram a ler dessa tabela. Antes liam `consulta_log`, que o expurgo da LGPD apaga: com retenção menor que um mês, o expurgo zerava parte da cota;
  - requisições contadas em memória e gravadas em lote a cada 15 s;
  - `GET /v1/uso` (qualquer chave do cliente) e CLI `pnpm lastro plano salvar|listar`, `cliente atualizar` e `uso --mes` (relatório para cobrança).
- ✅ **Alertas por tema** (`POST|GET|DELETE /v1/alertas`, escopo de chave `alertas`, máximo de alertas pelo plano): webhook no formato `lastro` ou `slack`, assinado com HMAC, com a mesma validação de destino da Fase 1. Um alerta casa com o evento por:
  - **termos**: o termo aparece no texto que entrou na versão nova (trecho ausente da versão anterior já processada) ou no enunciado do fato do evento;
  - **temas de fatos curados**: fato do tema aprovado ou revogado, ou mudança, posterior à aprovação, num documento que sustenta fato aprovado do tema.
  Evento novo `fato-aprovado`, publicado pelo banco na segunda aprovação. Com RLS, cada cliente só vê os próprios alertas, e a API não lê o segredo.
- ✅ **Portal público** ([apps/portal](../apps/portal), `pnpm portal`): perguntas e verificações anônimas em origem e processo próprios.
  - CAPTCHA Turnstile ou hCaptcha conferido no servidor: falha fechada e host conferido;
  - `Origin` conferido em todo POST;
  - limites por IP por minuto e, para o que chama o modelo, por hora;
  - cliente próprio no plano `portal-publico`, com cota, orçamento e disjuntor global;
  - a verificação vira link compartilhado na página canônica da API;
  - um único script próprio, que preenche o texto vindo da extensão.
- 🟡 **Canais**:
  - ✅ Slack ([apps/canais](../apps/canais), comando `/lastro`): assinatura do Slack com janela de 5 min; reenvio do Slack ignorado; workspace vinculado a um cliente (`pnpm lastro slack vincular`); resposta efêmera só na `response_url` do próprio Slack; texto escapado (sem `<!channel>`); limite por usuário por hora e por workspace por minuto;
  - ✅ extensão de navegador ([apps/extensao](../apps/extensao), Manifest V3): "Checar no Lastro" num texto selecionado abre `/verificar` do portal com o texto no fragmento da URL, que não vai ao servidor. Permissões: só menu de contexto e armazenamento;
  - ⬜ WhatsApp e Teams: dependem de conta no Meta Business e no Azure Bot Service.
- 🟡 **Segurança da fase**: ✅ CAPTCHA e proteção contra abuso; ✅ `/.well-known/security.txt` (RFC 9116) na API e no portal, com validade obrigatória e sem renovação automática; ⬜ teste de intrusão externo; ⬜ DAST (OWASP ZAP), que precisa do ambiente de homologação, ainda inexistente.
- ⬜ Expansões, sempre com fontes oficiais: NF-e/NFC-e da reforma, jurisprudência de tribunais.

Teste local de ponta a ponta (17/11/2026, banco de desenvolvimento, sem credencial da Anthropic): `GET /v1/uso`, criação e remoção de alerta (destino que resolve para 127.0.0.1 recusado pelo DNS real), `security.txt`, portal com POST sem `Origin` recusado e pergunta sobre ISS recusada pelo roteador, registrada com `canal = portal` e medida em `uso_diario`, e comando do Slack assinado (ajuda, workspace sem vínculo, assinatura errada).

Pendências conhecidas da Fase 4:
- **Antes de abrir o portal ao público:** teste de intrusão externo e DAST.
- **Validação com o modelo real:** nenhuma resposta do portal nem do Slack foi gerada pela API real do Claude; é a mesma pendência das fases 2 e 3.
- **Planos:** os valores de `padrao` e `portal-publico` são provisórios e dependem do modelo de negócio (decisão nº 4).
- **CAPTCHA:** escolher o provedor e criar as chaves. Sem CAPTCHA, o portal só sobe em 127.0.0.1.
- **Slack:** criar o app (slash command apontando para `<canais>/slack/comandos`). Ainda não há instalação por OAuth; o workspace é vinculado à mão, pelo `team_id`.
- **Extensão:** publicar nas lojas (o Firefox exige `browser_specific_settings`). Enquanto não houver domínio, cada usuário configura o endereço do portal.
- **Medição:** as requisições ficam em memória até o lote; se o processo cair, perde-se até 15 s de contagem. Perguntas e verificações não são afetadas.
- **Alertas:**
  - a comparação é por trecho: por artigo em texto legal, mas, em HTML sem estrutura, o bloco inteiro conta como novo quando muda;
  - só eventos dos últimos 14 dias são reavaliados;
  - versão anômala só dispara alerta depois de liberada;
  - e-mail continua fora, porque depende de escolher o provedor de envio.

## Fase 5 — ISS

Estado em 17/11/2026: ✅ feito · 🟡 parcial · ⬜ pendente.

- ✅ **Alíquotas de ISSQN do Portal NFS-e** (fonte `nfse-aliquotas-iss`, N2): a página `biblioteca/aliquotas/aliquotas-de-issqn` linka um ZIP com um CSV por UF e um TXT que repete tudo.
  - O parser ([aliquotas-iss.ts](../packages/parsers/src/aliquotas-iss.ts)) só abre os CSV; o TXT de 145 MB é pulado sem ser descompactado.
  - Cada campo é validado: código IBGE coerente com a UF do arquivo, código de serviço, alíquota entre 0 e 100, datas reais.
  - Toda linha aceita reconstrói byte a byte a linha publicada, e essa linha é o trecho citado.
  - Cabeçalho diferente, ou mais de 0,1% de linhas fora do formato, derruba a extração (falha fechada).
  - Na coleta real (pacote de 03/09/2026): 1.919.368 linhas, 5.341 municípios, 0 recusadas; 6 s de leitura e 89 s até gravar no banco.
- ✅ **Banco** (migração [009](../packages/db/migracoes/009_iss.sql)):
  - `tabela_aliquota_iss`, `municipio_iss` e `aliquota_iss` só aceitam inserção;
  - vale o pacote com a data de extração mais recente (`tabela_aliquota_iss_vigente`), e o anterior continua arquivado;
  - o processador só insere, e a API e o leitor só leem.
- ✅ **Legislação municipal, um adaptador por município** (`Fonte.municipio`, id `municipio-<IBGE>-legislacao`, N1): começa por **São Paulo**, o maior emissor, que não está na tabela nacional. O município tem o próprio NFS-e, assim como Campinas, Guarulhos, Belo Horizonte e Rio de Janeiro, também ausentes da tabela. Entram a Lei 13.701/2003 (ISS e alíquotas), o Decreto 53.151/2012 (Regulamento do ISS) e a Lei 14.097/2005 (NFS-e), do catálogo oficial da Casa Civil (`legislacao.prefeitura.sp.gov.br`, host inteiro na lista fechada). A sondagem dos outros candidatos está em [FONTES-OFICIAIS.md](FONTES-OFICIAIS.md#legislação-municipal-fase-5).
- ✅ **Perguntas de ISS** ([iss.ts](../packages/llm/src/iss.ts)); o roteador deixou de recusar ISS e ganhou duas rotas:
  - `iss-aliquota`, para município da tabela: resposta montada em código, **sem modelo**.
    - Cada número sai de uma linha do CSV citada literalmente (arquivo, linha, URL e hash do pacote).
    - Vale o registro vigente na data perguntada (ou hoje); registro com fim anterior ao início é tratado como cancelado.
    - Registros vigentes divergentes saem todos, com aviso, e a plataforma não escolhe.
  - `iss`, para apuração, retenção, base de cálculo e recolhimento: busca restrita à legislação federal (LC 116/2003) e, se o município citado for coberto, à lei dele.
    - Município sem legislação coletada: só a lei federal, com aviso.
    - Sem município citado: só a lei federal.
    - Nome de município em mais de uma UF, ou dois municípios citados: a resposta pede a UF, sem chamar o modelo.
  - Consultoria continua fora do escopo.
- ✅ **API e MCP**:
  - `GET /v1/iss/municipios`: cobertura por município (tabela e legislação);
  - `GET /v1/iss/aliquotas`: linha publicada, vigência na data, cancelados e divergências;
  - ferramenta `consultar_aliquota_iss`.
- 🟡 **Verificação de alegações sobre ISS**: continua FORA DO ESCOPO, decidido em código. Um FALSO sobre alíquota municipal exigiria regra de evidência própria (tabela oficial ou lei do município, com fato curado), que ainda não existe em [regras-veredito.ts](../packages/llm/src/regras-veredito.ts).
- ⬜ **Mais municípios.** A sondagem de 17/11/2026 bloqueou:
  - Porto Alegre e Curitiba: robots.txt proíbe;
  - Salvador: certificado TLS expirado;
  - Rio de Janeiro: cadeia TLS incompleta;
  - Belo Horizonte: texto carregado por script.

Teste local de ponta a ponta (17/11/2026, banco de desenvolvimento): coleta real das duas fontes novas (5 documentos), processamento, e consultas pela API.
- `/v1/iss/municipios` respondeu em 58 ms.
- `/v1/iss/aliquotas` de Adamantina/SP, item 1.05, respondeu em 38 ms com a linha `SP.csv:7`.
- `POST /v1/perguntas`:
  - "alíquota do ISS em Adamantina/SP para o item 1.05": rota `iss-aliquota`, respondida sem modelo e com custo zero;
  - "em Bom Jesus": pediu a UF entre os 5 municípios com esse nome;
  - "em São Paulo para serviços de informática": chamou o `claude-opus-5-5` real (8.846 tokens de entrada, US$ 0,04) e respondeu "não encontrei". A busca restrita trouxe só a lei de São Paulo e a federal, mas não trouxe o art. 16 da Lei 13.701 (alíquotas): é o limite da busca léxica para pergunta em linguagem natural (ver a Fase 2).

Pendências conhecidas da Fase 5:
- **Busca de ISS em linguagem natural:** o termo do município aparece em quase todo trecho da lei municipal e a busca léxica não acha o artigo das alíquotas. Depende do braço vetorial (decisão nº 1) ou de uma rota que consulte direto o artigo de alíquotas da lei coberta.
- **Armazenamento:** cada pacote novo de alíquotas ocupa cerca de 460 MB no Postgres (199 MB de dados e 261 MB de índices, medido). Como o arquivo é só inserção, os pacotes se acumulam. Falta uma política de retenção para pacotes superados, preservando os que foram citados.
- **Reprocessamento × curadoria:** `evidencia_atual` de fatos e relações aprovados exige que o trecho de evidência pertença à extração vigente. Subir `VERSAO_EXTRATOR` reprocessa tudo e deixaria **todos** os fatos aprovados sem evidência atual, ou seja, sem FALSO nem DESATUALIZADO até nova curadoria. Por isso as correções desta fase não subiram a versão: elas só mudam a saída das páginas do catálogo de São Paulo, ainda não coletadas fora da base local. A correção é a área principal `div.customStyle` e o sufixo de artigo só quando o hífen vem colado ao número ("Art. 9º - São" não é "Art. 9-S"). Antes de subir a versão de novo: reprocessamento seletivo por fonte, ou evidência ancorada no texto e não no id do trecho.
- **Base local:** as três leis de São Paulo têm duas versões extras no arquivo, efeito das correções da área principal durante o desenvolvimento, e a versão vigente na base local ainda tem os rótulos de artigo antigos. Isso não afeta outra base: uma coleta nova já usa o extrator corrigido.
- **ISS na verificação de alegações** (ver acima) e **mais municípios** (um adaptador por município, sempre pela sondagem).

## Métricas de qualidade (metas propostas, a calibrar na Fase 0)

| Métrica | Como medir | Meta proposta |
|---|---|---|
| Precisão de citação | Especialista avalia se o trecho citado sustenta a frase | ≥ 95% |
| Precisão do veredito FALSO | Entre os FALSOS emitidos, quantos o especialista confirma | ≥ 98% (o erro mais caro do produto) |
| Abstenção correta | Perguntas sem resposta oficial em que o sistema diz "não encontrei" | ≥ 90% |
| Frescor | Tempo entre publicação na fonte e disponibilidade na plataforma | N2/N3 do Portal NFS-e: horas; N1: até 1 dia |
| Cobertura de fontes | Mudanças detectadas / mudanças reais (auditoria manual mensal) | 100% nas fontes N1–N2 |

O conjunto de referência roda a cada mudança de prompt, modelo ou pipeline; uma queda em qualquer métrica bloqueia o deploy.

## Riscos

| Risco | Mitigação |
|---|---|
| Veredito FALSO errado com a marca da plataforma | Regra de evidência N1/N2 + fato aprovado por curador; rebaixamento automático de veredito |
| Fontes oficiais divergentes entre si | Exibir o conflito com as duas fontes em vez de escolher uma |
| Sites gov.br mudam estrutura ou bloqueiam robôs | Adaptadores isolados, alertas de falha de coleta, coleta respeitosa |
| Usuários perguntarem sobre ISS antes da Fase 5 | Rota "fora do escopo por enquanto" com resposta padrão; perguntas registradas para priorizar quais municípios entram primeiro |
| Documento não oficial entrar na base | Lista fechada de domínios e órgãos aplicada na coleta e na gravação; teste automatizado que falha se qualquer *snapshot* tiver origem fora da lista |
| *Prompt injection* em documentos ou posts | Conteúdo externo tratado como dado; regras de veredito em código; testes adversariais bloqueando deploy |
| Link de verificação usado para espalhar fake (print adulterado ou XSS no link) | Página da verificação é a referência canônica; XSS bloqueado por escape + CSP; recall de veredito com aviso no link |
| Site oficial adulterado ou interceptação na coleta | HTTPS com validação, alerta de anomalia, revisão humana antes de indexar mudanças anômalas, *snapshots* imutáveis |
| Responsabilidade jurídica | Aviso em toda resposta, data de posição, linguagem factual |
| Custo de LLM | *Prompt caching*, Batches API na carga histórica, rotas determinísticas (tabelas, fatos) sem LLM sempre que possível |

## Decisões em aberto

1. **Embeddings**: Voyage AI (API, sem infraestrutura) ou modelo multilíngue auto-hospedado (sem custo por chamada, mais operação).
2. **Modelo para tarefas em lote**: tudo em `claude-opus-5-5` (padrão atual) ou usar um modelo mais barato (ex.: `claude-haiku-5-5`) na extração em massa da carga histórica, medindo antes a perda de qualidade. Desde 17/11/2026 a troca é configuração: `LASTRO_LLM_MODELO` (respostas e verificações) e `LASTRO_LLM_MODELO_FATOS` (extração de fatos), entre Opus 5.5, Sonnet 5.5 e Haiku 5.5, com o preço de cada um no cálculo de custo. Cada fato guarda o modelo que o propôs (`modelo:<id>`), o que permite comparar a taxa de aprovação dos curadores por modelo. Falta a medição.
3. **Curadoria**: quem aprova os fatos (equipe interna, contador parceiro, especialista contratado) e qual o prazo de aprovação.
4. **Modelo de negócio**: API B2B paga, portal público gratuito com API paga, ou ferramenta interna.
5. **Hospedagem**: nuvem e região (dados de consulta de clientes ficam no Brasil?).
6. **Marca "Lastro"**: nome escolhido, mas depende de busca no INPI nas classes de software e de serviços de informação. Já existe uma empresa ativa chamada Lastro no mercado de capitais (lastro.com.br). Se o INPI aprovar, registrar os domínios abaixo; se barrar, as alternativas são "Vigente" e "Fato Fiscal".

   | Domínio | Uso | Situação no Registro.br em 16/11/2026 |
   |---|---|---|
   | `lastro-nfse.com.br` | Principal | Disponível |
   | `lastronfse.com.br` | Redireciona para o principal (quem digita sem hífen) | Disponível |
   | `lastrotributario.com.br` | Reserva para quando o escopo passar da NFS-e (ISS, NF-e) | Disponível |
7. **Acesso ao DOU** (achado da Fase 0). O portal `www.in.gov.br` derruba a conexão de User-Agents de robô e só responde a navegadores. O projeto não disfarça o robô de navegador. Opções: (a) cadastrar uma conta no INLABS, a via oficial de acesso automatizado (em 16/11/2026 o INLABS estava em manutenção programada; reavaliar com `pnpm sondar --fonte dou` quando voltar); (b) pedir à Imprensa Nacional a liberação do User-Agent do robô; (c) não coletar o DOU direto e usar como N1 os PDFs que os próprios órgãos publicam (CGIBS, Planalto, SIJUT), mantendo o DOU só para conferência manual.
8. **Provedor de CAPTCHA do portal público** (Fase 4): Cloudflare Turnstile ou hCaptcha. O código aceita os dois (`LASTRO_PORTAL_CAPTCHA`); falta escolher, criar as chaves e avaliar o tratamento de dados de cada provedor na política de privacidade (LGPD).
