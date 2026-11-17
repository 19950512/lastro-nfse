# Catálogo de fontes oficiais

## Política: somente fontes oficiais

A plataforma coleta, indexa e cita **apenas publicações de órgãos públicos** com competência sobre NFS-e e sobre a reforma tributária do consumo. Blogs, software houses, consultorias, portais contábeis, associações privadas e redes sociais **não são coletados nem citados**, em nenhuma hipótese.

Como a regra é aplicada:

- **Lista fechada de domínios** (ver tabelas abaixo). O coletor não segue links para fora dela, mesmo quando uma página oficial aponta para um site externo.
- **Lista fechada de órgãos emissores.** Um documento só entra se o emissor for um dos órgãos catalogados.
- **Texto enviado por usuário não é fonte.** Na verificação de alegações, o post ou mensagem colado é o *objeto* da checagem, nunca evidência. Ele não é indexado na base de conhecimento.

Levantamento feito em 16/11/2026. A coluna **Validado** indica se a página foi acessada diretamente nesta pesquisa (`sim`) ou se ainda precisa de checagem técnica (`a validar`). Depois da sondagem automatizada da Fase 0 ([SONDAGEM-FASE-0.md](SONDAGEM-FASE-0.md)), a coluna passou a registrar o resultado técnico.

A lista fechada executável fica em [packages/core/src/origem.ts](../packages/core/src/origem.ts) (host + prefixo de caminho por órgão), e o catálogo de sementes em [packages/core/src/fontes.ts](../packages/core/src/fontes.ts). Um teste falha se alguma semente sair da lista.

## Níveis de autoridade

| Nível | Tipo | Pode sustentar sozinho |
|---|---|---|
| **N1 – Normativo primário** | Constituição, Lei Complementar, Decreto, Resolução e Ato Conjunto publicados no DOU | Qualquer afirmação, inclusive "FALSO" |
| **N2 – Normativo técnico** | Nota Técnica, leiaute, anexos, XSD, manual oficial | Regras técnicas de emissão, campos, validações, cronogramas técnicos |
| **N3 – Comunicação oficial** | Notícia, FAQ, comunicado publicado pelo próprio órgão | Contexto e anúncios; prazos só na ausência de N1/N2, com aviso |

Regra de conflito: nível mais alto prevalece; no mesmo nível, o ato mais recente prevalece **se** houver relação explícita (altera/revoga/prorroga). Sem relação explícita, o conflito é exibido ao usuário.

## N1 – Normativo primário

| Fonte | Domínio | O que cobre | Formato | Validado |
|---|---|---|---|---|
| Planalto – legislação federal | `planalto.gov.br` | LC 214/2025 (art. 62: NFS-e de padrão nacional), LC 116/2003 (por ora só a lista de serviços, como tabela de códigos da NFS-e; regras de ISS ficam para depois), LC 227/2026 (institui o CGIBS e altera a LC 214/2025), EC 132/2023, Decreto nº 12.955/2026 (Regulamento da CBS) | HTML compilado; `.doc` de republicação e retificação | sim (LC 227/2026, com republicação e retificação publicadas) |
| Diário Oficial da União | `in.gov.br` | Publicação oficial de resoluções CGNFS-e, CGSN, CGIBS e atos conjuntos | HTML / XML; verificar viabilidade do INLABS para uso automatizado | **parcial** (Fase 0): `www.in.gov.br` derruba a conexão de robôs identificados; o INLABS (exige cadastro) estava em manutenção programada em 16/11/2026 e precisa ser reavaliado quando voltar. Ver decisão em aberto no ROADMAP |
| Base de normas da Receita Federal (SIJUT) | `normas.receita.fazenda.gov.br` | Texto de atos da RFB e do CGSN (ex.: Resolução CGSN nº 191/2026) | HTML | sim (ato localizado) |
| Portal NFS-e – Portarias e Resoluções do CGNFS-e | `gov.br/nfse` | Resoluções do Comitê Gestor da NFS-e (ex.: Res. CGNFS-e nº 9/2025, NFS-e Via) | PDF | sim |
| Comitê Gestor do IBS | `www.cgibs.gov.br` e `cgibs.gov.br` | Resoluções CGIBS (ex.: Res. CGIBS nº 6/2026, Regulamento do IBS), Atos Conjuntos e Atos Técnicos Conjuntos RFB/CGIBS | PDF | sim (Fase 0): páginas `/atos-conjuntos`, `/atos-tecnicos-conjuntos` e `/resolucoes` listam 39 PDFs; o Portal NFS-e linka o domínio sem `www` |
| LexML | `lexml.gov.br` | Índice federado de normas, para descobrir identificadores e relações | API / HTML | sim (Fase 0): robots.txt pede `Crawl-delay: 5` e proíbe `/busca/`; só `/urn` e `/sru` liberados para consulta |

**Atenção a republicações e retificações.** A LC 227/2026 tem republicação e retificação publicadas no Planalto. O adaptador precisa tratar esses arquivos como versões do mesmo ato, e as respostas devem citar o texto em vigor após a correção.

## N2 – Normativo técnico

| Fonte | Domínio | O que cobre | Formato | Validado |
|---|---|---|---|---|
| Portal NFS-e – Documentação RTC | `gov.br/nfse/.../documentacao-tecnica/rtc` | NTs da reforma tributária (001 a 010), Anexos VI, VII e VIII | PDF, XLSX, ZIP (XSD) | sim — página atualizada em 26/10/2026 |
| Portal NFS-e – Documentação atual (produção) | `gov.br/nfse/.../documentacao-atual` | Leiaute vigente em produção | PDF, XLSX, XSD | sim |
| Portal NFS-e – Homologação / produção restrita | `gov.br/nfse/.../producao-restrita` | Leiaute em teste | PDF, XLSX, XSD | sim |
| Portal NFS-e – APIs | `gov.br/nfse/.../apis-prod-restrita-e-producao` | Especificação das APIs do ambiente nacional | PDF / links | sim |
| Portal NFS-e – Atualizações e implantações | `gov.br/nfse/.../atualizacoes-e-implantacoes` | Cronograma de releases | HTML / PDF | sim |
| Portal NFS-e – Leiautes antigos | `gov.br/nfse/.../leiaute-e-esquemas-antigos` | Histórico (jul/2022 a 28/09/2025) | PDF, XSD | sim |
| Portal NFS-e – NFS-e Via | `gov.br/nfse/pt-br/nfs-e-via` | Modelo para pedágio | PDF | sim |
| Portal NFS-e – Eventos, Lista de serviços/NBS | `gov.br/nfse/pt-br/biblioteca` | Tabelas de referência | HTML / XLSX | sim |
| Portal NFS-e – Alíquotas de ISSQN (Fase 5) | `gov.br/nfse/pt-br/biblioteca/aliquotas` | Alíquotas que cada município cadastrou no ambiente nacional, por código de serviço e vigência. "Abrange todos os 5.571 municípios", segundo a página, mas o pacote de 03/09/2026 tem registros de 5.341 | ZIP com um CSV por UF + TXT consolidado | sim (Fase 5): 1.919.368 linhas lidas sem recusa |
| Receita Federal – Programa da Reforma Tributária do Consumo | `gov.br/receitafederal` | Manuais (ex.: Manual da Plataforma CBS), material de apoio, marcos legais | PDF / HTML | sim (Fase 0): tem feed RSS/Atom |
| Portal Nacional da NF-e | `nfe.fazenda.gov.br` | NTs RTC da NF-e/NFC-e. Não é NFS-e, mas o cronograma da reforma é conjunto e a confusão entre os documentos é frequente | PDF | **bloqueado** (Fase 0): a página exige cookie (`AspxAutoDetectCookieSupport`) e entra em laço de redirecionamento sem ele |

## N3 – Comunicação oficial

| Fonte | Domínio | O que cobre | Validado |
|---|---|---|---|
| Notícias do Portal NFS-e | `gov.br/nfse/pt-br/noticias` | Publicação de NTs, cronogramas, comunicados | sim (feed RSS não identificado) |
| Perguntas Frequentes do Portal NFS-e | `gov.br/nfse/pt-br/perguntas-frequentes` | FAQ oficial | sim |
| Monitoramento das Adesões / Plano de Implantação | `gov.br/nfse/pt-br/municipios` | Situação dos municípios no padrão nacional | sim |
| Notícias da Receita Federal | `gov.br/receitafederal` | Comunicados, cronogramas da reforma, Simples Nacional | sim |
| Notícias do CGIBS | `cgibs.gov.br` | Comunicados sobre IBS e documentos fiscais | sim (Fase 0) |
| Ministério da Fazenda – Reforma Tributária | `gov.br/fazenda` | Regulamentação, projetos de lei complementar | sim (Fase 0) |

## Legislação municipal (Fase 5)

Um adaptador por município (`municipio-<código IBGE>-legislacao`, nível N1), na lista fechada com host e órgão próprios. Um município só entra se o site oficial de legislação passar em quatro critérios: HTTPS com certificado válido, robots.txt que permite o robô, texto da norma no HTML (sem depender de script) e cada semente conferida pelo título do ato.

A tabela de alíquotas do Portal NFS-e não traz os maiores municípios, que têm NFS-e própria: São Paulo, Rio de Janeiro, Belo Horizonte, Campinas e Guarulhos estão ausentes do pacote de 03/09/2026. Para eles, a legislação municipal é a única fonte de alíquota.

Sondagem de 17/11/2026, com o User-Agent do robô:

| Município | Site oficial sondado | Resultado |
|---|---|---|
| São Paulo/SP (3550308) | `legislacao.prefeitura.sp.gov.br` (Catálogo de Legislação Municipal, Casa Civil) | **Coberto.** HTML no servidor; robots.txt ausente (responde HTML, tratado como ausente pela RFC 9309). O endereço inexistente devolve 200 com a página inicial (soft 404), por isso cada semente foi conferida pelo título. O texto do ato fica em `div.customStyle`; a redação anterior vem em `<del>` e é descartada. Sementes: Lei 13.701/2003, Decreto 53.151/2012 e Lei 14.097/2005 |
| Porto Alegre/RS | `www2.portoalegre.rs.gov.br` | Bloqueado: robots.txt com `User-agent: *` + `Disallow: /` |
| Curitiba/PR | `legisladocexterno.curitiba.pr.gov.br` | Bloqueado: robots.txt com `Disallow: /`, janela de visita das 4h às 6h45 UTC |
| Salvador/BA | `leismunicipais.salvador.ba.gov.br` | Bloqueado: certificado TLS expirado |
| Rio de Janeiro/RJ | `aplicnt.camara.rj.gov.br`, `www.camara.rio` | Bloqueado: cadeia TLS incompleta (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`); `www.rio.rj.gov.br` não respondeu em 25 s |
| Belo Horizonte/MG | `www.cmbh.mg.gov.br`, `dom-web.pbh.gov.br` | Bloqueado: o texto da lei é carregado por script (a página não contém o texto do ISS); o DOM é uma aplicação Vue |

O robô não contorna nenhum desses bloqueios: não ignora robots.txt, não aceita certificado inválido e não executa script. Portais privados de compilação de leis municipais (ex.: `leismunicipais.com.br`) não são fonte oficial e não entram.

## Fora do escopo do MVP

- **ISS: coberto em parte desde a Fase 5.** Entram a tabela de alíquotas do Portal NFS-e (acima), a LC 116/2003 (Planalto) e a legislação dos municípios da seção "Legislação municipal". Os demais municípios entram um a um, sempre por site oficial que passe na sondagem.
- **Secretarias estaduais de Fazenda.** São oficiais, mas não editam norma sobre NFS-e. Só entram se publicarem ato próprio relevante.
- Jurisprudência e soluções de consulta. Possível expansão futura.

## Fatos verificados em fonte oficial (16/11/2026)

Lidos diretamente nas páginas oficiais nesta pesquisa:

1. **Documentação RTC da NFS-e.** A página informa "Atualizado em 26/10/2026 15h52". Nela constam a Nota Técnica SE/CGNFS-e nº 009 v1.01 (01/10/2026), a NT nº 010 (NFS-e Via e Manifestação do Adquirente), a NT nº 008 (DANFSe, arquivo v1.02 de 14/07/2026), a NT nº 007 e o Anexo VIII v1.02.00 (26/10/2026). O Anexo VIII traz aviso de que é trabalho inicial, sem regras de negócio nos ambientes piloto ou de produção.
2. **Simples Nacional – Emissor Nacional.** Segundo a Receita Federal (notícia de 14/08/2026), a Resolução CGSN nº 191, de 4 de agosto de 2026, revogou expressamente a Resolução CGSN nº 189/2026, que previa 01/09/2026, e prorrogou a obrigatoriedade para **01/11/2026**. As regras de CBS e IBS só produzem efeitos para optantes do Simples a partir de **01/01/2027**.
3. **Cronograma de documentos fiscais da reforma — SUPERADO em 13/11/2026.** A tabela abaixo é a do Ato Conjunto RFB/CGIBS nº 4, de 30/07/2026, segundo notícia da Receita Federal de 31/07/2026. Ela foi alterada pelo Ato Conjunto nº 7/2026 (ver item 5) e fica aqui como registro do que valia antes. Para a NFS-e:

   | Grupo | Início da obrigatoriedade |
   |---|---|
   | NFS-e Via (pedágio) | 03/08/2026 |
   | Serviços em geral sujeitos ao ISS, sem obrigatoriedade específica | 01/10/2026 |
   | Plataformas digitais e serviços intermediados em hipóteses específicas | 01/12/2026 |
   | Subitens 1.03, 1.05, 1.09 e 16.01 da LC 116 | 01/12/2026 |
   | Bens imateriais fora da lista de serviços e não sujeitos ao ICMS | 01/12/2026 |
   | Taxas e valores condominiais | 01/12/2026 |
   | Locações (bens móveis e imóveis) | 01/12/2026 |
   | Optantes do Simples Nacional | 01/01/2027 |

   A notícia diz que as datas de publicação de leiaute são expectativa e podem ser ajustadas. Na Fase 0 o texto oficial do Ato Conjunto nº 4 foi localizado no site do CGIBS (`/atos-conjuntos`) e está no arquivo versionado; ainda precisa de curadoria para virar fato aprovado com evidência N1.
4. **LC 227/2026.** Lei Complementar nº 227, de 13 de janeiro de 2026, disponível no Planalto, com republicação e retificação publicadas.
5. **Ato Conjunto RFB/CGIBS nº 7, de 11/11/2026** (DOU de 13/11/2026), que altera o Ato Conjunto nº 4. Lido em 16/11/2026 na notícia do CGNFS-e de 13/11/2026 (N3), que linka o texto do ato no site do CGIBS (N1, já arquivado, mas ainda sem leitura do PDF nem curadoria). Segundo a notícia, para a NFS-e:

   | Grupo | Início da obrigatoriedade |
   |---|---|
   | NFS-e Via (pedágio) | 03/08/2026 (inalterado) |
   | Serviços em geral sujeitos ao ISS fora das exceções | 01/10/2026 (inalterado) |
   | Bens imateriais fora da lista de serviços e não sujeitos ao ICMS | 01/01/2027 (era 01/12/2026) |
   | Taxas e valores condominiais | 01/01/2027 (era 01/12/2026) |
   | Locações (bens móveis e imóveis) | 01/01/2027 (era 01/12/2026) |
   | Plataformas digitais e serviços intermediados (art. 22 da LC 214/2025) | 01/03/2027 (era 01/12/2026) |
   | Subitens 1.03, 1.05, 1.09 e 16.01 da LC 116 | 01/03/2027 (era 01/12/2026) |
   | Simples Nacional, alíneas "d" a "h" do inciso III | 01/01/2027 |
   | Simples Nacional, demais hipóteses | 01/03/2027 |

O item 3 explicava por que a internet mostrava "datas divergentes" para IBS/CBS na NFS-e: não havia contradição. Cada data valia para um grupo diferente, e quem divulgava uma só data generalizava, o que o verificador classifica como **IMPRECISO**. Com o item 5, quem ainda divulga "1º de dezembro de 2026" passa a estar **DESATUALIZADO** (ver [VERIFICACAO-DE-ALEGACOES.md](VERIFICACAO-DE-ALEGACOES.md)). O próprio levantamento manual de 16/11 já nasceu desatualizado, porque o ato tinha saído três dias antes. É para isso que o monitor da Fase 1 existe.

## Resultado da Fase 0 (sondagem automatizada)

Evidência: [SONDAGEM-FASE-0.md](SONDAGEM-FASE-0.md), gerado por `pnpm sondar`, e duas coletas completas seguidas com `pnpm coletar` em 16/11/2026.

| Achado | Consequência |
|---|---|
| O gov.br não envia `ETag` nem `Last-Modified` e responde **403 a `HEAD`** | A detecção de mudança usa GET + SHA-256. Planalto, SIJUT e INLABS aceitam requisição condicional (304) |
| Várias páginas oficiais mudam os bytes a cada leitura sem mudar o conteúdo: token do balanceador F5 no Planalto, id aleatório no CGIBS, réplicas do gov.br com `<head>` diferente | A mudança em HTML é detectada por **impressão digital do conteúdo** (sem `<head>`, scripts e atributos), e os bytes originais continuam arquivados como prova. Resultado: 0 páginas com conteúdo instável em 31, e a 2ª coleta não gerou nenhum evento falso |
| `www.in.gov.br` derruba a conexão de User-Agents de robô (aceita navegador) | O robô não se disfarça de navegador. O DOU depende do INLABS (cadastro) ou de outra via oficial: **decisão em aberto** |
| O INLABS respondeu 200 com página de "manutenção programada" na raiz e 404 nas demais URLs | Página de erro com status 200 é um risco de integridade: o coletor passou a exigir que o tipo da resposta bata com a extensão do documento (um `.pdf` que devolve HTML é recusado, sem gerar versão nova). Páginas HTML de entrada ainda dependem do alerta de anomalia, pendente na Fase 1 |
| Dois arquivos da produção restrita (Anexo VI da NT 004 e XSD RTC v1.00) foram despublicados entre duas coletas no mesmo dia: o gov.br passou a responder `302` + erro `Unauthorized` do Plone, e a página RTC continua linkando os dois | O arquivo guardou os bytes de antes da despublicação. A trava de tipo impediu que a página de erro virasse versão nova. Falta um evento próprio de "documento indisponível" (ROADMAP, Fase 1) |
| Portal NF-e exige cookie | Fica fora da coleta até haver suporte a cookie de sessão restrito ao host |
| `normas.receita.fazenda.gov.br/robots.txt` devolve uma página HTML | Tratado como robots.txt ausente (RFC 9309 manda considerar só `text/plain`) |
| Receita Federal publica RSS/Atom; o Portal NFS-e não (`/noticias/RSS` → 404) | Notícias da NFS-e continuam por raspagem da listagem |
| O Ato Conjunto nº 4/2026 está no site do CGIBS, não linkado na notícia da Receita | Item da Fase 0 "localizar o texto oficial" resolvido; falta a curadoria |
