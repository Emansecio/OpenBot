# OpenBot Wave 2 Context and Execution Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Enforce a token-aware request budget and speed independent local reads without reordering mutations.

**Architecture:** Add a pure context budget module and a provider-context builder over Wave 1 limited store APIs. Introduce reusable bounded concurrency for attachments, search batches, read-only tools, and local endpoint probes.

**Tech Stack:** TypeScript ESM, Node.js fs/promises, Vitest.

**Specification:** `docs/superpowers/specs/2026-08-14-openbot-context-execution-optimization-design.md`

---

## File map

- Create `src/context/budget.ts` and `test/context-budget.test.ts`.
- Create `src/rpc/provider-context.ts` and `test/provider-context.test.ts`.
- Create `src/shared/async.ts` and `test/async-limit.test.ts`.
- Modify `src/config/models.ts`, `src/shared/contracts.ts`, `src/rpc/send.ts`.
- Modify `src/rpc/attachments.ts`, `src/execution/commands.ts`, `src/execution/tool-loop.ts`, `src/execution/contracts.ts`.
- Modify `src/providers/local-discover.ts` and create `test/local-discover-optimization.test.ts`.

### Task 1: Implement the pure token budget

- [ ] **Step 1: Write failing tests**

Create `test/context-budget.test.ts` covering conservative byte estimation, output reservation, recent complete turns, tool-call/tool-result grouping, omission marker, and impossible system/tools budget.

Core assertion:

```ts
const result = fitContext({
  capabilities: { contextWindow: 100, maxOutputTokens: 20 },
  requestedOutputTokens: 20,
  system: "system",
  tools: [],
  messages: longConversation,
});
expect(result.estimatedInputTokens + result.maxOutputTokens).toBeLessThanOrEqual(100);
expect(result.messages.at(-1)).toEqual(longConversation.at(-1));
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/context-budget.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement minimal pure functions**

In `src/context/budget.ts`, export:

```ts
export const estimateTextTokens = (text: string): number =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 3);

export function fitContext(input: ContextBudgetInput): ContextBudgetResult;
```

Group assistant messages carrying `toolCalls` with following tool messages. Never return a partial group. Throw `ContextBudgetError` when system/tools/output reservation alone exceeds the context window.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/context-budget.test.ts
```

- [ ] **Step 5: Record checkpoint**

Write `analysis_outputs/checkpoints/wave2-task1.txt`.

### Task 2: Add model capabilities and provider context builder

- [ ] **Step 1: Write failing tests**

Create `test/provider-context.test.ts`. Seed a store with more history than the budget, include attachments, and assert:

- only recent complete turns are returned;
- `maxTokens` equals the capability reservation;
- `getEntries()` is not called;
- the deprecated exported 80-message constant does not control output.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/provider-context.test.ts
```

- [ ] **Step 3: Extend additive model metadata**

Add optional `contextWindow` and `maxOutputTokens` to `ModelCatalogEntry`. Populate the exact values approved in the spec. Export `capabilitiesForModel(modelId)` with 32k/4k fallback.

- [ ] **Step 4: Implement `ProviderContextBuilder`**

Query `getRecentEntries()` in bounded batches, convert transcript entries to provider messages, merge current attachments, call `fitContext`, and return `{messages,maxTokens,estimatedInputTokens}`.

- [ ] **Step 5: Integrate TurnRunner**

Replace legacy `toProviderMessages()` with the builder. Keep `MAX_PROVIDER_TRANSCRIPT_MESSAGES = 80` exported and mark it `@deprecated`; do not use it.

- [ ] **Step 6: Verify GREEN**

```bash
npx vitest run test/context-budget.test.ts test/provider-context.test.ts test/rpc-send.test.ts test/providers.test.ts
```

- [ ] **Step 7: Record checkpoint**

Write `analysis_outputs/checkpoints/wave2-task2.txt`.

### Task 3: Add reusable bounded concurrency

- [ ] **Step 1: Write failing tests**

Create `test/async-limit.test.ts` asserting `mapLimit` never exceeds the requested concurrency, preserves result order, propagates AbortSignal, and converts no errors implicitly.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/async-limit.test.ts
```

- [ ] **Step 3: Implement `mapLimit`**

Create `src/shared/async.ts`:

```ts
export async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]>;
```

Use a shared next index and fixed worker count. Validate positive integer limit and check abort before scheduling each item.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/async-limit.test.ts
```

### Task 4: Bound attachment reads before allocation

- [ ] **Step 1: Write failing tests**

Create `test/attachments-optimization.test.ts`. Introduce an injectable `AttachmentFileIo` used only by the bounded-read helper; the fake handle reports a 64 MiB size and counts `read()` calls. Assert rejection performs zero reads. Also assert only eight attachment handles are opened and output order matches input order with concurrency four.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/attachments-optimization.test.ts
```

- [ ] **Step 3: Implement bounded read**

Define `AttachmentFileIo` with `open(path)` returning a handle exposing `stat`, `read`, and `close`; provide the Node fs implementation as default. Replace `readFile(real)` with the injected open/stat flow and a loop reading at most `limit + 1`. Close in `finally`. Add `MAX_ATTACHMENTS_PER_TURN=8` and `ATTACHMENT_READ_CONCURRENCY=4`. Process accepted items with `mapLimit`, append `skipped` results for excess items, and apply the remaining context budget.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/attachments-optimization.test.ts test/rpc-send-tools.test.ts test/rpc-send.test.ts
```

- [ ] **Step 5: Record checkpoint**

Write `analysis_outputs/checkpoints/wave2-task4.txt`.

### Task 5: Bound and batch search output

- [ ] **Step 1: Write failing tests**

In `test/execution-commands.test.ts`, create files whose matching output exceeds 128 KiB. Assert UTF-8-valid truncation marker and `truncated:true`. Add a controlled workspace test showing reads start in batches but output path order remains sorted.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/execution-commands.test.ts
```

- [ ] **Step 3: Extend result type additively**

Add `truncated?: boolean` to successful `command.run` result. Add a UTF-8-safe `truncateOutput` helper with `MAX_TOOL_RESULT_BYTES=128*1024`.

- [ ] **Step 4: Read files in deterministic batches**

Use batches of eight paths. Read each batch via `mapLimit`, process returned text in path order, and stop before scheduling the next batch when limits are exhausted. Keep `MAX_SEARCH_RESULTS=1000`.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run test/execution-commands.test.ts test/execution-contracts.test.ts
```

### Task 6: Parallelize only all-read-only tool rounds

- [ ] **Step 1: Write failing tests**

In `test/rpc-send-tools.test.ts`, use a broker with deferred promises. Assert two `file.read` calls start before either resolves and results retain provider order. Add a batch containing `file.write` and assert strict serial start order.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/rpc-send-tools.test.ts
```

- [ ] **Step 3: Implement classification and execution**

Add pure `isReadOnlyExecutionRequest`. If every parsed unique call is read-only, use `mapLimit(...,4)`; otherwise use the existing sequential loop. Publish running/completed cards by ID and assemble `toolResults` in original order.

- [ ] **Step 4: Apply output cap to every tool result**

Before `resultText`, truncate serialized content to 128 KiB with the same explicit marker.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run test/rpc-send-tools.test.ts test/rpc-tool-lifecycle.test.ts test/execution-approval.test.ts
```

### Task 7: Parallelize local endpoint discovery

- [ ] **Step 1: Write failing concurrency test**

Create `test/local-discover-optimization.test.ts`, inject two fetch promises and assert both are invoked before either resolves; resolve in reverse order and assert result order remains LM Studio then Ollama.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/local-discover-optimization.test.ts
```

- [ ] **Step 3: Implement `Promise.allSettled` mapping**

Map `PROBES` to `fetchJson`, await all, then transform by index. Convert a rejected probe to the existing unreachable shape.

- [ ] **Step 4: Verify Wave 2**

```bash
npx vitest run test/local-discover-optimization.test.ts test/roster-agents.test.ts
npx tsc -p tsconfig.json --noEmit
npm test -- --reporter=dot
```

- [ ] **Step 5: Record Wave 2 result**

Write `analysis_outputs/checkpoints/wave2-complete.txt`; deviations must be empty before Wave 3.