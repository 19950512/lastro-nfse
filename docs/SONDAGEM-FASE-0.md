# Sondagem das fontes oficiais — Fase 0

> Gerado por `pnpm sondar` em 2026-11-16T23:24:02.780Z. Não edite à mão: rode a sondagem de novo.
> User-Agent: `LastroBot/0.1 (coletor de fontes oficiais de NFS-e)`. Cada semente foi lida duas vezes (estabilidade) e, se houver validadores HTTP, uma terceira com requisição condicional.

## Resumo

| Item | Quantidade |
|---|---|
| Sementes sondadas | 31 |
| Acessíveis | 29 |
| Com erro | 1 |
| Bloqueadas por robots.txt | 1 |
| Bytes diferentes entre duas leituras seguidas | 10 |
| Conteúdo normalizado diferente entre duas leituras seguidas | 0 |
| Com ETag ou Last-Modified | 8 |

"Estável" compara duas leituras seguidas: primeiro os bytes, depois a impressão digital de conteúdo
(HTML sem `<head>`, scripts e atributos; ver `packages/ingest/src/impressao.ts`), que é o que a coleta usa para detectar mudança.

## Por semente

| Fonte | Nível | URL | Acesso | Tamanho | Validadores | Condicional | Estável (bytes / conteúdo) | Documentos linkados | Feeds |
|---|---|---|---|---|---|---|---|---|---|
| planalto-legislacao | N1 | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214.htm | ✅ 200 text/html | 5.2 MiB | ETag + Last-Modified | suportado | **não** / sim | 1 (1 doc) | — |
| planalto-legislacao | N1 | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp116.htm | ✅ 200 text/html | 101.9 KiB | ETag + Last-Modified | suportado | **não** / sim | — | — |
| planalto-legislacao | N1 | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp227.htm | ✅ 200 text/html | 1.3 MiB | ETag + Last-Modified | suportado | **não** / sim | 2 (2 doc) | — |
| planalto-legislacao | N1 | https://www.planalto.gov.br/ccivil_03/constituicao/emendas/emc/emc132.htm | ✅ 200 text/html | 498.4 KiB | ETag + Last-Modified | suportado | **não** / sim | — | — |
| planalto-legislacao | N1 | https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2026/decreto/d12955.htm | ✅ 200 text/html | 3.0 MiB | ETag + Last-Modified | suportado | **não** / sim | — | — |
| dou | N1 | https://www.in.gov.br/inicio | ⛔ robots.txt | — | nenhum | nao-testado | — / — | — | — |
| dou | N1 | https://inlabs.in.gov.br/ | ✅ 200 text/html | 18.2 KiB | ETag + Last-Modified | ignorado | — / — | — | — |
| receita-sijut | N1 | https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action | ✅ 200 text/html | 44.2 KiB | ETag + Last-Modified | suportado | sim / sim | — | — |
| nfse-resolucoes | N1 | https://www.gov.br/nfse/pt-br/biblioteca/portarias-e-resolucoes-cgnfs-e | ✅ 200 text/html | 90.8 KiB | nenhum | sem-validadores | sim / sim | 10 (10 pdf) | — |
| cgibs | N1 | https://www.cgibs.gov.br/inicial | ✅ 200 text/html | 57.5 KiB | nenhum | sem-validadores | sim / sim | — | — |
| cgibs | N1 | https://www.cgibs.gov.br/atos-conjuntos | ✅ 200 text/html | 54.1 KiB | nenhum | sem-validadores | sim / sim | 8 (8 pdf) | — |
| cgibs | N1 | https://www.cgibs.gov.br/atos-tecnicos-conjuntos | ✅ 200 text/html | 57.8 KiB | nenhum | sem-validadores | **não** / sim | 12 (12 pdf) | — |
| cgibs | N1 | https://www.cgibs.gov.br/resolucoes | ✅ 200 text/html | 65.0 KiB | nenhum | sem-validadores | **não** / sim | 19 (19 pdf) | — |
| lexml | N1 | https://www.lexml.gov.br/ | ✅ 200 text/html | 3.9 KiB | ETag + Last-Modified | ignorado | sim / sim | — | — |
| nfse-rtc | N2 | https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc | ✅ 200 text/html | 96.5 KiB | nenhum | sem-validadores | sim / sim | 20 (9 pdf, 10 xlsx, 1 zip) | — |
| nfse-documentacao-atual | N2 | https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual | ✅ 200 text/html | 90.7 KiB | nenhum | sem-validadores | sim / sim | 17 (8 pdf, 8 xlsx, 1 zip) | — |
| nfse-producao-restrita | N2 | https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita | ✅ 200 text/html | 88.2 KiB | nenhum | sem-validadores | sim / sim | 8 (3 pdf, 4 xlsx, 1 zip) | — |
| nfse-apis | N2 | https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/apis-prod-restrita-e-producao | ✅ 200 text/html | 89.1 KiB | nenhum | sem-validadores | sim / sim | — | — |
| nfse-atualizacoes | N2 | https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/atualizacoes-e-implantacoes | ✅ 200 text/html | 90.6 KiB | nenhum | sem-validadores | sim / sim | — | — |
| nfse-leiautes-antigos | N2 | https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/leiaute-e-esquemas-antigos | ✅ 200 text/html | 90.1 KiB | nenhum | sem-validadores | sim / sim | 5 (3 pdf, 1 xlsx, 1 zip) | — |
| nfse-via | N2 | https://www.gov.br/nfse/pt-br/nfs-e-via/documentacao-tecnica | ✅ 200 text/html | 81.4 KiB | nenhum | sem-validadores | sim / sim | — | — |
| nfse-via | N2 | https://www.gov.br/nfse/pt-br/nfs-e-via/documentacao-tecnica/notas-tecnicas | ✅ 200 text/html | 84.5 KiB | nenhum | sem-validadores | sim / sim | 2 (2 pdf) | — |
| nfse-tabelas | N2 | https://www.gov.br/nfse/pt-br/biblioteca/eventos_NFS-e | ✅ 200 text/html | 84.8 KiB | nenhum | sem-validadores | **não** / sim | — | — |
| nfse-tabelas | N2 | https://www.gov.br/nfse/pt-br/mei-e-demais-empresas/codigos-de-tributacao-nacional-nbs | ✅ 200 text/html | 126.8 KiB | nenhum | sem-validadores | **não** / sim | — | — |
| receita-reforma | N2 | https://www.gov.br/receitafederal/pt-br/assuntos/reforma-tributaria | ✅ 200 text/html | 194.2 KiB | nenhum | sem-validadores | sim / sim | — | https://www.gov.br/receitafederal/pt-br/assuntos/reforma-tributaria/RSS<br>https://www.gov.br/receitafederal/pt-br/assuntos/reforma-tributaria/rss.xml<br>https://www.gov.br/receitafederal/pt-br/assuntos/reforma-tributaria/atom.xml |
| nfe-portal | N2 | https://www.nfe.fazenda.gov.br/portal/principal.aspx | ❌ redirecionamento (302) | — | nenhum | nao-testado | — / — | — | — |
| nfse-noticias | N3 | https://www.gov.br/nfse/pt-br/noticias | ✅ 200 text/html | 150.3 KiB | nenhum | sem-validadores | sim / sim | — | — |
| nfse-faq | N3 | https://www.gov.br/nfse/pt-br/perguntas-frequentes | ✅ 200 text/html | 83.5 KiB | nenhum | sem-validadores | sim / sim | 1 (1 pdf) | — |
| nfse-municipios | N3 | https://www.gov.br/nfse/pt-br/municipios/monitoramento-adesoes | ✅ 200 text/html | 90.6 KiB | nenhum | sem-validadores | sim / sim | 1 (1 xlsx) | — |
| receita-noticias | N3 | https://www.gov.br/receitafederal/pt-br/assuntos/noticias | ✅ 200 text/html | 271.5 KiB | nenhum | sem-validadores | **não** / sim | — | https://www.gov.br/receitafederal/pt-br/assuntos/noticias/RSS<br>https://www.gov.br/receitafederal/pt-br/assuntos/noticias/rss.xml<br>https://www.gov.br/receitafederal/pt-br/assuntos/noticias/atom.xml |
| fazenda-reforma | N3 | https://www.gov.br/fazenda/pt-br/acesso-a-informacao/acoes-e-programas/reforma-tributaria | ✅ 200 text/html | 163.3 KiB | nenhum | sem-validadores | sim / sim | — | — |

## robots.txt por host

| Host | Situação | Crawl-delay | Detalhe |
|---|---|---|---|
| inlabs.in.gov.br | ausente | — | HTTP 404 |
| normas.receita.fazenda.gov.br | ausente | — | não é robots.txt (tipo não aceito: text/html) |
| www.cgibs.gov.br | encontrado | — | 24 bytes |
| www.gov.br | encontrado | — | 2102 bytes |
| www.in.gov.br | inacessivel | — | rede: ECONNRESET: socket hang up |
| www.lexml.gov.br | encontrado | 5 s | 589 bytes |
| www.nfe.fazenda.gov.br | ausente | — | HTTP 404 |
| www.planalto.gov.br | ausente | — | HTTP 404 |

## Erros

| URL | Código | Mensagem |
|---|---|---|
| https://www.nfe.fazenda.gov.br/portal/principal.aspx | redirecionamento | mais de 5 redirecionamentos |
