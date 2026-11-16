# Catálogo de fontes oficiais

## Política: somente fontes oficiais

A plataforma coleta, indexa e cita **apenas publicações de órgãos públicos** com competência sobre NFS-e e sobre a reforma tributária do consumo. Blogs, software houses, consultorias, portais contábeis, associações privadas e redes sociais **não são coletados nem citados**, em nenhuma hipótese.

Como a regra é aplicada:

- **Lista fechada de domínios** (ver tabelas abaixo). O coletor não segue links para fora dela, mesmo quando uma página oficial aponta para um site externo.
- **Lista fechada de órgãos emissores.** Um documento só entra se o emissor for um dos órgãos catalogados.
- **Texto enviado por usuário não é fonte.** Na verificação de alegações, o post ou mensagem colado é o *objeto* da checagem, nunca evidência. Ele não é indexado na base de conhecimento.

Levantamento feito em 16/11/2026. A coluna **Validado** indica se a página foi acessada diretamente nesta pesquisa (`sim`) ou se ainda precisa de checagem técnica na Fase 0 (`a validar`).

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
| Diário Oficial da União | `in.gov.br` | Publicação oficial de resoluções CGNFS-e, CGSN, CGIBS e atos conjuntos | HTML / XML; verificar viabilidade do INLABS para uso automatizado | a validar |
| Base de normas da Receita Federal (SIJUT) | `normas.receita.fazenda.gov.br` | Texto de atos da RFB e do CGSN (ex.: Resolução CGSN nº 191/2026) | HTML | sim (ato localizado) |
| Portal NFS-e – Portarias e Resoluções do CGNFS-e | `gov.br/nfse` | Resoluções do Comitê Gestor da NFS-e (ex.: Res. CGNFS-e nº 9/2025, NFS-e Via) | PDF | sim |
| Comitê Gestor do IBS | `cgibs.gov.br` | Resoluções CGIBS (ex.: Res. CGIBS nº 6/2026, Regulamento do IBS), Atos Conjuntos RFB/CGIBS | PDF | a validar (índice não acessado) |
| LexML | `lexml.gov.br` | Índice federado de normas, para descobrir identificadores e relações | API / HTML | a validar |

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
| Portal NFS-e – Eventos, Lista de serviços/NBS | `gov.br/nfse/pt-br/biblioteca` | Tabelas de referência (a página de Alíquotas de ISSQN fica para a fase de ISS) | HTML / XLSX | sim |
| Receita Federal – Programa da Reforma Tributária do Consumo | `gov.br/receitafederal` | Manuais (ex.: Manual da Plataforma CBS), material de apoio, marcos legais | PDF / HTML | a validar |
| Portal Nacional da NF-e | `nfe.fazenda.gov.br` | NTs RTC da NF-e/NFC-e. Não é NFS-e, mas o cronograma da reforma é conjunto e a confusão entre os documentos é frequente | PDF | a validar |

## N3 – Comunicação oficial

| Fonte | Domínio | O que cobre | Validado |
|---|---|---|---|
| Notícias do Portal NFS-e | `gov.br/nfse/pt-br/noticias` | Publicação de NTs, cronogramas, comunicados | sim (feed RSS não identificado) |
| Perguntas Frequentes do Portal NFS-e | `gov.br/nfse/pt-br/perguntas-frequentes` | FAQ oficial | sim |
| Monitoramento das Adesões / Plano de Implantação | `gov.br/nfse/pt-br/municipios` | Situação dos municípios no padrão nacional | sim |
| Notícias da Receita Federal | `gov.br/receitafederal` | Comunicados, cronogramas da reforma, Simples Nacional | sim |
| Notícias do CGIBS | `cgibs.gov.br` | Comunicados sobre IBS e documentos fiscais | a validar |
| Ministério da Fazenda – Reforma Tributária | `gov.br/fazenda` | Regulamentação, projetos de lei complementar | a validar |

## Fora do escopo do MVP

- **ISS (decidido: fica para fase posterior).** Inclui legislação municipal (5.570 municípios), sites de prefeituras, alíquotas de ISSQN e regras de apuração do ISS. Até lá, a plataforma informa apenas a situação de adesão dos municípios publicada pelo Portal NFS-e e responde perguntas sobre ISS como "fora do escopo por enquanto", sem interpretar. Quando a fase chegar, a entrada será município a município, sempre por fontes oficiais.
- **Secretarias estaduais de Fazenda.** São oficiais, mas não editam norma sobre NFS-e. Só entram se publicarem ato próprio relevante.
- Jurisprudência e soluções de consulta. Possível expansão futura.

## Fatos verificados em fonte oficial (16/11/2026)

Lidos diretamente nas páginas oficiais nesta pesquisa:

1. **Documentação RTC da NFS-e.** A página informa "Atualizado em 26/10/2026 15h52". Nela constam a Nota Técnica SE/CGNFS-e nº 009 v1.01 (01/10/2026), a NT nº 010 (NFS-e Via e Manifestação do Adquirente), a NT nº 008 (DANFSe, arquivo v1.02 de 14/07/2026), a NT nº 007 e o Anexo VIII v1.02.00 (26/10/2026). O Anexo VIII traz aviso de que é trabalho inicial, sem regras de negócio nos ambientes piloto ou de produção.
2. **Simples Nacional – Emissor Nacional.** Segundo a Receita Federal (notícia de 14/08/2026), a Resolução CGSN nº 191, de 4 de agosto de 2026, revogou expressamente a Resolução CGSN nº 189/2026, que previa 01/09/2026, e prorrogou a obrigatoriedade para **01/11/2026**. As regras de CBS e IBS só produzem efeitos para optantes do Simples a partir de **01/01/2027**.
3. **Cronograma de documentos fiscais da reforma** (Ato Conjunto RFB/CGIBS nº 4, de 30/07/2026, segundo notícia da Receita Federal de 31/07/2026). Para a NFS-e:

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

   A notícia diz que as datas de publicação de leiaute são expectativa e podem ser ajustadas. O texto do Ato Conjunto não estava linkado na notícia; precisa ser localizado no DOU ou no site do CGIBS para virar fato aprovado com evidência N1.
4. **LC 227/2026.** Lei Complementar nº 227, de 13 de janeiro de 2026, disponível no Planalto, com republicação e retificação publicadas.

O item 3 explica por que a internet mostrava "datas divergentes" para IBS/CBS na NFS-e: não há contradição. Cada data vale para um grupo diferente, e quem divulgava uma só data generalizava. É exatamente o tipo de caso que o verificador precisa classificar como **IMPRECISO** (ver [VERIFICACAO-DE-ALEGACOES.md](VERIFICACAO-DE-ALEGACOES.md)).
