# OpenBot Turn Crash Recovery Design

## Objective

Recover every accepted chat turn after a backend crash without silently completing partial output, losing a retry, duplicating a prompt or targeting the wrong bot from the desktop controls.

## Decisions

- Add a small SQLite `turn_attempts` journal that contains only in-flight turns. Normal completion, cancellation and handled failure delete the row.
- A restart reconciles remaining attempts before serving traffic. Visible accepted attempts receive one recoverable interruption notice. Streaming assistant entries are marked `completionState: "interrupted"` and are excluded from later provider history.
- Retry attempts use the same journal. A crash after the retry marker therefore becomes a new recoverable failure instead of an idempotent no-op.
- Preserve legacy recovery for streaming/tool entries that predate the journal.
- Upgrade store ownership from PID-only to PID + process start time + executable path. Production resolves Windows process evidence synchronously only when stale owner rows exist; tests inject deterministic identities.
- Desktop prompt controls track busy state by agent. Switching bots never redirects cancellation or status polling to another agent.
- Add bounded deadlines to `cancelPrompt`, `retryPrompt` and `getPromptStatus`; a timeout re-enables controls and polling continues.

## Recovery Outcomes

- Crash before durable user/retry echo: nonce is released and no visible failure is created.
- Crash after durable echo but before provider output: one retryable restart notice is appended.
- Crash after partial output: partial is preserved visibly, marked interrupted, excluded from model history and paired with a retryable notice.
- Crash after completion/failure/cancellation: no open journal remains and no restart notice is added.

## Verification

- Store tests cover migration, PID reuse, user-only crash, partial crash, retry crash and legacy streaming entries.
- Turn-runner tests cover journal lifecycle and exclusion of interrupted history.
- Electron source-contract tests cover per-agent state and control deadlines.
- Isolated Electron E2E covers retry/cancel plus bot switching; restart/offline recovery uses disposable AppData and gateway state.
- Final gates: focused tests, typecheck, build, full serial suite, client artifact hashes, Electron E2E and shortcut smoke.

## Scope

No SSE replay service, distributed multi-process queue, automatic provider failover or commercial installer work.
