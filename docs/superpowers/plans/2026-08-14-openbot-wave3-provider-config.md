# OpenBot Wave 3 Provider and Config Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Correct provider timeout/retry behavior, share OpenAI-like transport, and remove heavyweight config/avatar work from streaming.

**Architecture:** Extract one transport with explicit timeout phases and pre-output retries. Add lightweight ConfigStore selectors/revision, capture immutable turn identity once, and migrate legacy avatars atomically.

**Tech Stack:** TypeScript ESM, Fetch/ReadableStream, Node.js fs/promises, Vitest.

**Specification:** `docs/superpowers/specs/2026-08-14-openbot-provider-config-optimization-design.md`

---

## File map

- Create `src/providers/openai-transport.ts` and `test/openai-transport.test.ts`.
- Modify `src/providers/openai.ts`, `src/providers/openai-compat.ts`, `src/providers/openai-helpers.ts`, `src/providers/router.ts`.
- Modify `src/config/store.ts`, `src/config/models.ts`, `src/rpc/send.ts`, `src/rpc/roster.ts`, `src/rpc/identity.ts`, `src/main.ts`; create `test/rpc-identity.test.ts`.
- Create `src/config/avatar-migration.ts` and `test/avatar-migration.test.ts`.

### Task 1: Model explicit provider timeout errors

- [ ] **Step 1: Write failing transport tests**

Create `test/openai-transport.test.ts` with injected fetch that waits for abort. Assert connect, idle, and total timeout errors each expose:

```ts
expect(error).toMatchObject({ code: "ETIMEDOUT", kind: "network", retryable: true });
```

Use fake timers or injected scheduler; no real 30-second waits.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/openai-transport.test.ts
```

Expected: module not found/current timeout is unknown.

- [ ] **Step 3: Implement timeout primitives**

Create `ProviderTimeoutError extends Error` with `code`, `phase`, and cause. Implement controller composition that distinguishes external abort from internal timeout. Clear every timer/listener in `finally`.

- [ ] **Step 4: Verify timeout tests GREEN**

```bash
npx vitest run test/openai-transport.test.ts
```

### Task 2: Implement retry only before observable output

- [ ] **Step 1: Add failing retry tests**

Cover 429, 500, network, `Retry-After`, permanent 400/auth, abort, and error after first delta. Inject `sleep` and `random` and assert exact attempt/delay counts.

Core test:

```ts
expect(attempts).toBe(3);
expect(sleeps).toEqual([250, 500]);
```

For a delta-then-error attempt, assert `attempts===1`.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/openai-transport.test.ts
```

- [ ] **Step 3: Implement attempt loop**

Add `maxRetries=2`, exponential jittered delay capped at 2,000 ms, and `Retry-After` capped at 10,000 ms. Track `emittedOutput` when delta/tool call is dispatched. Throw immediately if true.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/openai-transport.test.ts
```

### Task 3: Move shared SSE/HTTP behavior into the transport

- [ ] **Step 1: Add provider parity tests**

Extend `test/providers.test.ts` and `test/openai-compat.test.ts` so the same fixtures validate deltas, tool calls, malformed SSE, 1 MiB cap, `[DONE]`, timeout, and retry behavior.

- [ ] **Step 2: Verify current parity gaps RED**

```bash
npx vitest run test/providers.test.ts test/openai-compat.test.ts
```

- [ ] **Step 3: Implement shared request/stream API**

Move incremental frame parsing, error body extraction, fetch, timers, retries, reader cleanup, and tool accumulation to `openai-transport.ts`. Keep `buildChatBody` and provider-neutral message conversion in helpers.

- [ ] **Step 4: Reduce adapters to configuration**

`OpenAiAdapter.streamChat` resolves auth then calls transport with provider label and URL. `OpenAiCompatAdapter` does the same with optional auth. Delete duplicated private `readStream` methods.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run test/openai-transport.test.ts test/providers.test.ts test/openai-compat.test.ts test/xai.test.ts test/router.test.ts
```

- [ ] **Step 6: Record checkpoint**

Write `analysis_outputs/checkpoints/wave3-transport.txt`.

### Task 4: Add ConfigStore revision and lightweight selectors

- [ ] **Step 1: Write failing selector tests**

In `test/config-store.test.ts`, assert selectors return only requested copies, mutations do not affect internal state, and revision increments once per successful replace but not failed validation.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/config-store.test.ts
```

- [ ] **Step 3: Implement selectors**

Add `revision`, `getProfile`, `getAgent`, `getAgents`, `getHostSettings`, and `getInference`. Use targeted shallow copies; preserve `snapshot()`.

- [ ] **Step 4: Replace roster snapshot loops**

Use one `getAgents()` per handler/publish operation and capability helpers instead of `snapshot()` per agent.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run test/config-store.test.ts test/roster-agents.test.ts
```

### Task 5: Capture turn identity once and correct model parameters/prompt

- [ ] **Step 1: Write failing tests**

In `test/rpc-send.test.ts`, instrument ConfigStore `snapshot()` and assert zero calls per delta. Assert provider request includes capability-derived `maxTokens`. In `test/roster-agents.test.ts`, assert returned `parameters` does not advertise unsupported effort/fast. Create `test/rpc-identity.test.ts` and assert the system prompt contains only one `You are` identity and does not claim remote inference is local.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/rpc-send.test.ts test/roster-agents.test.ts test/rpc-identity.test.ts test/shared-contracts.test.ts
```

- [ ] **Step 3: Implement `TurnIdentity`**

At `runTurn` start, read profile/agent/inference/capability once. Pass identity into assistant/normalize helpers or store it in an active-turn map removed in `finally`. No delta path may call `snapshot()`.

- [ ] **Step 4: Apply real capabilities**

Set `request.maxTokens` from Wave 2 context result. Add capability fields additively to catalog responses. Return `parameters: []` unless a parameter is genuinely consumed.

- [ ] **Step 5: Rewrite system prompt composition**

Generate one persona sentence, same-language instruction, and optional home-tool paragraph. Remove contradictory identity/local-inference wording.

- [ ] **Step 6: Verify GREEN**

```bash
npx vitest run test/rpc-send.test.ts test/roster-agents.test.ts test/providers.test.ts
```

### Task 6: Migrate avatar base64 atomically

- [ ] **Step 1: Write failing migration tests**

Create `test/avatar-migration.test.ts` covering success, idempotence, malformed base64, write failure, and set/get avatar after migration. Assert config retains legacy data on failure and removes it only after file exists.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/avatar-migration.test.ts
```

- [ ] **Step 3: Implement atomic avatar writer and migration**

Create `src/config/avatar-migration.ts`. Decode with strict PNG size validation, write an exclusive temp file in `.openbot`, sync/close, rename, then update config. Catch per-agent failures and report warning callback.

- [ ] **Step 4: Integrate bootstrap**

After homes are created and before RPC registration, await migration. `setAgentAvatarBytes` writes the file and removes any legacy field; `getAgentAvatar` retains fallback.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run test/avatar-migration.test.ts test/roster-agents.test.ts test/execution-home-bootstrap.test.ts
```

- [ ] **Step 6: Verify Wave 3**

```bash
npx tsc -p tsconfig.json --noEmit
npm test -- --reporter=dot
```

- [ ] **Step 7: Record Wave 3 result**

Write `analysis_outputs/checkpoints/wave3-complete.txt`; deviations must be empty before Wave 4.