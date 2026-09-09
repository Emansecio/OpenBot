# OpenBot Wave 1 Transcript and Streaming Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Bound transcript and streaming work so it no longer scales with total history or every provider delta.

**Architecture:** Extend `TranscriptStore` with limited queries implemented by memory and SQLite stores, cache SQLite statements, and extract live response scheduling into `src/rpc/stream-state.ts`. Keep current SSE payload shapes while removing redundant full snapshots.

**Tech Stack:** TypeScript ESM, Node.js, better-sqlite3, Vitest.

**Specification:** `docs/superpowers/specs/2026-08-14-openbot-transcript-streaming-optimization-design.md`

**Checkpoint note:** This folder is not a Git repository. Replace commit steps with `analysis_outputs/checkpoints/wave1-*.txt` containing commands and results.

---

## File map

- Create `src/rpc/stream-state.ts`: live assistant buffering, publish/checkpoint cadence, byte ceiling.
- Create `test/transcript-optimization.test.ts`: memory/SQLite limited query contract and nonce pruning.
- Create `test/stream-state.test.ts`: deterministic cadence and byte ceiling tests.
- Modify `src/rpc/send.ts`: new store methods, live state integration, snapshot removal.
- Modify `src/store/index.ts`: cached statements and limited SQL queries.
- Modify `test/rpc-send.test.ts`: compatibility assertions for event sequence.
- Modify `test/gateway-backpressure.test.ts`: verify no oversized turn snapshot is produced.

### Task 1: Add limited transcript APIs to the memory store

- [ ] **Step 1: Write the failing contract tests**

Create `test/transcript-optimization.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { createMemoryTranscriptStore } from "../src/rpc/send.js";

const message = (id: string, role: "user" | "assistant", content = id) => ({
  kind: "message" as const,
  id,
  role,
  content,
  streaming: false,
});

describe("limited TranscriptStore queries", () => {
  it("returns only the recent entries in chronological order", () => {
    const store = createMemoryTranscriptStore();
    store.append("a", Array.from({ length: 20 }, (_, i) => message(`m-${i}`, i % 2 ? "assistant" : "user")));
    expect(store.getRecentEntries("a", { limit: 3 }).map((entry) => entry.id)).toEqual(["m-17", "m-18", "m-19"]);
  });

  it("returns the latest assistant without a full-history API", () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [message("u", "user"), message("a1", "assistant"), message("a2", "assistant")]);
    expect(store.getLatestAssistant("a")?.id).toBe("a2");
  });

  it("returns only pending and running tool calls", () => {
    const store = createMemoryTranscriptStore();
    store.append("a", [
      { kind: "tool-call", id: "p", name: "file", summary: "p", status: "pending" },
      { kind: "tool-call", id: "r", name: "file", summary: "r", status: "running" },
      { kind: "tool-call", id: "c", name: "file", summary: "c", status: "completed" },
    ]);
    expect(store.getOpenToolCalls("a").map((entry) => entry.id)).toEqual(["p", "r"]);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run test/transcript-optimization.test.ts
```

Expected: TypeScript/runtime failure because the three methods do not exist.

- [ ] **Step 3: Extend the interface and memory implementation minimally**

In `src/rpc/send.ts`, add:

```ts
export interface RecentEntriesOptions {
  limit: number;
  kinds?: readonly TranscriptEntry["kind"][];
}
```

Add the three methods from the specification to `TranscriptStore`. In `createMemoryTranscriptStore()` implement recent slicing, reverse scan for latest assistant, and filter for open tools. Validate `limit` as a positive integer.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
npx vitest run test/transcript-optimization.test.ts test/rpc-send.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Record checkpoint**

Write command output summary to `analysis_outputs/checkpoints/wave1-task1.txt`.

### Task 2: Implement limited SQLite queries and cached statements

- [ ] **Step 1: Add failing SQLite parity tests**

Append tests that instantiate `SqliteTranscriptStore({path:":memory:"})`, seed the same entries, and assert identical recent/latest/open results. Add:

```ts
it("keeps exactly the newest accepted nonces", () => {
  const store = new SqliteTranscriptStore({ path: ":memory:" });
  for (let i = 0; i < 8; i++) store.rememberAcceptedNonce("a", `n-${i}`);
  store.trimAcceptedNonces("a", 3);
  expect([0,1,2,3,4].every((i) => !store.hasAcceptedNonce("a", `n-${i}`))).toBe(true);
  expect([5,6,7].every((i) => store.hasAcceptedNonce("a", `n-${i}`))).toBe(true);
  store.trimAcceptedNonces("a", 0);
  expect(store.hasAcceptedNonce("a", "n-7")).toBe(false);
  store.close();
});
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/transcript-optimization.test.ts
```

Expected: SQLite store lacks the new methods.

- [ ] **Step 3: Cache statements and implement queries**

In `src/store/index.ts`, prepare recurring statements once after migration. Use SQL equivalent to:

```sql
SELECT payload_json
FROM transcript_entries
WHERE agent_id = ?
ORDER BY sequence_id DESC
LIMIT ?;
```

Reverse rows before parsing. For kind filters, select a bounded recent superset and filter, or use fixed whitelisted SQL variants; never interpolate user input. Implement latest assistant/open tool SQL with `json_extract`. Replace nonce row loading/deletion loop with one parameterized `DELETE` retaining newest `cap` rows.

- [ ] **Step 4: Replace outline full scan**

Prepare one query for first non-empty user message and one for latest non-empty message using `json_extract`. Parse only returned payloads.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run test/transcript-optimization.test.ts test/store.test.ts test/rpc-send.test.ts
```

Expected: all pass.

- [ ] **Step 6: Record checkpoint**

Write `analysis_outputs/checkpoints/wave1-task2.txt`.

### Task 3: Build deterministic live stream state

- [ ] **Step 1: Write failing state tests**

Create `test/stream-state.test.ts` with a fake clock and callbacks. Required assertions:

```ts
it("publishes at 100ms and persists at 1000ms", () => {
  const events: string[] = [];
  const state = createLiveStreamState({
    id: "assistant-1",
    publishIntervalMs: 100,
    persistIntervalMs: 1000,
    maxTextBytes: 192 * 1024,
    onPublish: (content) => events.push(`publish:${content}`),
    onPersist: (content) => events.push(`persist:${content}`),
    onLimit: () => events.push("limit"),
  });
  state.append("a", 0);
  state.append("b", 50);
  state.append("c", 100);
  state.append("d", 1000);
  expect(events).toEqual(["persist:a", "publish:abc", "publish:abcd", "persist:abcd"]);
});
```

Add a UTF-8 byte ceiling test using multibyte text and assert `onLimit` runs once.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/stream-state.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/rpc/stream-state.ts`**

Export constants and `createLiveStreamState`. Keep chunks, cached materialized content, byte count, last publish/persist timestamps, and a closed/limited flag. First append always persists. `finalize(now)` always publishes/persists final content once and returns it.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/stream-state.test.ts
```

Expected: all pass.

- [ ] **Step 5: Record checkpoint**

Write `analysis_outputs/checkpoints/wave1-task3.txt`.

### Task 4: Integrate live state into TurnRunner

- [ ] **Step 1: Write failing runner behavior tests**

In `test/rpc-send.test.ts`, add tests that:

- send a prompt through a fake adapter emitting controlled deltas;
- assert zero `{type:"snapshot"}` events at turn start;
- assert `updated` events retain the existing entry shape;
- wrap the store and count `replace()` calls;
- simulate 5,000 publish ticks and assert replaces are bounded by checkpoints plus finalization;
- complete a tool and assert no snapshot is emitted.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/rpc-send.test.ts
```

Expected: current implementation emits snapshots and replaces every publish tick.

- [ ] **Step 3: Split durable replace from compatible publish**

In `src/rpc/send.ts`:

- replace `liveAssistant` value with the live state abstraction;
- remove start/tool snapshots;
- make SSE `updated` publication independent from `store.replace()`;
- call `store.replace()` only from checkpoint/final callbacks;
- use `getLatestAssistant()` and `getOpenToolCalls()`;
- keep final `send-message` behavior unchanged.

- [ ] **Step 4: Add response limit behavior**

When live state reaches 192 KiB, abort the active controller, finalize the allowed prefix, and publish one error-level notice: `Resposta interrompida ao atingir o limite local de 192 KiB.` Suppress the generic duplicate abort notice for this case.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run test/rpc-send.test.ts test/stream-state.test.ts test/rpc-tool-lifecycle.test.ts test/gateway-backpressure.test.ts
```

Expected: all pass.

- [ ] **Step 6: Run Wave 1 verification**

```bash
npx tsc -p tsconfig.json --noEmit
npm test -- --reporter=dot
```

Expected: zero type errors and all tests pass.

- [ ] **Step 7: Record Wave 1 result**

Write `analysis_outputs/checkpoints/wave1-complete.txt` with test counts and remaining deviations from the spec; deviations must be empty before Wave 2.