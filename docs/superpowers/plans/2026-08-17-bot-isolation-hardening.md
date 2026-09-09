# Bot Isolation Hardening Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Fortalecer o isolamento entre bots sem criar runtimes permanentes ou VMs por bot.

**Architecture:** A quota será aplicada no backend WSL usando a mesma autoridade de quota do workspace; o browser host receberá ambiente mínimo; o MCP terá cache/session key configurável por agente; a documentação consolidará o trust model. Todas as mudanças preservam defaults compatíveis.

**Tech Stack:** TypeScript, Node.js, Electron, MCP SDK, Vitest, WSL2/Rust guest supervisor.

---

### Task 1: Runtime workspace quota guard

**Files:**
- Modify: `src/execution/quota.ts`
- Modify: `src/execution/home-backend.ts`
- Modify: `src/execution/runtime/agent-backend.ts`
- Modify: `src/execution/runtime/wsl/process-backend.ts`
- Test: `test/runtime-process-backend.test.ts`
- Test: `test/execution-quota.test.ts`

- [ ] Add a failing test proving an over-quota workspace prevents runner invocation.
- [ ] Add a failing test proving quota excess during execution aborts the runner and returns `quota_exceeded`.
- [ ] Add a serialized `assertWithinQuota()` operation to `WorkspaceQuota`.
- [ ] Share the workspace quota instance with file and process backends.
- [ ] Add bounded polling plus final verification to `WslProcessBackend`; distinguish quota excess from inventory failure.
- [ ] Run the two focused test files and keep them green.

### Task 2: Minimal browser host environment

**Files:**
- Modify: `src/browser/browser-session-manager.ts`
- Test: `test/browser-manager.test.ts`

- [ ] Add a failing test with fake `OPENAI_API_KEY`, token and unrelated values.
- [ ] Introduce a deterministic environment builder with a Windows operational allowlist.
- [ ] Prove required `OPENBOT_BROWSER_*` values remain present and secret-like parent variables are absent.
- [ ] Run browser manager and browser security tests.

### Task 3: MCP per-agent session scope

**Files:**
- Modify: `src/mcp/contracts.ts`
- Modify: `src/mcp/security.ts`
- Modify: `src/mcp/manager.ts`
- Modify: `src/config/store.ts`
- Modify: `src/rpc/mcp.ts`
- Test: `test/mcp-manager.test.ts`
- Test: `test/config-store.test.ts`
- Test: `test/rpc-mcp.test.ts`

- [ ] Add a failing manager test proving `agent` scope creates one session per bot while `shared` remains deduplicated.
- [ ] Add a failing cleanup test proving removal of one bot closes only its scoped session/cache.
- [ ] Add the strict `sessionScope` contract and configuration validation.
- [ ] Key MCP sessions and tool metadata by scope, server and agent; invalidate by server safely.
- [ ] Persist and expose the scope in the safe RPC view.
- [ ] Run manager, config and RPC tests.

### Task 4: Security trust model

**Files:**
- Create: `SECURITY.md`
- Modify: `README.md`
- Modify: `docs/shared-skills-mcp-chat.md`
- Modify: `docs/verification-gates.md`

- [ ] Write the threat model, boundaries, shared components, residual risks and safe configuration choices.
- [ ] Link it from the README and align MCP/quota documentation.
- [ ] Cold-read the document for unsupported claims and broken relative links.

### Task 5: Verification

**Files:**
- Modify only if a verified test or documentation mismatch requires it.

- [ ] Run focused runtime, browser, MCP and config tests serially.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run the complete Vitest suite serially.
- [ ] Run WSL live verification, Electron/browser E2E as relevant, and shortcut smoke.
- [ ] Report exact totals, environmental skips and residual limitations.
