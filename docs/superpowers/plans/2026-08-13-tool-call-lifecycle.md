# Tool-call Lifecycle Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Cards `tool-call` no transcript acompanham pending → running → completed/failed e guardam o resultado sanitizado.

**Architecture:** `TranscriptStore.replace` atualiza a entry pelo `id` da tool call. O runner publica `pending` no `appended`, depois `updated` + `snapshot`. O `runToolLoop` notifica progresso. Sem broker, o comportamento T10 (`completed` imediato) permanece.

**Tech Stack:** TypeScript, SQLite (`better-sqlite3`), Vitest.

**Spec:** [`../specs/2026-08-13-tool-call-lifecycle-design.md`](../specs/2026-08-13-tool-call-lifecycle-design.md)

---

### Task 1: Store.replace + evento `updated`

**Files:**
- Modify: `src/shared/contracts.ts` — `TranscriptEventPayload` ganha `updated`
- Modify: `src/rpc/send.ts` — `TranscriptStore.replace`
- Modify: `src/store/index.ts` — UPDATE por `entry_id`
- Modify: `test/store.test.ts`
- Create: `test/rpc-tool-lifecycle.test.ts` (nas tasks 2–3)

Memory store e SQLite implementam `replace(agentId, entryId, entry): boolean`.

### Task 2: Loop e runner

**Files:**
- Modify: `src/execution/tool-loop.ts` — `onProgress`
- Modify: `src/rpc/send.ts` — upsert do card
- Modify: `test/rpc-send.test.ts` — chat-only continua `completed`
- Modify: `test/rpc-send-tools.test.ts` — um card final `completed` com `result`

### Task 3: Docs

**Files:**
- Modify: `README.md`, `docs/phase-2-local-execution-progress.md` — item 4 feito
