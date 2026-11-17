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

O projeto tem hoje o coletor de fontes oficiais, a API (com perguntas, verificações, alertas e a tela `/painel`), o painel de curadoria, o servidor MCP, o portal público, o bot de Slack, a extensão de navegador e o envio de webhooks, sem serviço em produção. Os serviços publicam `/.well-known/security.txt` quando configurados. Interessam em especial:

- **Coletor e webhooks:** alcançar origem fora da lista oficial ou rede interna (SSRF).
- **Arquivo:** gravar conteúdo de origem não oficial ou alterar o histórico.
- **Webhooks:** forjar a assinatura HMAC.
- **API e tela:** XSS na tela ou nos downloads de originais.
- **Isolamento entre clientes:** ler ou alterar consultas, verificações, alertas ou medição de outro cliente.
- **Portal e canais:** contornar CAPTCHA, limites ou cotas; forjar comando do Slack; fazer o servidor chamar um endereço que não seja do Slack ou do provedor de CAPTCHA. Relatos sobre o desenho de segurança descrito em [docs/SEGURANCA.md](docs/SEGURANCA.md) também são bem-vindos.

Nunca inclua em issues, pull requests ou commits: chaves de API, senhas, tokens, dados pessoais ou dados fiscais de clientes.
