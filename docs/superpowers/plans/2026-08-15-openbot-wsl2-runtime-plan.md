# OpenBot WSL2 Runtime Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Add a shared, on-demand WSL2 runtime foundation and a fail-closed process sandbox adapter while preserving the existing Lite workspace path.

**Architecture:** Keep `ExecutionBackend` and `LocalExecutionBroker` as the model-facing seams. Add a host-side `AgentRuntimeManager` with a real state machine, leases, authenticated protocol contracts, and a WSL adapter boundary; keep guest supervisor code isolated behind that protocol. The first implementation provides a safe process contract and a capability-gated backend, while installer/transport integration fails closed when WSL2 is unavailable rather than touching an unrelated distro.

**Tech Stack:** TypeScript 5.8, Node.js 20+, Vitest, existing OpenBot gateway/RPC/execution modules, Windows WSL2 command boundary.

---

## Task 1: Add runtime contracts and strict process request parsing

**Files:**
- Modify: `src/execution/contracts.ts`
- Modify: `src/execution/tool-request.ts`
- Test: `test/execution-contracts.test.ts`
- Create: `test/execution-tool-request.test.ts`

- [ ] **Step 1: Write failing tests** for `process.run` exact-field parsing, relative `cwd`, `argv` arrays, finite timeout/network `none`, and rejection of shell strings, Windows executables, unknown fields, excessive arguments, and non-`none` network profiles.
- [ ] **Step 2: Run focused tests** with `npm test -- test/execution-contracts.test.ts test/execution-tool-request.test.ts` and verify the new expectations fail because `process.run` is not yet a supported discriminated union.
- [ ] **Step 3: Implement minimal contracts**: add `process.run`, stable runtime error codes, bounded constants, and strict parser logic without changing existing file/search semantics.
- [ ] **Step 4: Implement tool translation** for the exact provider tool name `process_run`, rejecting arbitrary shell tools and mapping invalid JSON to `invalid_request`.
- [ ] **Step 5: Run focused tests** and then `npm run build`.

## Task 2: Implement runtime state machine, leases, and scheduler

**Files:**
- Create: `src/execution/runtime/contracts.ts`
- Create: `src/execution/runtime/manager.ts`
- Create: `src/execution/runtime/scheduler.ts`
- Create: `src/execution/runtime/policy.ts`
- Test: `test/runtime-manager.test.ts`
- Test: `test/runtime-policy.test.ts`

- [ ] **Step 1: Write failing tests** for valid/invalid state transitions, concurrent `ensure` single-flight, lease binding to one agent and boot id, expiration, release, stop fencing, and close aborting active leases.
- [ ] **Step 2: Run the focused runtime tests** and verify they fail because the runtime modules do not exist.
- [ ] **Step 3: Implement the contracts** for `RuntimeMode`, `RuntimeState`, `RuntimeCapability`, `RuntimeStatus`, `RuntimeLease`, `StopReason`, and sanitized runtime errors.
- [ ] **Step 4: Implement the manager** with explicit transitions, per-agent fences, single-flight startup, no cross-agent lease reuse, and fail-closed unsupported capabilities.
- [ ] **Step 5: Implement the scheduler** with finite limits, idle detection, and teardown callbacks; do not spawn processes yet.
- [ ] **Step 6: Run focused tests, typecheck, and full tests**.

## Task 3: Add WSL adapter, managed-root validation, and authenticated transport boundary

**Files:**
- Create: `src/execution/runtime/wsl/adapter.ts`
- Create: `src/execution/runtime/wsl/transport.ts`
- Create: `src/execution/runtime/wsl/installer.ts`
- Create: `src/execution/runtime/wsl/health.ts`
- Test: `test/runtime-wsl.test.ts`

- [ ] **Step 1: Write failing tests** proving the adapter rejects personal distro names, paths outside an injected runtime root, non-loopback listeners, malformed frames, stale boot ids, replayed nonces, mismatched agent ids, and oversized frames.
- [ ] **Step 2: Run focused WSL tests** and verify they fail before adapter modules exist.
- [ ] **Step 3: Implement managed-root and distro identity validation** using injected filesystem/command dependencies; production commands remain behind the adapter and tests never call the user's real distro.
- [ ] **Step 4: Implement strict protocol framing and authentication** with version, boot id, lease id, agent id, nonce, deadline, policy digest, exact fields, max frame size, and sanitized errors.
- [ ] **Step 5: Implement health probes and a WSL availability result** that reports `runtime-unavailable` without throwing the Lite path offline.
- [ ] **Step 6: Run focused tests and `npm run build`.

## Task 4: Implement process sandbox backend boundary with fail-closed execution

**Files:**
- Create: `src/execution/runtime/wsl/process-backend.ts`
- Modify: `src/execution/runtime/contracts.ts`
- Test: `test/runtime-process-backend.test.ts`

- [ ] **Step 1: Write failing tests** for process capability approval, bounded output, timeout/cancel propagation, agent/lease binding, network profile rejection, and sanitized failure when WSL is unavailable.
- [ ] **Step 2: Run the focused tests** and verify failure before the backend exists.
- [ ] **Step 3: Implement the backend** against the transport/lease interfaces only; it must never accept a shell command, inherit host environment, or expose internal paths.
- [ ] **Step 4: Ensure timeout and abort call lease teardown and return stable `process_timeout`/`process_aborted` results.
- [ ] **Step 5: Run focused tests and full typecheck.

## Task 5: Integrate runtime manager with broker, roster deletion, and versioned status RPC

**Files:**
- Modify: `src/main.ts`
- Modify: `src/rpc/index.ts`
- Modify: `src/rpc/roster.ts`
- Modify: `src/execution/broker.ts`
- Modify: `src/server/gateway.ts` to add the explicit `getLocalRuntimeStatus` method
- Create: `test/runtime-integration.test.ts`
- Modify: `test/roster-agents.test.ts`

- [ ] **Step 1: Write failing integration tests** for Lite fallback, factual `getLocalRuntimeStatus`, runtime stop before `deleteAgents` removes a home, and no runtime process on `createAgent`.
- [ ] **Step 2: Run focused integration tests** and confirm they fail with the current hard-coded ForeverBox status and deletion flow.
- [ ] **Step 3: Inject an `AgentRuntimeManager` into `startServer`/RPC registration** without changing existing test injection behavior.
- [ ] **Step 4: Add versioned local runtime status while preserving the legacy ForeverBox shape.
- [ ] **Step 5: Fence and stop the runtime before transcript/home deletion; preserve existing runner abort behavior.
- [ ] **Step 6: Expose `process.run` only when the selected capability/policy allows it; keep Lite tools unchanged by default.
- [ ] **Step 7: Run focused tests, full tests, and build.

## Task 6: Add crash recovery, teardown inspection, and adversarial acceptance tests

**Files:**
- Modify: `src/execution/runtime/manager.ts`
- Modify: `src/execution/runtime/wsl/health.ts`
- Create: `test/runtime-recovery.test.ts`
- Create: `test/runtime-adversarial.test.ts`
- Modify: `docs/phase-2-local-execution-progress.md`

- [ ] **Step 1: Write failing recovery tests** for orphan lease records, stale runtime boot ids, partial teardown, shutdown during process execution, and repeated failure entering `repair-required`.
- [ ] **Step 2: Implement journal reconciliation and conservative cleanup** keyed by runtime/lease ids; never delete valid agent workspace content.
- [ ] **Step 3: Add adversarial contract tests** for cross-agent access, host path access, shell/interop names, oversized frames, replay, cancellation and residual processes/mounts through injected probes.
- [ ] **Step 4: Run the complete test suite and build.
- [ ] **Step 5: Update the progress document with only verified behavior and explicit WSL/guest limitations.

## Verification checklist

Run from `openbot/` after every task group:

```bash
npm run build
npm test
```

Before declaring the slice complete, also run the focused runtime suite and verify:

- Lite tests pass without WSL2;
- no test resolves to real AppData or a personal distro;
- runtime status never reports ready without handshake/health;
- two agent ids cannot share a lease or workspace;
- shell/interop/network are rejected;
- cancel/timeout/delete teardown is awaited;
- full output has zero failing tests.
