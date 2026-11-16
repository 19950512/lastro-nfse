# Lastro — NFS-e e reforma tributária com fonte oficial

> Nome escolhido, **pendente de busca de marca no INPI** (ver decisões em aberto no [ROADMAP.md](docs/ROADMAP.md)).

Plataforma que responde perguntas sobre NFS-e no Brasil **somente com base em canais oficiais**, sempre com fonte, data e versão do documento. Também classifica alegações que circulam na internet (posts, vídeos, mensagens) como confirmadas, falsas, desatualizadas ou sem respaldo oficial.

## Por que existe

Para saber o estado real da NFS-e hoje é preciso acompanhar pelo menos: Portal Nacional da NFS-e, resoluções do Comitê Gestor da NFS-e, Receita Federal, Comitê Gestor do IBS, Simples Nacional, Diário Oficial e a legislação da reforma tributária. Cada canal publica em um formato (notícia, PDF de Nota Técnica, planilha, XSD, resolução no DOU), e as datas mudam com frequência. Enquanto isso, perfis em redes sociais e blogs publicam interpretações que muitas vezes estão desatualizadas ou erradas, e empresas tomam decisões com base nelas.

Exemplo real (16/11/2026): circulam três datas diferentes para a obrigatoriedade de IBS/CBS na NFS-e. A fonte oficial (cronograma do Ato Conjunto RFB/CGIBS nº 4/2026, divulgado pela Receita Federal) mostra que as três existem, mas cada uma vale para um grupo diferente de contribuintes. Quem divulga uma só data está generalizando. É esse o tipo de ruído a eliminar.

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

## Decisões já tomadas

- Nome: **Lastro**, com o subtítulo "NFS-e e reforma tributária com fonte oficial". Domínio principal previsto: `lastro-nfse.com.br`. Depende da busca no INPI.
- Somente fontes oficiais (órgãos públicos); nenhuma fonte não oficial é coletada ou citada.
- ISS fica para uma fase posterior: legislação municipal, alíquotas, apuração e sites de prefeituras. A lista de serviços da LC 116 entra só como tabela de códigos usada no leiaute da NFS-e.
- Stack: TypeScript / Node.js 24.
- LLM: Claude (Anthropic API), modelo `claude-opus-5-5`.
- Esta rodada entrega apenas arquitetura e plano; sem código.
