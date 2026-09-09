# T12 — RPC tools, approvals e widgets mínimos

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md). Desde então, `resolveLocalToolPermission` foi conectado ao `LocalExecutionBroker`, e o loop tool-call → aprovação → execução → tool-result foi implementado de forma opt-in.


## Objetivo

Implementar a mesa local de interações consumida pela UI para responder widgets, resolver permissões e submeter secrets de widgets, sem dependência de conta ou serviço remoto.

## Escopo

RPCs:

- `respondToWidget`
- `dismissWidget`
- `submitSecret`
- `resolveLocalToolPermission`
- `resolveAutoReviewApproval`

A política local padrão é `ask`. As decisões de aprovação serão persistidas no SQLite junto do estado local de interação. Secrets serão encaminhados exclusivamente ao `Keystore`; nenhum valor será salvo em transcript, SQLite, logs ou resposta RPC.

## Modelo de dados

Adicionar ao SQLite uma tabela versionada de decisões:

```sql
CREATE TABLE IF NOT EXISTS interaction_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(agent_id, request_id, kind)
);
```

A tabela deve permitir reabrir o mesmo pedido sem duplicar a decisão. `metadata_json` não poderá conter secret plaintext.

## Contratos RPC

Cada método exige corpo objeto e `agentId`/identificador do pedido não vazio. Erros de payload retornam `RpcError(400)`.

- `respondToWidget`: `{agentId, widgetId, response}` → `{ok:true, widgetId}`; resposta é publicada no canal `transcript`/`widgets` conforme o shape existente.
- `dismissWidget`: `{agentId, widgetId, reason?}` → `{ok:true, widgetId}`; registra descarte idempotente.
- `submitSecret`: `{agentId, widgetId, secretName, secretValue}` → `{ok:true, secretName}`; grava no keystore e nunca retorna `secretValue`.
- `resolveLocalToolPermission`: `{agentId, requestId, decision}` onde decision é `allow`, `deny` ou `ask` → decisão persistida e retornada sem secrets.
- `resolveAutoReviewApproval`: `{agentId, requestId, decision}` onde decision é `approve` ou `reject` → decisão persistida e retornada.

O shape exato dos campos poderá aceitar aliases já presentes nas fixtures, mas a resposta deve manter envelope RPC padrão e não expor dados sensíveis.

## Arquitetura

Criar `src/rpc/interactions.ts` com validação, handlers e interface mínima para persistência. Estender `SqliteTranscriptStore` com operações de decisões, ou extrair uma interface pequena sem duplicar a conexão SQLite. Injetar `Keystore` nos handlers para `submitSecret`.

As decisões devem ser escritas antes da resposta de sucesso. Repetições do mesmo `(agentId, requestId, kind)` retornam a decisão existente, sem sobrescrever silenciosamente.

## Segurança

- `secretValue` só pode atravessar o handler até `keystore.upsert`.
- `getProviderConfig`, transcript, decisões e erros não podem incluir secrets.
- Validar tamanho e tipo dos campos; rejeitar objetos/arrays onde o contrato exige string.
- Não executar tools neste T12: apenas registrar/resolver decisões e produzir eventos locais.

## Testes e aceite

- contrato e validação 400 para cada RPC;
- resposta/dismiss de widget idempotente;
- decisões local-tool e auto-review persistem após reabrir SQLite;
- `submitSecret` chama keystore e não expõe o valor em resposta, transcript, banco ou logs;
- decisão repetida retorna o registro original;
- `npm run build` e `npm test` verdes.
