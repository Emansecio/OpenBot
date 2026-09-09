# OpenBot + Grok Bot 0.18 — P2 Durable Collaboration and Product Plan

**Specification:** `docs/openbot-grokbot-018-consolidated-improvement-report-2026-08-24.md`  
**Depends on:** P0.1–P0.4 and P1.1–P1.5 exit audit  
**Goal:** add durable agent-to-agent collaboration, usable task/conversation surfaces, optional provider capabilities, safe resume and explicit onboarding without weakening the shared local runtime or the proprietary-renderer boundary.

## Frozen decisions

1. The production topology remains one OpenBot Node process with shared SQLite, provider admission, browser, MCP, skill and local-execution services. No permanent process, VM, database or home is created per agent, task or message.
2. SQLite is authoritative. RPC, SSE, wakes and renderer state are projections; a process-local preview never becomes reconnect authority.
3. The proprietary renderer chunks, CSS and source maps stay immutable. Product UI may use only the existing native contract or the allowlisted `openbot-local-settings.js` / `openbot-memory-ui.js` overlays, followed by manifest and boundary verification.
4. A2A delivery, physical wake, consumer ACK and SSE projection are separate states. Queue acceptance or browser receipt never counts as durable consumer ACK.
5. A2A payloads are closed, text/reference-only versioned contracts. Arbitrary JSON, inline credentials, cookies, attachment bytes and copied context are forbidden.
6. Agent identity includes a durable incarnation. Delete/recreate with the same visible ID cannot inherit old A2A messages.
7. Task/subagent UI reuses existing durable projections and SSE. It must not add continuous polling.
8. Attachment UI uses server-side staging IDs, never arbitrary renderer paths or localStorage bytes. Reply authority is the referenced persisted entry, not quoted client text.
9. Thinking is never synthesized. Only adapters declaring and emitting canonical reasoning events may expose sanitized progress; raw private chain-of-thought is not persisted by default.
10. Optional providers are disabled by default, capability-gated and testable with offline fixtures. No test requires paid network, browser-token extraction or interactive login.
11. Resume is fail-closed. Without a real provider cursor plus durable idempotency boundaries, the terminal state remains `partial/interrupted` and no effect is replayed.
12. P2.7 is a measurement decision: profile the real packaged renderer first; patch only a reproduced material RED and otherwise record a verified no-change outcome.
13. P2.8 is explicit opt-in. Default `kickstartAgent` remains an honest no-op; `mode: "onboarding"` activates a deduplicated hidden turn only after readiness succeeds.

## Execution status — P2.8 and P2 exit audit accepted on 25/08/2026

| Task | Current state | Evidence | Resume condition |
|---|---|---|---|
| P2.1 | Complete | Focused matrix 51/51; integrated regression 487/487; typecheck, build and all final gates GREEN; closed specification and quality/security reviews PASS | Accepted; preserve its regression guards |
| P2.2 | Complete | Focused matrix 10 files / 326/326 (P2.2 native contract 11/11 incl. real-Electron gate); real Electron gate GREEN with screenshots; typecheck, build, provenance, renderer-boundary, client-artifacts and visual artifacts-only PASS; closed spec and quality/security reviews PASS | Accepted; preserve its regression guards |
| P2.3 | Complete | Focused matrix 3 files / 33/33; real Electron gate 18/18 steps and 5 screenshots; staging/find/reply UI exercised through the packaged renderer; typecheck, build and artifact gates GREEN | Accepted; preserve backend authority and opaque attachment IDs |
| P2.4 | Complete | Reasoning 6/6, reactions 5/5 and audit-ob 13/13; typecheck/build and artifact gates GREEN; no real provider or raw reasoning persistence | Accepted; reasoning remains hidden unless an adapter declares and emits it |
| P2.5 | Complete | RED contract 25/25; supplement 13/13; focused matrix 15 files / 219/219; capability matrix fail-closed e default-off; adapters OpenRouter/Codex/Claude integrados ao broker; typecheck, build, provenance, renderer-boundary, client-artifacts e visual artifacts-only PASS; revisões fechadas PASS | Accepted; preserve its regression guards; capability matrix é autoridade para imagens na P2.3 |
| P2.6 | Complete | Offline cursor fixture; durable scoped checkpoint/CAS and effect ledger; expired/unsafe fail-closed guards; 8/8 focused tests plus gateway 13/13; typecheck/build GREEN | Accepted; real providers remain `resume:none` |
| P2.7 | Complete — measured no-change | Three real packaged-Electron runs GREEN / 15 snapshots: one observer active per overlay, callbacks p95/max 0.1 ms, scans p95/max 0.3/0.4 ms, zero long tasks, lag p95/max 14.1/33.4 ms, CPU 1.741%, heap +28,836 B, listeners 169 stable, timers 0 | Accepted without renderer/overlay modification; evidence `logs/electron-p27-profile-ycxqHH/p27-report.json` |
| P2.8 | Complete | 7/7 focused plus 130/130 roster/send/store/crash regressions; schema 13, readiness, dedupe, restart, hidden result, no external tools and delete/fence | Accepted; default no-op remains truthful and onboarding is explicit opt-in |

Checked implementation items below mean the behavior exists and passed the acceptance matrix for its own phase. P2 as a whole and its exit audit are closed by the evidence recorded below.

## Task 1 — P2.1 durable agent-to-agent messages

**Files:**

- Create `src/a2a/contracts.ts`
- Create `src/a2a/store.ts`
- Create `src/a2a/runtime.ts`
- Create `src/rpc/a2a.ts`
- Modify `src/store/schema.ts`
- Modify `src/rpc/index.ts`
- Modify `src/rpc/roster.ts`
- Modify `src/server/gateway.ts`
- Modify `src/shared/contracts.ts`
- Modify `src/main.ts`
- Create `test/a2a-contract.test.ts`
- Create `test/a2a-store.test.ts`
- Create `test/a2a-runtime.test.ts`
- Create `test/a2a-rpc.integration.test.ts`
- Create `test/a2a-gateway.integration.test.ts`

- [x] RED: invalid/missing/deleted/fenced recipient, self-send, conflicting nonce, oversize/invalid UTF-8/secret payload, cross-agent read/control, crash before wake, expired lease, duplicate ACK and delete/recreate identity reuse.
- [x] Define a versioned envelope with sender/recipient IDs and incarnations, nonce, parent task/turn lineage, normal/high A2A priority, hop count, bounded payload, timestamps, delivery status and ACK metadata.
- [x] Add schema v10 tables for agent incarnations, messages, delivery leases, parent-turn limits and an A2A-specific outbox. Persist message + limit accounting + outbox atomically before any wake.
- [x] Enforce hard caps in the store: 32 KiB UTF-8 payload, 64 KiB envelope, 4 hops, 32 messages/256 KiB/8 recipients per parent turn, 128 pending per recipient and 3 delivery attempts. Duplicate retries consume no new limit.
- [x] Reject self-send by default; verify configured active incarnations and both deletion fences in the same transaction. Retire incarnations and terminalize pending deliveries on committed deletion; rollback clears only the fence.
- [x] Implement lease/heartbeat/recovery/redelivery and idempotent CAS ACK. Boot scanning and periodic scanning recover a crash after commit but before physical wake.
- [x] Add a background lane where user work always has precedence. `high` orders A2A only; it never interrupts or jumps an active/queued user turn. Provider calls still pass through P1.1.
- [x] Add agent-scoped RPC and an `a2a` SSE projection with epoch/sequence, bounded frames, SQLite snapshot/resync and no cross-agent disclosure. SSE receipt does not ACK the message.
- [x] GREEN: contract/store/runtime/RPC/gateway/delete-recreate/restart/loop tests, core acceptance, typecheck and build.

Acceptance evidence: the current five-file P2.1 matrix passed 51/51 and the complete 16-file integrated regression passed 487/487. Typecheck, build, provenance, renderer-boundary, client-artifacts and visual artifacts-only gates passed; the immutable renderer aggregate remained unchanged. The serial implemented-scope run (explicitly excluding the four future RED files) produced 1,948 passed, 2 skipped and 2 Windows ACL bootstrap failures in `execution-home`; the required isolated reproduction then passed 24/24, classifying the incident as the known nondeterministic Windows temp/ACL failure rather than a P2.1 regression. Both closed reviews ended in PASS. P2.2 production remains untouched and is the next phase.

## Task 2 — P2.2 async-task and subagent product surface

**Files:**

- Modify `src/rpc/tasks.ts`
- Modify `src/tasks/store.ts`
- Modify `src/server/gateway.ts`
- Modify `src/shared/contracts.ts`
- Modify allowlisted preload/overlay assets only as required
- Modify `client/client-artifacts.manifest.json`
- Modify `patches/client-artifacts.json`
- Create or extend task projection/UI tests
- Extend real Electron/visual verification scripts

- [x] RED: native renderer requests `{id}` while backend requires `{agentId}`; native `tasks/subagents` shape differs from the durable envelope; reconnect/resync, cross-agent isolation and controls must be proven.
- [x] Accept the narrow legacy `id` alias only on task/subagent reads and normalize to validated `agentId`; mutating RPC remains explicitly scoped. Implemented in `src/rpc/tasks.ts` (`scopedReadAgent` for `getAsyncTasks`/`getSubagents`/`listAsyncTasks` only; mutations keep `agentId`).
- [x] Add a sanitized native-view projection containing task ID, kind, label/status, duration (derived from `startedAtMs`), attempt (when > 1), progress, bounded error/result and permitted actions while retaining the durable epoch/sequence envelope. First-party adapter `src/tasks/projection.ts`; allowlist types moved to `src/shared/contracts.ts`; recursive caps (label 512B, detail/progress.summary/error.message/result.text 4KiB, phase 256B, ref 2KiB).
- [x] Use one initial RPC plus existing SSE snapshots/updates/resync; no interval polling. Missing/stale cursors replace state from SQLite and do not append duplicates. `src/tasks/client-state.ts` + overlay `applyTaskFrame`; runtime enriches durable outbox events with native items; gateway emits one combined native snapshot frame (`tasks`/`subagents` keys, `parentAgentId` preserved).
- [x] Expose details, abort and steer only through the typed allowlisted bridge. Terminal or foreign tasks cannot be controlled; malformed progress/result cannot inject DOM. `window.desktop.tasks` in preload → `sand:async-task-*` IPC in main with trusted-sender + active-agent guards, allowlisted RPC methods and sanitizers; the overlay renders every dynamic field through `escapeText` (XSS pwned checks GREEN in the Electron gate).
- [x] Implement loading, empty, error, retry, reconnect and resync states; Escape/focus restoration/pagehide teardown remove stream, listeners, timers and AbortControllers. Tasks dialog in `openbot-memory-ui.js`; cleanup closes the stream and unsubscribes frames; no `setInterval`; the Electron gate verifies Escape/focus, pagehide teardown, single active stream after reopen.
- [x] Validate the packaged Electron renderer through real interaction and DOM/screenshot evidence for the states in scope. `scripts/electron-p22-tasks-verify.mjs` boots the real Electron via CDP, drives the production overlay, records `logs/electron-p22-verify-*/p22-evidence.json` (all steps PASS, `pollCalls: 0`, abort/steer recorded) and captures `p22-tasks-empty.png`, `p22-tasks-mixed.png`, `p22-tasks-resync.png`. The P2.2 RED `it.todo` was converted into a real test that executes this gate and validates the evidence.
- [x] GREEN: RPC/SSE/reconnect/bridge/lifecycle/Electron tests, renderer/client/visual gates, typecheck and build. Focused matrix 10 files / 326/326; renderer-boundary aggregate immutable; client-artifacts 12 checks; provenance ok; visual `--artifacts-only` GREEN; typecheck/build PASS. Residual environment limitations recorded (release-lifecycle/windows-artifact-gate PowerShell issues, reproduced in isolation).

## Task 3 — P2.3 multimodal staging, transcript search, reply and history

**Files:**

- Modify `src/rpc/attachments.ts`
- Modify `src/rpc/send.ts`
- Modify `src/store/index.ts`
- Modify `src/memory/sqlite-store.ts`
- Modify `src/shared/contracts.ts`
- Modify allowlisted preload/overlay assets only as required
- Add attachment/search/reply/pagination tests and Electron fixtures

- [x] RED: outside-root/symlink/mime-extension mismatch, staged expiry, aggregate caps, image sent to a non-vision provider, cross-agent/conversation reply, FTS leak, page duplication and abandoned staging.
- [x] Reuse the existing staging bridge and represent renderer selections only by opaque attachment IDs. Support bounded text/PDF/image staging, SHA-256 metadata, expiry and cleanup; never persist attachment bytes in localStorage (server-side staging authority src/attachments/staging.ts, SQLite attachment_staging in schema v11).
- [x] Revalidate root, real path, type, size and aggregate count/bytes at commit/send. Removing, cancelling, pressing Escape or tearing down discards uncommitted staging.
- [x] Gate images through the P2.5 provider/model capability matrix. Unsupported images become an explicit safe marker/failure rather than silent incompatible wire data (providerSupportsImages -> unsupported_feature before the provider call).
- [x] Add agent/conversation-scoped searchTranscript, limited snippets and a cursor/page locator backed by current SQLite FTS; incremental history remains authoritative and duplicate-free (src/memory/sqlite-store.ts).
- [x] Replace replyContext: unknown with a closed {replyToId, conversationId} contract. Resolve the persisted entry server-side and reject missing, temporary, foreign-agent or foreign-conversation targets; quoted client text is display-only.
- [x] Implement drop, paste, preview, removal, find, navigation and reply in an allowlisted overlay/native seam with XSS-safe text rendering and complete lifecycle cleanup.
- [x] GREEN: staging/security/caps/context/search/reply/pagination tests plus real Electron drop/paste/search/reply evidence, artifact gates, typecheck and build.


Final P2.3 acceptance evidence: `test/p23-attachment-staging.test.ts`, `test/p23-reply-search-history.test.ts` and `test/p23-electron-gate.test.ts` pass together at 33/33. The real-Electron gate boots the packaged renderer and records `logs/electron-p23-verify-*/p23-evidence.json` with 18/18 verified steps and five screenshots. It exercises the allowlisted UI for staging, drop/paste, preview/removal, opaque attachment send, transcript search/navigation, server-authoritative reply, Escape and pagehide cleanup. Typecheck/build PASS; provenance ok; renderer-boundary aggregate `8be890dd…` unchanged; client-artifacts 12 checks and visual artifacts-only GREEN. P2.3 is accepted.

## Task 4 — P2.4 real reasoning events and durable reactions

**Files:**

- Modify `src/providers/router.ts`
- Modify `src/rpc/send.ts`
- Modify `src/rpc/roster.ts`
- Modify `src/store/schema.ts`
- Modify `src/server/gateway.ts`
- Modify `src/shared/contracts.ts`
- Modify allowlisted overlay only when a real emitting adapter is enabled
- Add reasoning-order/privacy and reaction store/RPC/SSE tests

- [x] RED: synthetic reasoning, invalid reasoning/tool/delta/final order, open reasoning after abort/error, private content persistence, duplicate/foreign reactions and optimistic failure without rollback.
- [x] Add optional canonical `reasoning-start/progress/end` events to adapters/capabilities. Providers without the declared capability cannot emit them; the core never infers reasoning from busy/time/loading state.
- [x] Enforce lifecycle ordering with tools/deltas/final and terminalize an open reasoning state on abort/error. Publish only bounded sanitized summaries; raw private reasoning is neither transcript nor default SQLite data.
- [x] Replace the `reactToMessage` stub with durable agent/conversation/entry-scoped reactions, nonce dedupe, confirmed/rejected state, remove/list RPC and ordered SSE projection.
- [x] Optimistic UI is allowed only with server confirmation and deterministic rollback; reconnect dedupes by stable reaction identity.
- [x] GREEN: offline real-event fixture, ordering/privacy/abort/reaction/reconnect tests, provider regressions, artifact gates, typecheck and build. No production adapter currently declares reasoning, so the UI remains hidden.

P2.4 acceptance evidence: `test/p24-reasoning.test.ts` 6/6, `test/p24-reactions.test.ts` 5/5 and `test/audit-ob.test.ts` 13/13 GREEN. The old inert `reactToMessage` stub was retired; missing and foreign targets fail closed, ordered SSE and nonce dedupe are covered, and reasoning summaries are bounded, capability-gated and never persisted. Typecheck/build and all artifact gates PASS without a real provider call.

## Task 5 — P2.5 optional OpenRouter, Codex CLI and Claude Code adapters

**Files:**

- Create `src/providers/capabilities.ts`
- Create optional adapters and offline protocol parsers/fixtures
- Modify `src/providers/router.ts`
- Modify `src/providers/request-bodies.ts`
- Modify `src/config/models.ts`
- Modify `src/config/store.ts`
- Modify `src/main.ts`
- Add provider capability and fixture tests

- [x] RED: unregistered-by-default adapters, unsupported feature use, missing external session, cancellation, auth/rate/network errors, usage absent, secret leakage and global-admission bypass.
- [x] Add a capability matrix for streaming, tools, images, cancellation mode, authentication mode, usage and resume. Unknown/missing capabilities fail closed. Implemented in `src/providers/capabilities.ts` (`resolveProviderCapabilities`, `providerSupportsImages`, `registerOptionalProviders`); resume declared only as `none`.
- [x] Implement OpenRouter as an optional OpenAI-compatible specialization with its own explicit headers (`HTTP-Referer`, `X-Title`), error/usage contract (`stream_options.include_usage`, strict SSE, `[DONE]`), reusing the shared serializer (`providerRequestBody`), the P1.3 byte gate (`prepareProviderRound`) and admission (router, per retry). Credential opaque (`credentialRef` + `resolveCredential`) resolved at call time only.
- [x] Implement Codex CLI and Claude Code as optional bounded adapters through the existing execution broker (operation `process.run`, `networkProfile: "none"`, validated cwd, timeout), never permanent per-agent workers; no direct spawn, no login automation, no env-token reads (`CODEX_AUTH_TOKEN` never read), session opaque and agent-scoped (`sessionRef` + `resolveSession`).
- [x] Parse only documented/fixture-covered line protocols (`codex-cli.v1`/`claude-code.v1` with strict sequence/protocol/type/field/order/size validation); cap stdout/stderr/event bytes, sanitize errors, propagate AbortSignal and terminate the owned process tree on cancellation/shutdown via the broker; `close()` aborts in-flight executions.
- [x] Keep credentials/session authority as opaque references (config stores only refs). Offline fixtures cover stream, tools, cancellation, auth/rate/network errors and usage; no real paid call in tests.
- [x] Route every adapter round/retry through P1.1 admission (reacquired per attempt) and every wire request through P1.3. Providers currently configured continue to behave unchanged (171 existing provider/config tests GREEN).
- [x] GREEN: capability/adapter/router/context/keystore/admission tests, typecheck and build. RED contract 25/25; supplement 13/13; focused matrix 15 files / 219/219. The earlier 2,006/2-skipped/4-environment-limited serial result is a pre-exit snapshot; the final exit suite is recorded below.

## Task 6 — P2.6 checkpoint/resume at idempotent boundaries

**Files:**

- Create `src/providers/resume.ts`
- Modify `src/providers/router.ts`
- Modify `src/execution/tool-loop.ts`
- Modify `src/execution/tools.ts`
- Modify `src/rpc/send.ts`
- Modify `src/store/schema.ts`
- Modify `src/store/index.ts`
- Add resume/restart/idempotency tests

- [x] RED/GREEN: provider without capability, bounded/invalid cursor, checkpoint scope/CAS, crash after effect start, duplicate effect identity, completed outcome reuse, abort/resume and assistant transcript exactness.
- [x] Persist a bounded checkpoint only when an adapter declares real cursor resume and the transcript boundary is durable. Store provider/model/cursor, safe transcript sequence, completed effect IDs, expiry and version; never write one checkpoint per delta.
- [x] Give every resumable tool/effect an idempotency key derived from stable turn/tool identity and persist outcome before advancing the safe checkpoint. Completed effects return the existing result and are never repeated.
- [x] Resume consumes the original turn identity, budget and admission path. Missing/expired/foreign/unsafe/invalid resume state fails closed; it never falls back to replay.
- [x] Reconcile crash windows with CAS so transcript, checkpoint and effect ledger cannot independently claim conflicting progress.
- [x] GREEN: offline fixture cursor semantics, expired/unsafe fail-closed guards, crash/unsafe effect, CAS, reuse and resume transcript exactness 8/8; gateway regression 13/13; typecheck and build GREEN. Production capability pairs remain `resume:none`.

## Task 7 — P2.7 measured renderer lifecycle decision

**Files:**

- Extend real Electron profiling/verification scripts and evidence
- Modify `openbot-local-settings.js` only if the baseline is materially RED
- Update allowlist manifests only if an evidence-backed overlay patch is made

- [x] Instrument the packaged renderer without modifying proprietary chunks: MutationObserver callback count/time, scan count/time, long tasks/event-loop lag, listener/timer lifecycle, navigation/streaming memory and CPU.
- [x] Reproduce a representative mutation/navigation/stream workload in real Electron and record a deterministic threshold plus baseline evidence.
- [x] If no material RED exists, make no UI code change and record the measured no-change decision as completion of the conditional recommendation.
- [x] If RED exists, apply the smallest overlay-only fix (for example one-RAF coalescing or scoped scans), preserve a single observer and teardown, then record comparable before/after evidence — **N/A**: measured baseline was GREEN, so no UI code changed.
- [x] Never copy a React `useEffect` pattern into the proprietary bundle; StrictMode tests apply only to future first-party React source.
- [x] GREEN: three real Electron runs and 15 measured snapshots; all required metrics PASS; 5/5 lifecycle contract tests; screenshots retained; immutable renderer unchanged. Measurements: observer 1 active/overlay, callbacks p95/max 0.1 ms, scans p95/max 0.3/0.4 ms, zero long tasks, lag p95/max 14.1/33.4 ms, CPU 1.741%, heap +28,836 B, listeners 169 stable and timers 0.

## Task 8 — P2.8 explicit opt-in kickstart

**Files:**

- Modify `src/rpc/roster.ts`
- Modify `src/rpc/send.ts`
- Modify `src/store/schema.ts`
- Modify `src/store/index.ts`
- Modify `src/shared/contracts.ts`
- Add kickstart readiness/dedupe/restart tests

- [x] RED: default unexpectedly calls a provider, missing readiness, concurrent duplicate, restart duplication, delete/fence race, retry after output and hidden transcript leaking into the visual tail.
- [x] Preserve the zero-argument/default honest no-op. Require explicit `{agentId, clientNonce, mode:"onboarding"}`; the internal versioned prompt is not caller-controlled.
- [x] Validate agent/provider/credential/home/runtime readiness before claiming work. Serialize with user turns and route provider use through admission/context gates; tools with external effects are disabled.
- [x] Persist a hidden origin/version/nonce/attempt, dedupe concurrent calls and restarts, and retry only before observable output. Partial output ends interrupted and is never replayed.
- [x] Keep hidden entries out of the normal transcript tail while retaining an auditable bounded operational result. Deletion/fence cancels pending kickstart deterministically.
- [x] GREEN: 7/7 focused; 130/130 roster/send/store/crash regressions; schema 13, readiness/dedupe/restart/hidden/no-tools/delete-fence coverage; typecheck and build.

## P2 exit audit

- [x] Re-run all focused P2 suites together: 452/452 after updating the legacy schema-v13 test and fixture coherence; the final P2.6 fail-closed addition was then revalidated on the changed surface in 48/48 (`p26-resume` 8/8, store 27/27, gateway 13/13).
- [x] Re-run P0/P1 core acceptance, provider, transcript, task, gateway/SSE, roster deletion and crash-recovery regressions: P0/P1 batches 330/330 and 152/152, core 3/3, chat resilience 165/165.
- [x] Run the full serial suite: 158 files, 2,076 passed, 2 skipped, 0 failed before the final isolated P2.6 guard; that guard subsequently passed its 48/48 changed-surface matrix, typecheck/build and regenerated package gates.
- [x] Run benchmark, provenance, renderer/client/visual, Windows artifact, typecheck, build, package, preflight and hermetic smoke gates: benchmark `ok`, provenance `true`, renderer aggregate `8be890dd0e54aa5b31fb2821b08c89dcc3bba6a6faa28c11de8ea613089d460d` unchanged, client-artifacts 12 checks, visual artifacts-only GREEN, package `OpenBot-0.1.0-win32-x64`, Windows directory+ZIP+sidecar+clean-root GREEN, packaged preflight and local smoke GREEN.
- [x] Run real Electron checks for every visual claim and retain sanitized evidence: P2.2 24/24 steps plus three screenshots, P2.3 18/18 steps plus five screenshots, P2.7 three runs / 15 snapshots plus screenshots at `logs/electron-p27-profile-ycxqHH/p27-report.json`.
- [x] Audit P2.1–P2.8 requirement by requirement, then run separate specification and quality/security reviews: all P2 stages accepted; no paid provider, login or token used.
- [x] Update the execution roadmap with exact RED/GREEN/regression evidence and residual limitations. Residuals: `unsigned-local` proves SHA-256 integrity, not authenticity; production capability pairs remain `resume:none`; historical `// @ts-nocheck` remains in `src/rpc/send.ts`; P2.7 made no UI change.
