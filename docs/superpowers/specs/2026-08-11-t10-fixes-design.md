# Correções do T10 — bootstrap, health, nonce e dedupe

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md).


## Objetivo

Corrigir os quatro problemas encontrados na auditoria do T10 sem iniciar ainda o T11:

1. registrar a mesa RPC de chat no bootstrap;
2. fazer `/health` refletir turnos ativos;
3. rejeitar `clientNonce` inválido em runtime;
4. tornar o ledger de dedupe persistível através do contrato do store, mantendo a implementação em memória compatível.

## Desenho

### Bootstrap e estado de saúde

`startServer` criará um objeto de status compartilhado (`isBusy` e `activeAgentId`). O gateway receberá uma função que lê esse objeto. Depois de criar o gateway e os providers, o bootstrap registrará `registerRpcHandlers` com o store/registry apropriados. O `TurnRunner` receberá um callback de status, atualizado quando filas de agentes entram e saem.

O registro ocorrerá antes de o servidor começar a aceitar requisições. O `/health` continuará sendo seguro e somente leitura, mas passará a mostrar o agente ativo e `isBusy: true` durante um turno.

### Validação de `clientNonce`

Quando presente, `clientNonce` deverá ser uma string não vazia após `trim`. A string original será preservada no ledger e no transcript; apenas a validade usará o valor aparado. Valores `undefined` continuam permitidos para clientes que não enviam nonce. Valores `null`, números, objetos e strings vazias serão rejeitados com `RpcError(400)`.

### Ledger persistível

O contrato `TranscriptStore` ganhará operações explícitas para consultar e registrar nonces aceitos por agente:

- `hasAcceptedNonce(agentId, nonce): boolean`;
- `rememberAcceptedNonce(agentId, nonce): void`;
- `trimAcceptedNonces(agentId, cap): void`.

O `TurnRunner` deixará de manter um `Map` próprio e usará essas operações. O store em memória implementará o ledger com `Map<string, Set<string>>`, incluindo a política FIFO existente. Isso evita duas fontes de verdade e permite ao T11 implementar a mesma interface em SQLite sem alterar o runner.

A aceitação e o registro continuarão síncronos e ocorrerão antes do enfileiramento do turno. Não haverá alteração de semântica para nonces diferentes.

## Tratamento de erros

- Falha de validação de `clientNonce`: resposta RPC `400` com envelope `{ok:false,failure}`.
- Falhas no status callback não devem quebrar o turno; o runner continuará protegido pelo tratamento existente da fila.
- O bootstrap preservará a rejeição clara de porta ocupada.
- O registro da mesa ocorrerá uma vez por instância do gateway.

## Testes

Adicionar testes para:

- `startServer` com RPC registrado: `POST /api/sendPrompt` não retorna mais `501` e aceita um prompt;
- `/health` durante um provider bloqueado: reflete `isBusy: true` e o `activeAgentId`, depois volta a inativo;
- `clientNonce` ausente/válido aceito; nonce vazio, whitespace, `null` e número rejeitados;
- dedupe continua funcionando via store injetado;
- ledger FIFO continua removendo o nonce mais antigo quando excede a capacidade.

Executar a suíte completa e o build TypeScript após as mudanças.
