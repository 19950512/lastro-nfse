# Roadmap

Fases em ordem de dependência. Cada fase entrega algo utilizável sozinho. Prazos não foram estimados: dependem de equipe e da Fase 0.

Cada fase só termina quando cumpre também os requisitos de segurança listados em [SEGURANCA.md](SEGURANCA.md#15-testes-de-segurança-e-requisitos-por-fase).

## Fase 0 — Validação das fontes

- Confirmar cada fonte marcada como `a validar` em [FONTES-OFICIAIS.md](FONTES-OFICIAIS.md): acesso, robots.txt, formato, estabilidade de URLs, existência de feed ou API (DOU/INLABS, LexML, CGIBS, Receita, Fazenda, Portal NF-e).
- Fechar a lista de domínios e órgãos oficiais permitidos.
- Localizar o texto oficial do Ato Conjunto RFB/CGIBS nº 4/2026 (DOU ou CGIBS); hoje só a notícia da Receita foi lida.
- Coleta manual de uma amostra de cada fonte para testar os parsers (PDF com páginas, XLSX dos anexos, XSD).
- Montar o **conjunto de referência**: perguntas reais de empresas com resposta e fontes esperadas, e alegações reais com veredito definido por especialista.
- Definir quem faz a curadoria de fatos (ver decisões em aberto).

**Critério de saída**: todas as fontes N1–N3 do MVP com método de coleta comprovado.

## Fase 1 — Monitor oficial

- Adaptadores, arquivo versionado com hash, detecção de mudança.
- Feed "o que mudou" (API + webhooks + e-mail/Slack).
- Tela simples de documentos e versões.

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
