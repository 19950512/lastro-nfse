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
- **API:** autenticação e limite de requisições. Por isso ela recusa escutar fora de 127.0.0.1 (requisitos da Fase 2).
- **Parsers:** limites de ZIP/XML, que entram com os parsers da Fase 2.

**Valor**: substitui a ronda manual por 5–7 sites. Funciona sem IA.

## Fase 2 — Perguntas com fonte

- Parsers, trechos, busca híbrida, tabelas estruturadas dos anexos, dicionário do leiaute.
- Geração com citações, checagem pós-geração.
- API REST (`/v1/perguntas`, `/v1/busca`, `/v1/referencias`, `/v1/leiaute`) e servidor MCP com as ferramentas correspondentes.

## Fase 3 — Fatos curados e verificador

- Extração de metadados normativos, grafo normativo, fila e tela de curadoria.
- Pipeline de verificação de alegações com vereditos e link compartilhável.
- `verificar_alegacao` no MCP e `/v1/verificacoes` na API.

## Fase 4 — Produto

- Multi-cliente: chaves de API, limites, medição de uso, planos.
- Interface web pública de perguntas e verificações.
- Alertas por tema (ex.: "me avise de qualquer mudança no cronograma IBS/CBS da NFS-e").
- Canais: bot de WhatsApp/Slack/Teams, extensão de navegador "checar este post".
- Expansões possíveis, sempre com fontes oficiais: NF-e/NFC-e da reforma, jurisprudência de tribunais.

## Fase 5 — ISS

Decidido: o ISS fica fora das fases 0 a 4.

- Alíquotas de ISSQN publicadas no Portal NFS-e e regras de apuração.
- Legislação municipal a partir dos sites oficiais das prefeituras, começando pelos municípios de maior volume de emissão.
- Um adaptador por município (ou por sistema de publicação usado por grupos de municípios), com o mesmo arquivo versionado e a mesma barreira de origem oficial.

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
2. **Modelo para tarefas em lote**: tudo em `claude-opus-5-5` (padrão atual) ou usar um modelo mais barato (ex.: `claude-haiku-5-5`) na extração em massa da carga histórica, medindo antes a perda de qualidade.
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
