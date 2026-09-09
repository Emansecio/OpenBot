# OpenBot GrokBot 0.18 P0 Foundations Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Close P0.1–P0.4 with executable provenance, measurement, task-contract, persistence, and renderer-boundary gates before implementing multiagent runtime behavior.

**Architecture:** Keep the existing SQLite/shared-runtime/renderer boundaries. Add independent, deep modules: a machine-readable provenance catalog with a verifier; hermetic benchmark cases using the public turn-runner interface; a pure typed task state machine backed by new SQLite records; and an artifact-boundary verifier layered on the existing manifest gate.

**Tech Stack:** Node.js 20+, TypeScript 5.8 strict mode, Vitest 3, better-sqlite3, Electron artifact manifests, PowerShell/Windows verification.

**Workspace constraint:** `C:\SuperAgent\openbot` has no `.git`; do not invent commit evidence. Preserve unrelated files, edit one task at a time, and use test output plus SHA-256 snapshots as evidence.

---

## File map

| File | Responsibility |
|---|---|
| `provenance/openbot-components.json` | Machine-readable origin/classification/reuse policy for every component class used by this project |
| `docs/openbot-provenance-ledger.md` | Human explanation of the clean-room and redistribution boundary |
| `scripts/verify-provenance-ledger.mjs` | Fail-closed schema, path, classification, and forbidden-source gate |
| `test/provenance-ledger.test.ts` | Behavioral verification of the provenance gate |
| `scripts/benchmark-hot-paths.mjs` | Hermetic structural and diagnostic measurements |
| `test/performance-regression.test.ts` | Deterministic observable performance invariants |
| `src/tasks/contracts.ts` | Closed task, attempt, lease, capability, budget, event, and result types |
| `src/tasks/state-machine.ts` | Pure transition, grant, budget, and recovery rules |
| `src/tasks/store.ts` | SQLite task/attempt/grant/outbox persistence and atomic CAS operations |
| `src/store/schema.ts` | Versioned tables and indices required by the task contract |
| `test/async-task-contract.test.ts` | State/grant/budget public-contract tests |
| `test/async-task-store.test.ts` | Idempotency, CAS, lease, outbox, retry, and restart tests |
| `scripts/verify-renderer-boundary.mjs` | Enforces immutable extracted artifacts and a closed overlay allowlist |
| `test/renderer-boundary.test.ts` | Proves proprietary assets fail closed and declared overlays remain valid |
| `package.json` | Stable verification commands |

### Task 1: P0.1 provenance ledger and gate

**Files:**
- Create: `provenance/openbot-components.json`
- Create: `docs/openbot-provenance-ledger.md`
- Create: `scripts/verify-provenance-ledger.mjs`
- Create: `test/provenance-ledger.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write the failing verifier tests**

Test the public CLI, not internal helpers:

```ts
const result = spawnSync(process.execPath, ["scripts/verify-provenance-ledger.mjs", "--json"], {
  cwd: root,
  encoding: "utf8",
});
expect(result.status).toBe(0);
expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
```

Add negative fixtures at runtime for an unknown classification, an escaping local path, a reusable competitor entry, and a missing SHA/commit on observational evidence.

- [x] **Step 2: Run RED**

Run: `npx vitest run test/provenance-ledger.test.ts --maxWorkers=1 --no-file-parallelism`  
Expected: FAIL because the verifier/catalog do not exist.

- [x] **Step 3: Implement the closed catalog and verifier**

Allowed classifications are exactly:

```js
const CLASSIFICATIONS = new Set([
  "own-code",
  "licensed-dependency",
  "extracted-artifact",
  "observational-reference",
  "non-reusable",
]);
```

Every entry must have `id`, `classification`, `origin`, `reuse`, and either a contained local path or an HTTPS repository/commit reference. `observational-reference`, `extracted-artifact`, and `non-reusable` must never declare `reuse: "copy"`. Local paths must resolve inside the repository. The verifier must emit one JSON object and a non-zero exit on any violation.

- [x] **Step 4: Document the boundary**

The Markdown ledger must enumerate project source, dependencies, extracted 0.16 artifacts, OpenBot overlays, the observed 0.18 snapshot, and the explicit no-copy/no-redistribution rules. It must state that hash proves integrity, not authorship, license, or authenticity.

- [x] **Step 5: Run GREEN and regression**

Run:

```text
npx vitest run test/provenance-ledger.test.ts --maxWorkers=1 --no-file-parallelism
npm run verify:provenance
npm run typecheck
```

Expected: all PASS.

### Task 2: P0.2 deterministic hot-path completion

**Files:**
- Modify: `scripts/benchmark-hot-paths.mjs`
- Modify: `test/performance-regression.test.ts`
- Modify: `package.json` only if a new stable diagnostic command is necessary

- [x] **Step 1: Add one RED tracer for a long streamed response**

Drive `createTurnRunner` with a fake provider that emits thousands of deltas through `setPublish`. Assert observable output and metrics: final content length, maximum SSE payload bytes, update count, append/replace count, provider call count, elapsed time, event-loop lag sample, heap before/peak/after, and accumulated bytes.

- [x] **Step 2: Run RED**

Run: `npx vitest run test/performance-regression.test.ts --maxWorkers=1 --no-file-parallelism`  
Expected: the new case fails because the benchmark report lacks `longStream`.

- [x] **Step 3: Implement `benchmarkLongStream()`**

Use a fake provider, a real temporary `SqliteTranscriptStore` that is closed/reopened to prove final persistence, deterministic barriers, `monitorEventLoopDelay`, `process.memoryUsage().heapUsed`, and published transcript events. Do not use internet, credentials, Electron, WSL, or AppData. Add the case to `cases` and gate only structural invariants; TTFT, timing, heap and hardware values are diagnostic metadata, not machine-dependent pass thresholds. Distinguish logical store mutations/checkpoints from physical SQLite writes.

- [x] **Step 4: Add remaining scenario diagnostics vertically**

Add one RED/GREEN cycle each for:

1. maximum declared avatar byte size through the public validation seam;
2. sixteen attachments near the aggregate limit through a temporary workspace;
3. a slow provider with multiple agents that proves overlap/fairness without inventing global `N`;
4. SSE/update/write counters that distinguish published updates from durable checkpoints.

- [x] **Step 5: Run GREEN and regression**

Run:

```text
npx vitest run test/performance-regression.test.ts test/rpc-send.test.ts test/fidelity-windows.test.ts --maxWorkers=1 --no-file-parallelism
npm run benchmark:hot-paths
npm run typecheck
```

Expected: all PASS and benchmark JSON has `ok: true`, environment metadata, and no real-provider activity.

### Task 3: P0.3 typed durable async-task contract

**Files:**
- Create: `src/tasks/contracts.ts`
- Create: `src/tasks/state-machine.ts`
- Create: `src/tasks/store.ts`
- Modify: `src/store/schema.ts`
- Create: `test/async-task-contract.test.ts`
- Create: `test/async-task-store.test.ts`

- [x] **Step 1: RED for required nonce and legal transitions**

The public interface starts with:

```ts
export type AsyncTaskStatus =
  | "queued" | "admitted" | "running" | "retry_wait"
  | "cancelling" | "completed" | "failed" | "cancelled" | "abandoned";

export function assertTaskTransition(from: AsyncTaskStatus, to: AsyncTaskStatus): void;
export function requireTaskClientNonce(value: unknown): string;
```

Tests must prove an empty nonce fails, terminal states are immutable, and every transition in the report is accepted/rejected exactly.

- [x] **Step 2: Run RED, then implement the pure state machine to GREEN**

Run: `npx vitest run test/async-task-contract.test.ts --maxWorkers=1 --no-file-parallelism`.

- [x] **Step 3: RED/GREEN capability grants**

Implement a discriminated union for provider, filesystem, process, browser, MCP, and skill grants. `deriveEffectiveGrant` must intersect the requested grant with the parent's current grant and hard policy, default-deny omitted operations, enforce expiry/revocation/version, reject depth above one, and contain only opaque credential references.

- [x] **Step 4: RED/GREEN persisted shared budgets**

Implement the exact `SubagentBudget` dimensions from the report and a persisted usage object. `deriveEffectiveBudget` selects the minimum of hard cap, parent remaining, and requested values. Reservation/reconciliation must never make counters negative, retries must reuse usage, and exhaustion must produce `budget_exhausted` without implicit retry.

- [x] **Step 5: RED for the SQLite transaction contract**

Tests must open a real temporary SQLite database and prove:

```text
same (agent_id, client_nonce) -> same task
CAS with stale version -> rejected
one active lease per task
terminal state + outbox event -> same transaction
retry creates a new attempt but keeps task identity and budget usage
restart preserves task, attempts, grants, usage, lease and undelivered outbox
```

- [x] **Step 6: Implement schema/store and migrate to GREEN**

Add versioned `async_tasks`, `async_task_attempts`, `async_task_grants`, `async_task_budget_usage`, and `async_task_outbox` tables with the unique/index invariants from the report. `AsyncTaskStore` exposes atomic dispatch, claim, start/heartbeat, transition, steer/abort intent, terminal commit, outbox acknowledgement, lease recovery, and list/get methods. It must not execute tasks yet.

- [x] **Step 7: Run GREEN and regression**

Run:

```text
npx vitest run test/async-task-contract.test.ts test/async-task-store.test.ts test/store.test.ts test/turn-crash-recovery.test.ts --maxWorkers=1 --no-file-parallelism
npm run typecheck
npm run build
```

Expected: all PASS.

### Task 4: P0.4 renderer boundary gate

**Files:**
- Create: `scripts/verify-renderer-boundary.mjs`
- Create: `test/renderer-boundary.test.ts`
- Modify: `package.json`
- Modify: `scripts/verify-visual-ui-gate.mjs` to invoke the new verifier before visual checks

- [x] **Step 1: Write RED boundary tests**

Spawn the verifier against temporary manifests/roots and prove it rejects:

1. a changed extracted JS chunk;
2. a changed extracted CSS file;
3. any sourcemap under the renderer assets directory;
4. an undeclared overlay;
5. an overlay path outside the closed allowlist.

It must accept only `openbot-local-settings.js`, `openbot-memory-ui.js`, and declared OpenBot-owned media already listed in the manifest.

- [x] **Step 2: Run RED**

Run: `npx vitest run test/renderer-boundary.test.ts --maxWorkers=1 --no-file-parallelism`  
Expected: FAIL because the verifier does not exist.

- [x] **Step 3: Implement the verifier**

Reuse manifest hashes and path-containment rules. Do not rewrite or repair files. Emit a machine-readable result with every checked immutable artifact and every permitted overlay.

- [x] **Step 4: Wire the stable gate**

Add `verify:renderer-boundary` to `package.json` and invoke it from the existing visual gate before runtime visual checks.

- [x] **Step 5: Run GREEN and P0 regression**

Run:

```text
npx vitest run test/renderer-boundary.test.ts test/electron-client-artifacts.test.ts test/fidelity-windows.test.ts --maxWorkers=1 --no-file-parallelism
npm run verify:renderer-boundary
npm run verify:client-artifacts
npm run typecheck
npm run build
```

Expected: all PASS.

## P0 exit audit

- [x] Re-run all P0 focused suites together.
- [x] Run `npm test -- --maxWorkers=1 --no-file-parallelism` and separately retry any environmental flake before classification.
- [x] Run `npm run benchmark:hot-paths`, `npm run verify:provenance`, `npm run verify:renderer-boundary`, `npm run verify:client-artifacts`, `npm run typecheck`, and `npm run build`.
- [x] Update the roadmap evidence ledger with exact counts and outputs.
- [x] Review P0 for report compliance first, then code quality, before P1 begins.
