# OpenBot — aceite 100/100 retirado

> **RETIFICAÇÃO DE 17/08/2026:** este documento não representa mais um aceite válido. A afirmação de 100/100 foi excessiva e foi retirada após uma auditoria de persistência e lifecycle confirmar dez falhas reproduzíveis. As correções e novas regressões estão registradas em [Correção da auditoria de persistência e lifecycle](openbot-persistence-correction-2026-08-17.md).

> Para o baseline operacional mais recente e os comandos atuais, consulte o [runbook de recuperação e prontidão](openbot-recovery-readiness-2026-08-17.md).

**Data:** 17/08/2026  
**Escopo aceito:** uso pessoal local no Windows, com WSL2 e lifecycle de distribuição local sem assinatura pública.

## Resultado anterior — retirado

| Área | Nota |
|---|---:|
| Chat, providers e persistência | aceite absoluto retirado |
| Criação, exclusão e isolamento dos bots | aceite absoluto retirado |
| Navegação web visual | aceite absoluto retirado |
| Skills e MCP | aceite absoluto retirado |
| Runtime Developer/WSL | aceite absoluto retirado |
| Segurança e recuperação | aceite absoluto retirado |
| Distribuição e manutenção futura local | aceite absoluto retirado |

Esta frase também foi retirada: a auditoria posterior encontrou falhas reproduzíveis que os gates anteriores não cobriam.

## Evidência histórica anterior à auditoria

Os números abaixo pertencem à rodada que originou a conclusão retirada. A evidência atualizada está no documento de correção.

- suíte integral: **89 arquivos**, **945 testes aprovados**, **1 ignorado**, **0 falhas**;
- `npm run typecheck` e `npm run build`: GREEN;
- `npm run verify:e2e:browser`: GREEN, Electron real e isolamento entre bots;
- `npm run verify:e2e:desktop`: GREEN, processos ausentes, portas livres e raiz temporária removida;
- `npm run verify:runtime-wsl-live`: GREEN, incluindo instalação, supervisor, identidade, abort, recovery, rollback e remoção da distro temporária;
- `npm run verify:client-artifacts`: GREEN, 9 verificações;
- `npm run verify:release-lifecycle`: GREEN, 5 testes;
- `npm run verify:visual-ui`: GREEN;
- `npm run benchmark:hot-paths`: GREEN;
- `npm audit --omit=dev`: zero vulnerabilidades conhecidas em dependências de produção.

Revisões independentes com agentes Luna também revalidaram o lifecycle em máquina limpa, os negativos de segurança da release, a integridade dos artefatos do renderer e a rejeição de arquivo nativo inválido.

## O que o aceite garante

- O OpenBot inicia com zero bots e não recria bots de teste automaticamente.
- Cada bot recebe identidade, configuração, transcript, workspace e estado de browser próprios.
- Skills podem ser descobertas autonomamente pelo bot ou escolhidas pelo usuário no chat; MCP é compartilhado, lazy e controlado por allowlist por bot.
- O browser visual é real, sob demanda e isolado por bot.
- O modo Developer usa o guest WSL compartilhado, com admissão limitada, timeout, abort e recuperação.
- Instalação, preflight, reparo, atualização transacional com rollback e desinstalação local foram exercitados de ponta a ponta.

O desenho continua deliberadamente leve: não existe uma VM nem um conjunto de processos permanentes por bot. Os bots compartilham os serviços locais limitados e sob demanda, mantendo seus dados persistentes separados.

## Limites explícitos do 100/100

O aceite não afirma prontidão para distribuição pública assinada ou suporte universal em computadores arbitrários. O pacote atual é uma distribuição local sem assinatura pública. Também não depende de consumir créditos de providers comerciais nos testes, e o threat model do MCP considera processos executados pela mesma conta Windows como confiáveis.

Esses são limites do produto local aceito, não pendências dos critérios acima. Se o objetivo mudar para produto público assinado, multiusuário hostil ou suporte comercial amplo, uma nova matriz de aceite deverá ser criada.

## Documentos relacionados

- [Correção da auditoria de persistência e lifecycle](openbot-persistence-correction-2026-08-17.md)
- [Avaliação final de prontidão](openbot-readiness-assessment-2026-08-17.md)
- [Gates de verificação](verification-gates.md)
- [Ambiente prático final](practical-bot-environment-final.md)
