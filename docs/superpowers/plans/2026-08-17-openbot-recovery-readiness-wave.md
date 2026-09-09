# OpenBot Recovery Readiness Wave Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Add real SQLite recovery proof, a safe local Recovery Center CLI, continuously bounded/redacted gateway logs, and an optional live LM Studio/Ollama qualification gate.

**Architecture:** Keep the existing local Windows release pipeline authoritative. Extend `scripts/update.mjs` with read-only backup verification, expose those primitives through a CLI that refuses unsafe restore, install a small TypeScript logger only when `OPENBOT_LOG_DIR` is set, and keep local-provider validation opt-in with no network outside loopback.

**Tech Stack:** Node.js 22+, TypeScript, PowerShell 5.1, Vitest, better-sqlite3, Electron, Windows loopback.

---

### Task 1: Real data recovery gate

**Files:**
- Modify: `scripts/update.mjs`
- Create: `test/data-recovery-live.test.ts`
- Modify: `package.json`

- [ ] Write a failing test that creates a real WAL-mode `better-sqlite3` database, config, encrypted-looking credential files, and a workspace; backs them up; mutates them; restores them; then proves `PRAGMA integrity_check`, rows, and files match the original.
- [ ] Add a failing checksum-tamper case that proves verification rejects a changed backup before touching destinations.
- [ ] Export `verifyDataBackup(backupPath)` from `scripts/update.mjs`; it must validate schema/product, supported entries, presence, and each SHA-256 without restoring.
- [ ] Add `verify:data-recovery` running only the focused test serially.
- [ ] Run `npm run verify:data-recovery`; expected: the new test file passes with no real AppData access.

### Task 2: Recovery Center CLI

**Files:**
- Create: `scripts/recovery-center.mjs`
- Create: `test/recovery-center.test.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] Write failing CLI tests for `status`, `backup`, `verify-backup`, `restore --yes`, missing confirmation, active gateway refusal, and redacted diagnostics.
- [ ] Implement `status` as read-only JSON containing managed-install identity, active/previous version, data roots, last backup/failure, gateway state, and process-state presence; never include credential contents.
- [ ] Implement `backup` and `restore`: require managed state and a stopped gateway; restore must require `--yes`, verify the selected backup, and create a pre-restore backup before mutation.
- [ ] Implement `diagnostics --output <file>` as a bounded JSON support bundle with status and sanitized log tails only.
- [ ] Add `recovery:status`, `recovery:backup`, `recovery:verify`, `recovery:restore`, and `recovery:diagnostics` scripts.
- [ ] Run focused tests; expected: every command is hermetic under `%TEMP%`.

### Task 3: Continuous bounded/redacted gateway logs

**Files:**
- Create: `src/local-logger.ts`
- Create: `test/local-logger.test.ts`
- Modify: `src/main.ts`
- Modify: `scripts/start-gateway.mjs`
- Modify: `scripts/launch.mjs`

- [ ] Write a failing test that emits enough content to cross a small limit and proves rotation occurs during the same process, retention stays bounded, and bearer/token/API-key-shaped values are redacted.
- [ ] Implement `installLocalFileLoggerFromEnvironment()` with synchronous short writes, rotation before an overflowing append, two backups by default, and recursion protection.
- [ ] Install it at gateway bootstrap only when `OPENBOT_LOG_DIR` is explicitly set.
- [ ] Set `OPENBOT_LOG_DIR` in both desktop launch paths and stop redirecting gateway stdout/stderr to long-lived files; retain spawn errors and readiness messages in the launcher path.
- [ ] Run logger, lifecycle, and launcher tests; expected: continuous cap and startup diagnostics both remain proven.

### Task 4: Optional live local-provider gate

**Files:**
- Create: `scripts/verify-local-provider-live.mjs`
- Create: `test/local-provider-live-script.test.ts`
- Modify: `package.json`
- Modify: `docs/verification-gates.md`

- [ ] Write a failing script-contract test proving only `127.0.0.1` LM Studio/Ollama endpoints are probed, secrets are not printed, and absence is `SKIP` unless `OPENBOT_REQUIRE_LOCAL_PROVIDER=1`.
- [ ] Implement the gate using `probeLocalEndpoints`; for reachable endpoints require at least one model and run `testCompatConnection` with a bounded timeout.
- [ ] Emit one JSON result: `GREEN`, `SKIP`, or `RED`; never enumerate environment values or credentials.
- [ ] Add `verify:local-provider-live` and document optional/required modes.
- [ ] Run the contract test. Run the live gate on this host and report `GREEN` or factual `SKIP`.

### Task 5: Final verification

**Files:**
- Modify only if a verified failure requires a scoped correction.

- [ ] Run `npm run verify:data-recovery`.
- [ ] Run Recovery Center focused tests and logger/provider focused tests.
- [ ] Run `npm run typecheck` and `npm run build`.
- [ ] Run `npm test -- --maxWorkers=1 --no-file-parallelism`.
- [ ] Run `npm run verify:client-artifacts`, `npm run verify:skills-mcp`, and `npm run smoke:shortcut`.
- [ ] Confirm port 1340 is free, no owned process remains, and no real user data path was changed.

## Scope boundaries

- Do not add auto-update, telemetry, VM isolation, signing, commercial installer work, or remote services.
- Do not restore into real user data during tests.
- Do not print or copy secret values into logs, diagnostics, tests, or documentation.
- Do not change WSL runtime contracts unless a new focused test proves it is required.
