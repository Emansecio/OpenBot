# Chat And Provider Resilience Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Make provider failures, cancellation, retry and model switching safe and understandable in the local desktop chat.

**Architecture:** Extend the existing provider router and turn runner instead of adding a new service. Persist attempt metadata in the current transcript, expose two narrow RPCs (`retryPrompt`, `getPromptStatus`), and reuse the existing Electron IPC bridge and renderer override.

**Tech Stack:** TypeScript, Node.js fetch/Web Streams, Vitest, SQLite, Electron IPC, injected renderer JavaScript.

---

### Task 1: Strict provider stream and bounded retry policy

**Files:**
- Modify: `src/providers/router.ts`
- Modify: `src/providers/openai-helpers.ts`
- Modify: `src/providers/openai.ts`
- Modify: `src/providers/openai-compat.ts`
- Test: `test/provider-regressions.test.ts`
- Test: `test/router.test.ts`

- [ ] Add a failing adapter test proving a JSON SSE frame without chat-completion fields cannot end as `{aborted:false}` with only `done`.
- [ ] Add a failing router test proving `retryAfterMs` controls the bounded sleep and `ETIMEDOUT` is not automatically replayed.
- [ ] Implement shared frame validation, Retry-After parsing and normalized retry metadata.
- [ ] Run `npx vitest run test/provider-regressions.test.ts test/router.test.ts --maxWorkers=1 --no-file-parallelism`; expect all tests to pass.

### Task 2: Pin inference and persist structured turn failures

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/rpc/send.ts`
- Test: `test/rpc-send.test.ts`

- [ ] Add a failing test that pauses attachment preparation, changes configuration, and expects the accepted provider/model to remain pinned.
- [ ] Add a failing test requiring assistant/failure entries to expose turn, provider and model metadata plus normalized retryability.
- [ ] Capture inference in `sendPrompt`, pass it into `runTurn`, and attach bounded user-facing error metadata.
- [ ] Run `npx vitest run test/rpc-send.test.ts --maxWorkers=1 --no-file-parallelism`; expect all tests to pass.

### Task 3: Safe idempotent retry without duplicate user messages

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/rpc/send.ts`
- Modify: `src/store/index.ts`
- Modify: `src/server/gateway.ts`
- Test: `test/rpc-send.test.ts`
- Test: `test/store.test.ts`
- Test: `test/rpc-send-gateway.integration.test.ts`

- [ ] Add a failing test where `retryPrompt` repeats a retryable failed attempt but leaves exactly one user entry.
- [ ] Add a failing restart-reconciliation test for a durable `retry-attempt` nonce.
- [ ] Implement latest-failure lookup, deterministic retry nonce, attempt event and RPC registration.
- [ ] Add a gateway integration test for idempotent repeated retry calls.
- [ ] Run the three focused test files serially; expect all tests to pass.

### Task 4: Authoritative cancellation and retry controls in Electron

**Files:**
- Modify: `client/extracted/dist/electron-main/main.cjs`
- Modify: `client/extracted/dist/electron-preload/preload.cjs`
- Modify: `client/extracted/dist/renderer/assets/openbot-local-settings.js`
- Modify: `client/client-artifacts.manifest.json`
- Test: `test/electron-windows-patches.test.ts`
- Test: `test/electron-client-artifacts.test.ts`

- [ ] Add failing source-contract tests for `retryPrompt`, `getPromptStatus` and absence of the fixed 120-second hide timer.
- [ ] Expose only the two request-response IPC methods through the existing trusted bridge.
- [ ] Poll prompt status only while a turn is believed active; retain the stop control on status transport errors.
- [ ] Add a retry button to rendered generation-error notices and disable it while the retry RPC is pending.
- [ ] Recompute the three artifact hashes and run the focused Electron tests plus `npm run verify:client-artifacts`.

### Task 5: Complete verification and documentation

**Files:**
- Modify: `README.md` only if the new recovery behavior needs a user-facing note.
- Modify: `docs/verification-gates.md`

- [ ] Run `npm run typecheck` and `npm run build`.
- [ ] Run `npm test -- --maxWorkers=1 --no-file-parallelism`.
- [ ] Run `npm run verify:client-artifacts`, `npm run verify:core:acceptance` and `npm run verify:e2e:desktop`.
- [ ] Run `npm run smoke:shortcut` with isolated data and confirm ports/processes are released.
- [ ] Record exact results and any external-provider coverage gap without claiming unexecuted live-provider behavior.
