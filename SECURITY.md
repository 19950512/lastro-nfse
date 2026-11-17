# Política de segurança

## Como relatar uma vulnerabilidade

**Não abra uma issue pública** para relatar vulnerabilidades.

Use o relato privado do GitHub: aba **Security** deste repositório → **Report a vulnerability**. Só os mantenedores veem o relato.

Inclua, se possível:

- descrição do problema e do impacto;
- passos para reproduzir;
- versão ou commit afetado.

## O que esperar

- Confirmação de recebimento assim que o relato for lido.
- Avaliação e, se confirmado, correção antes de qualquer divulgação pública.
- Crédito a quem relatou, se desejar.

## Escopo

O projeto tem hoje só o coletor de fontes oficiais (`packages/ingest`, `apps/worker`), sem serviço em produção. Interessam em especial falhas que permitam ao coletor alcançar origem fora da lista oficial ou rede interna (SSRF), ou gravar no arquivo conteúdo de origem não oficial. Relatos sobre o desenho de segurança descrito em [docs/SEGURANCA.md](docs/SEGURANCA.md) também são bem-vindos.

Nunca inclua em issues, pull requests ou commits: chaves de API, senhas, tokens, dados pessoais ou dados fiscais de clientes.
