# Turn Crash Recovery Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Make accepted turns, retries and partial streams recoverable across crashes while keeping Electron controls bound to the correct bot.

**Architecture:** Persist only open turn attempts in SQLite and reconcile them into the existing transcript on restart. Keep the existing provider, queue and SSE architecture; harden ownership identity and the current Electron IPC/renderer override.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Node/Windows process evidence, Electron IPC, CDP E2E.

---

### Task 1: Durable in-flight turn journal

**Files:**
- Modify: `src/rpc/send.ts`
- Modify: `src/store/index.ts`
- Modify: `src/shared/contracts.ts`
- Test: `test/store.test.ts`
- Test: `test/rpc-send.test.ts`

- [ ] Add a failing restart test for a durable user echo with no assistant.
- [ ] Implement `beginTurnAttempt`, phase update and `finishTurnAttempt` in memory and SQLite stores.
- [ ] Reconcile visible open attempts into one retryable restart notice and delete the open row.
- [ ] Run store/send tests serially and require GREEN.

### Task 2: Interrupted partial and retry recovery

**Files:**
- Modify: `src/rpc/send.ts`
- Modify: `src/store/index.ts`
- Modify: `src/shared/contracts.ts`
- Test: `test/store.test.ts`
- Test: `test/rpc-send.test.ts`
- Test: `test/rpc-send-gateway.integration.test.ts`

- [ ] Add a failing test proving a reconciled partial is excluded from the next provider request.
- [ ] Add a failing test proving a crash after `retry-attempt` executes a new retry after reopen.
- [ ] Mark partials interrupted, append recoverable notices and omit interrupted assistants from provider history.
- [ ] Run focused store/RPC/gateway tests serially and require GREEN.

### Task 3: Process ownership resistant to PID reuse

**Files:**
- Modify: `src/store/index.ts`
- Test: `test/store.test.ts`

- [ ] Add a failing injected-identity test where a live reused PID has a different start time/executable.
- [ ] Migrate owner rows to store process start and executable evidence.
- [ ] Treat only exact identity matches as live owners; retain current-process fast path.
- [ ] Run store tests and typecheck.

### Task 4: Per-agent Electron controls and deadlines

**Files:**
- Modify: `client/extracted/dist/electron-main/main.cjs`
- Modify: `client/extracted/dist/renderer/assets/openbot-local-settings.js`
- Modify: `client/client-artifacts.manifest.json`
- Test: `test/electron-windows-patches.test.ts`

- [ ] Add failing source-contract tests for prompt-control deadlines and agent-bound state.
- [ ] Add bounded control fetches in main and track active/busy agents in the renderer override.
- [ ] Ensure timeout paths re-enable buttons and reschedule status polling.
- [ ] Recompute hashes and require client artifact GREEN.

### Task 5: Integrated restart and bot-switch verification

**Files:**
- Modify: `test/e2e-desktop/fixture.mjs`
- Modify: `test/e2e-desktop/cdp-check.mjs`
- Modify: `scripts/e2e-desktop-run.ps1`
- Modify: `docs/chat-provider-resilience.md`
- Modify: `docs/verification-gates.md`

- [ ] Extend the isolated fixture with two bots and observable per-agent streams.
- [ ] Verify switching bots does not redirect cancellation and restart recovers an interrupted turn.
- [ ] Run typecheck, build, focused resilience gate, full serial suite, Electron E2E and shortcut smoke.
- [ ] Record exact results and residual live-provider limitations.
