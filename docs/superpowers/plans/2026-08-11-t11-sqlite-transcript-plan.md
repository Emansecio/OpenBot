# T11 SQLite Transcript Implementation Plan

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md).


> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Persistir transcript e dedupe de nonces em SQLite, integrar o store ao bootstrap e expor as três rotas RPC de transcript.

**Architecture:** `SqliteTranscriptStore` implementará o contrato síncrono `TranscriptStore` usando uma conexão `better-sqlite3`, um `store.db` por instalação e dados particionados por `agentId`. `registerRpcHandlers` receberá o store e registrará leitura de transcript; `startServer` criará/fechará o store e o injetará no runner.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Vitest, HTTP RPC/SSE.

---

### Task 1: Definir a API paginada e escrever testes do store

**Files:**
- Create: `test/store.test.ts`
- Modify: `src/store/index.ts`

- [ ] Escrever testes Vitest usando arquivo temporário único por teste para: schema, append/getEntries, reabertura, nonce persistente, FIFO, paginação e outline.
- [ ] Escrever teste que exige `SqliteTranscriptStore` com `close()` e `getAgentTranscriptTail()`.
- [ ] Rodar `npm test -- --run test/store.test.ts` e confirmar falha por export ausente.

### Task 2: Implementar SQLite básico e ledger persistente

**Files:**
- Modify: `src/store/index.ts`
- Test: `test/store.test.ts`

- [ ] Implementar `SqliteTranscriptStoreOptions`, `TranscriptPage`, `ConversationOutline` e `SqliteTranscriptStore`.
- [ ] Abrir `:memory:` ou caminho configurável, habilitar `foreign_keys`, WAL quando aplicável, `synchronous=NORMAL`, `busy_timeout` e migração idempotente via `PRAGMA user_version`.
- [ ] Criar tabelas/indexes com SQL estático e valores sempre parametrizados.
- [ ] Implementar append transacional serializando cada entry em JSON; `getEntries` desserializa e valida que o payload é objeto.
- [ ] Implementar `hasAcceptedNonce`, `rememberAcceptedNonce` com `INSERT OR IGNORE`, `trimAcceptedNonces` com remoção ordenada e `clear` transacional.
- [ ] Rodar `npm test -- --run test/store.test.ts`; esperar todos os testes básicos verdes.

### Task 3: Implementar paginação e outline

**Files:**
- Modify: `src/store/index.ts`
- Modify: `test/store.test.ts`

- [ ] Usar cursor opaco `sequence_id` decimal; aceitar apenas inteiro positivo dentro do formato; rejeitar cursor inválido.
- [ ] Implementar leitura `limit + 1`, `nextCursor` somente quando há página seguinte e `openAgentTail` como alias.
- [ ] Definir limite padrão/máximo exportados e rejeitar limites fora do intervalo.
- [ ] Implementar outline vazio e outline com primeira/última mensagem; mensagens sem conteúdo serão ignoradas como título.
- [ ] Rodar testes do store e build TypeScript.

### Task 4: Integrar store ao runner e bootstrap

**Files:**
- Modify: `src/rpc/index.ts`
- Modify: `src/main.ts`
- Modify: `test/rpc-send-gateway.integration.test.ts`
- Modify: `test/bootstrap.test.ts`

- [ ] Alterar `registerRpcHandlers` para aceitar `store?: TranscriptStore`, usar o store no runner e registrar as três rotas de leitura.
- [ ] Validar corpos RPC: objeto, `agentId` não vazio, `limit` inteiro válido e `cursor` string válida; erros viram `RpcError(400)`.
- [ ] Alterar `startServer` para criar `SqliteTranscriptStore` no diretório configurável, aceitar `storeDir`/`storePath` e expor `store` no `ServerHandle`.
- [ ] Fechar o store no `stopServer` após fechar o HTTP server, sem mascarar erro de fechamento quando o servidor já estiver fechado.
- [ ] Adicionar integração HTTP para as três rotas e confirmar que o transcript produzido por `sendPrompt` é lido pela rota.
- [ ] Adicionar teste de restart fechando o primeiro handle e abrindo outro com o mesmo caminho; confirmar transcript e nonce preservados.
- [ ] Rodar os testes focados e confirmar verde.

### Task 5: Verificação final e documentação de estado

**Files:**
- Modify: `README.md`
- Review: `docs/superpowers/specs/2026-08-11-t11-sqlite-transcript-design.md`

- [ ] Atualizar o estado do README: T11 DONE e comandos/integração SQLite descritos sem prometer T12–T14.
- [ ] Rodar `npm run build`.
- [ ] Rodar `npm test` completo.
- [ ] Fazer probe real com dois handles no mesmo `storePath` e confirmar leitura após restart.
- [ ] Conferir mudanças e não deixar `store.db`, WAL, SHM ou diretórios temporários no repositório.
