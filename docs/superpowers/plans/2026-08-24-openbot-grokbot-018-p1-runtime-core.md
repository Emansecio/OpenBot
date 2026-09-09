# OpenBot + Grok Bot 0.18 — P1 Runtime Core Plan

**Specification:** `docs/openbot-grokbot-018-consolidated-improvement-report-2026-08-24.md`  
**Depends on:** completed P0.1–P0.4 exit audit  
**Goal:** add bounded provider admission, durable depth-1 subagents, model-aware context, linear streaming and Windows artifact gates without creating a process/runtime/home per subagent.

## Frozen decisions

1. The production topology remains one OpenBot Node process with shared provider, browser, MCP, local execution and SQLite services.
2. Provider admission limits calls to `ProviderAdapter.streamChat`, not context preparation or tool execution. Every provider round/retry reacquires a slot.
3. P0.2 observed four concurrent slow providers. P1.1 therefore starts with `maxActive = 4`; tests inject smaller deterministic limits. `maxQueued = 64` is an independent safety cap. Production overrides are environment-only: `OPENBOT_PROVIDER_MAX_ACTIVE` (integer `1..64`) and `OPENBOT_PROVIDER_MAX_QUEUED` (integer `1..4096`); absent values use the defaults and malformed, zero, fractional, negative or overflowing values fail startup. There is no competing persisted-config source in P1.1.
4. Async task state remains authoritative in SQLite. RPC, SSE, parent wakes and UI are projections.
5. A depth-1 subagent receives an immutable sanitized objective, a bounded/revocable grant and one persisted budget shared by every retry. It uses shared services and receives no permanent process, home or database.
6. P0.2 proved a material streaming RED. P1.4 will emit ordered deltas and periodic authoritative snapshots/checkpoints; reconnect always converges from SQLite.
7. Hashes prove integrity, not authenticity. P1.5 may prepare signing/attestation seams and policy, but must not claim a public signature without an external key/certificate.

## Task 1 — P1.1 global fair provider admission

**Files:**

- Create `src/providers/admission.ts`
- Create `test/provider-admission.test.ts`
- Modify `src/rpc/send.ts`
- Modify `src/providers/router.ts`
- Modify `src/rpc/index.ts`
- Modify `src/main.ts`
- Modify `test/rpc-send.test.ts`
- Modify `test/autonomous-execution.integration.test.ts`

- [x] RED: prove `maxActive`, round-robin across agents, FIFO within one agent, abort-before-admission, queue-full rejection, failure release, drain, shutdown settlement and reacquisition by every retry with `maxRetries > 0`.
- [x] Implement a scheduler with explicit waiter records and an idempotent lease/release handle. Removing an aborted waiter must be O(1) or bounded without retaining its signal/listener.
- [x] Expose a metrics snapshot containing active, waiting, admitted, rejected, aborted and wait-time observations without agent prompt/content.
- [x] Add the scheduler/agent identity to `RouterOptions` and acquire/release immediately around each `adapter.streamChat` attempt in `src/providers/router.ts`. This is the authoritative retry seam: every internal retry reacquires fairness. Direct and tool-loop calls in `src/rpc/send.ts`, plus the reflection call path wired from `src/main.ts`, must pass the same singleton; never hold a provider slot while a tool executes.
- [x] Keep nonce claim/dedupe before admission wait and same-agent turn serialization unchanged.
- [x] Wire one shared production instance into the server lifecycle. Shutdown rejects new waiters, settles queued waiters and drains active leases without dangling promises.
- [x] Validate production overrides; invalid/zero/overflow values fail startup instead of silently disabling the cap.
- [x] GREEN: focused scheduler/send/autonomous tests, core acceptance, typecheck and build.

**Acceptance:** never more than four production provider calls by default; different agents progress without starvation; a cancelled waiter never consumes a slot; control paths are not queued behind provider admission unless they start a new inference.

## Task 2 — P1.2 durable async tasks and depth-1 subagents

**Files:**

- Modify `src/tasks/contracts.ts`
- Modify `src/tasks/store.ts`
- Modify `src/store/schema.ts`
- Create `src/tasks/runtime.ts`
- Create `src/rpc/tasks.ts`
- Modify `src/rpc/roster.ts`
- Modify `src/rpc/index.ts`
- Modify `src/server/gateway.ts`
- Modify `src/shared/contracts.ts`
- Modify `src/main.ts`
- Create `test/async-task-runtime.test.ts`
- Create `test/async-task-rpc.integration.test.ts`
- Modify `test/async-task-store.test.ts`
- Modify `test/turn-crash-recovery.test.ts`
- Modify roster deletion tests

- [x] RED: dispatch ACK/dedupe by `(agentId, clientNonce)`, immutable sanitized objective, depth rejection, cross-agent read/control denial, exact terminal wake, restart recovery, shared retry budget, revoked grant, parent deletion and reconnect/resync.
- [x] Add schema v9 with an immutable `TaskInputV1`: `{version: 1, objective, source: {kind: "parent_turn", agentId, conversationId?, turnEntryId?}}`. P1.2 accepts text-only objectives: valid Unicode normalized to NFC, `1..32768` UTF-8 bytes; attachments and copied context payloads stay out until P2.3. Reject lone surrogates, secret matches and oversized input before persistence. Never overload progress/result/outbox with the objective; source IDs are opaque validated identifiers, not content.
- [x] Implement a shared-process worker that claims by lease, starts/heartbeats, executes through injected shared provider/tool/browser services and commits terminal state transactionally.
- [x] Route every provider call through P1.1. Reserve worst-case budget before provider/tool/MCP/browser/write effects and reconcile actual usage afterward.
- [x] Enforce grant scope at the real effect boundary. Credential authority is a reference/policy decision; no secret value enters task/grant/outbox/result.
- [x] Poll/consume steer and abort intents idempotently. Abort before/after admission must converge deterministically.
- [x] Implement bounded retry with distinct attempts, shared counters and `nextAttemptAt`; no retry after observable side effects unless the boundary is explicitly safe.
- [x] Replace empty `getSubagents`/`getAsyncTasks` handlers with gateway-authenticated list/get/dispatch/steer/abort/settle handlers. `agentId` must name an existing configured agent; every `taskId` lookup/update must include that same `agentId`, return not-found on mismatch and never disclose the owning agent. The local bearer authenticates the user, while selected-agent scoping enforces data isolation; it is not a claim of separate end-user identities.
- [x] Give each `async-tasks`/`subagents` projection a durable envelope `{epoch, sequence, agentId, taskId, snapshotVersion, kind, payload}`. Sequence is monotonically allocated per `(agentId, channel, epoch)` so interleaved tasks remain ordered. The SQLite outbox is the durable queue; `Gateway.publish` gains an explicit delivery receipt. ACK only after at least one eligible active subscriber accepts the frame into every current bounded SSE queue. Zero subscribers, oversize/backpressure or a write rejection leaves it unacknowledged. Duplicate delivery is allowed and deduped by envelope identity.
- [x] On connect/reconnect, a missing/stale cursor, epoch mismatch or sequence gap must rebuild an authoritative agent-scoped snapshot from SQLite before later events. This snapshot rule is the loss-recovery boundary even if a process dies after queue acceptance but before browser receipt.
- [x] Add `AsyncTaskRuntime` to `ServerHandle`; start exactly one worker after stores/RPC are ready. `performStopServer()` quiesces dispatch, calls `stop()`, drains worker promises/leases within the existing shutdown deadline, then closes shared stores. Restart tests cover process exit in both `running` and `retry_wait`.
- [x] Before parent deletion, persist an agent deletion fence that rejects concurrent dispatch, terminalize all nonterminal children with outbox wakes, then remove parent resources. If a later roster deletion step rolls back, clear the fence but keep children terminal (never resurrect attempts); retry remains idempotent.
- [x] Fix any P0 store edge exposed by the live runtime: revoked queued tasks must terminalize, terminal oversize results must use an explicit marker and `resultRef` must remain sanitized.
- [x] GREEN: contract/store/runtime/RPC/restart/deletion tests, scheduler integration, core acceptance, typecheck and build.

**Acceptance:** ACK does not wait for completion; depth is exactly one; no cross-agent task leak; one logical terminal wake; no per-subagent VM/process/home/database.

## Task 3 — P1.3 model-aware context

**Files:**

- Modify `src/config/models.ts`
- Modify `src/shared/contracts.ts`
- Create `src/memory/model-context.ts`
- Modify `src/memory/context.ts`
- Modify `src/rpc/send.ts`
- Modify provider request types only where an output reserve must be passed
- Create `test/model-context.test.ts`
- Modify `test/memory-context.test.ts`
- Modify `test/rpc-send.test.ts`

- [x] RED with a deterministic fake tokenizer: two models with different windows produce different input budgets; unknown OpenAI-compatible models get a conservative finite fallback.
- [x] Extend the canonical `ModelCatalogEntry` in `src/shared/contracts.ts` and the catalog in `src/config/models.ts` with context window, maximum output, tokenizer strategy and safety margin. Reject inconsistent or infinite capabilities while preserving a conservative finite path for consumers of entries whose legacy `contextWindow` is absent.
- [x] Compute one request budget covering system prompt, tool schemas, transcript, memory and attachments, while retaining the absolute byte cap as the last defense.
- [x] Preserve whole turns and tool-call/tool-result groups. Never leave an orphaned tool call; drop the oldest complete group first.
- [x] Reserve output tokens explicitly and pass the bounded output maximum to adapters that support it.
- [x] Emit one sanitized truncation notice with used/available categories; attachment/tool output truncation keeps a valid explicit marker.
- [x] GREEN: model-context/memory/send/provider regressions, performance gate, typecheck and build.

## Task 4 — P1.4 ordered streaming deltas plus resync

**Files:**

- Modify `src/shared/contracts.ts`
- Modify `src/rpc/stream-state.ts`
- Modify `src/rpc/send.ts`
- Modify `src/server/gateway.ts` only if typed SSE validation requires it
- Modify `test/stream-state.test.ts`
- Modify `test/rpc-send.test.ts`
- Modify `test/rpc-send-gateway.integration.test.ts`
- Modify `test/performance-regression.test.ts`
- Modify `scripts/benchmark-hot-paths.mjs`

- [x] RED: 2,048 fragments must have approximately linear published bytes; sequence gap/reorder forces snapshot resync; reconnect converges to SQLite; cancel keeps one partial/interrupted result.
- [x] Define `transcript.delta` with `agentId`, optional conversation, entry ID, a bounded UTF-8 fragment and the existing `TranscriptEventOrder`. Its namespace is per `replicaKey` (the live entry/stream identity) and `epoch`; sequence is strictly increasing inside that namespace and reuses the existing ordering machinery rather than creating a second counter.
- [x] Publish one initial `appended` entry without an attached delta, then ordered deltas for accepted fragments. Periodic `updated` snapshots carry the same ordering tuple plus `throughSequence`; a client replaces content, discards already-applied deltas through that value and resumes after it. Finalization emits no repeated delta: it emits one authoritative final `updated` snapshot (`final: true`) through the last sequence.
- [x] Keep durable checkpoint cadence independent of public delta cadence. No per-delta SQLite write and no unbounded live preview.
- [x] Maintain a bounded replay/resync policy: reconnect without a cursor, stale epoch or any gap/reorder returns the SQLite authoritative snapshot and a fresh epoch rather than guessing missing text. Live deltas are not promised across reconnect; dedupe is `(replicaKey, epoch, sequence)` and the final snapshot prevents fragment duplication.
- [x] Preserve response byte caps, tool ordering and abort/error finalization.
- [x] Update the benchmark gate so accumulated published bytes are linear within an objective structural factor and the exact 2,048-fragment output/cardinality remains verified.
- [x] GREEN: stream/send/gateway/performance tests, core acceptance, renderer artifact gate, typecheck and build.

## Task 5 — P1.5 Windows artifact target gates

**Files:**

- Create `.github/workflows/windows-artifact-gate.yml`
- Create `scripts/verify-windows-artifact-gate.mjs`
- Create `docs/openbot-artifact-authenticity-policy.md`
- Modify `scripts/monitor-rede.ps1`
- Modify `package.json`
- Create `test/windows-artifact-gate.test.ts`
- Modify release/smoke tests where needed

- [x] RED: workflow omits build/package/verify/smoke, calls SHA a signature, monitor compares hostnames directly to IP-only `RemoteAddress`, or artifact verification lacks a clean-root check.
- [x] Add a clean `windows-latest` workflow with the exact chain: `npm ci`; `npm run typecheck`; `npm run build`; `npm test -- --maxWorkers=1 --no-file-parallelism`; provenance/renderer/client gates; `npm run release:package`; run `verify-windows-artifact-gate` against the produced directory/zip copied to a new temporary clean root; `node scripts/launch.mjs --preflight` against that packaged root; then the existing hermetic local smoke. Upload the artifact and machine-readable gate evidence only after all steps pass. Non-Windows invocation fails with an explicit unsupported-platform result rather than pretending to validate Windows.
- [x] Keep release hash verification and label it integrity only. Define signer identity, protected-key/CI trust, timestamp/revocation and verification policy before public distribution.
- [x] Add a signing interface/disabled gate that reports `unsigned` honestly until an external certificate/key is configured; never generate or commit a production key.
- [x] Fix network monitoring with one deterministic seam: resolve each expected hostname to a normalized set of IPv4/IPv6 addresses before capture, inject/fixture that resolver in tests, and compare only normalized IPs to `RemoteAddress`. Resolution failure or an IP with no proven hostname identity is `unknown`, never `blocked`; tests use no real DNS/network.
- [x] GREEN: workflow/static tests, release lifecycle, package/preflight/smoke, monitor parser fixtures, provenance, renderer/client artifact gates, typecheck and build.

## P1 exit audit

- [x] Re-run all focused P1 suites together. The final serial run included every P1 suite; the dedicated P1.4 matrix passed 11 files and 194/194 tests.
- [x] Run core acceptance, crash recovery, roster deletion, gateway/SSE and provider regressions. All passed inside the final serial run; the gateway/transcript integration also passed 17/17 independently.
- [x] Run `npm test -- --maxWorkers=1 --no-file-parallelism`: 139 files, 1,901 passed, 2 skipped, 0 failed in 703.08 seconds.
- [x] Run benchmark, provenance, renderer/client artifact, Windows artifact, typecheck, build, package and hermetic smoke gates. The packaged directory, ZIP and sidecar passed the clean-root Windows gate and packaged preflight; the local smoke persisted across restart.
- [x] Audit P1.1–P1.5 requirement by requirement, then run a separate quality/security review. Final P1.4 specification and quality reviews passed after the packaged adapter and coordinator hashes matched the workspace.
- [x] Update the execution roadmap with exact RED/GREEN/regression evidence before P2.
