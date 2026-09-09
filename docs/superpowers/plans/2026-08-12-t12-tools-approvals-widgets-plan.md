# T12 Tools, Approvals e Widgets — Implementation Plan

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md). Desde então, `resolveLocalToolPermission` foi conectado ao `LocalExecutionBroker`, e o loop tool-call → aprovação → execução → tool-result foi implementado de forma opt-in.


> Implementar somente a mesa mínima de interações locais; execução real de tools permanece fora do escopo.

## Objetivo

Adicionar `respondToWidget`, `dismissWidget`, `submitSecret`, `resolveLocalToolPermission` e `resolveAutoReviewApproval`, persistindo decisões no SQLite e enviando secrets exclusivamente ao keystore.

### Task 1 — Fixar contratos e registro RPC

**Arquivos:** `src/rpc/interactions.ts`, `src/rpc/index.ts`, `src/server/gateway.ts`

- [ ] Criar tipos internos para widgets, decisões e respostas públicas.
- [ ] Adicionar os cinco métodos à `RPC_METHOD_TABLE`.
- [ ] Validar corpos como objetos, ids não vazios, decisões permitidas e limites de tamanho.
- [ ] Converter payload inválido em `RpcError(400)`.

### Task 2 — Persistência SQLite de decisões

**Arquivos:** `src/store/index.ts`, `test/store-interactions.test.ts`

- [ ] Migrar o schema com `interaction_decisions` e índice/constraint idempotente.
- [ ] Implementar leitura e gravação por `(agentId, requestId, kind)`.
- [ ] Garantir que repetição retorne a decisão original sem sobrescrita.
- [ ] Testar persistência após fechar e reabrir o banco.

### Task 3 — Implementar handlers de widgets e approvals

**Arquivos:** `src/rpc/interactions.ts`, `src/rpc/index.ts`, `test/interactions.test.ts`

- [ ] Implementar `respondToWidget` e `dismissWidget` com respostas públicas estáveis.
- [ ] Implementar `resolveLocalToolPermission` para `allow|deny|ask`.
- [ ] Implementar `resolveAutoReviewApproval` para `approve|reject`.
- [ ] Publicar eventos locais sem executar ferramentas.
- [ ] Testar sucesso, idempotência e famílias de erro `widgets`/`approvals`.

### Task 4 — Integrar secrets ao keystore

**Arquivos:** `src/rpc/interactions.ts`, `src/main.ts`, `test/interactions-secrets.test.ts`

- [ ] Injetar `Keystore` nos handlers durante o bootstrap.
- [ ] Implementar `submitSecret` usando `keystore.upsert`.
- [ ] Retornar apenas `secretName`; nunca devolver ou persistir `secretValue`.
- [ ] Testar que o valor não aparece em transcript, SQLite, logs ou respostas.
- [ ] Garantir limpeza/fechamento correto em erros de persistência.

### Task 5 — Integração e documentação

**Arquivos:** `test/bootstrap.test.ts`, `test/rpc-interactions-gateway.integration.test.ts`, `README.md`

- [ ] Testar as cinco rotas via HTTP e confirmar envelopes RPC.
- [ ] Testar restart preservando decisões e secrets via keystore.
- [ ] Atualizar README com T12 DONE e limites: sem execução real de tools.
- [ ] Rodar `npm run build` e `npm test` completo.
- [ ] Verificar que nenhum `store.db`, WAL, SHM ou secret de teste foi deixado no repositório.

## Aceite

T12 estará concluído quando todos os cinco RPCs tiverem contratos testados, decisões sobreviverem a restart, `submitSecret` usar o keystore sem exposição do valor, e build/testes estiverem verdes.
