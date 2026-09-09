/**
 * P2.4 — reasoning protocol (canonical events, fail-closed, never persisted).
 *
 * The core NEVER infers reasoning from busy/loading/timer/absence-of-delta; only
 * adapters whose exact provider+model pair declares the `reasoning` capability
 * may expose sanitized progress. Lifecycle ordering is enforced, open reasoning
 * is terminalized on abort/error, summaries are bounded/sanitized, and nothing
 * is written to the transcript or SQLite.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProviderRegistry } from "../src/providers/router.js";
import type { ProviderAdapter, ProviderChatRequest, ProviderStreamEvent } from "../src/providers/router.js";
import { overrideProviderCapability } from "../src/providers/capabilities.js";
import { createTurnRunner } from "../src/rpc/send.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

const roots: string[] = [];
const stores: SqliteTranscriptStore[] = [];

afterEach(() => {
  for (const db of stores.splice(0)) { try { db.close(); } catch { /* ignore */ } }
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { /* WAL lock */ }
    }
  }
});

function tmpStore(): { db: SqliteTranscriptStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "openbot-p24-r-"));
  roots.push(root);
  const db = new SqliteTranscriptStore({ path: join(root, "store.db") });
  stores.push(db);
  return { db, root };
}

interface ReasoningScript {
  events: Array<{ type: string; delta?: string; summary?: string; call?: unknown }>;
  throwError?: unknown;
}

function reasoningAdapter(name: string, script: ReasoningScript): ProviderAdapter {
  return {
    name,
    async streamChat(req: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void): Promise<void> {
      for (const step of script.events) {
        if (step.type === "reasoning-start") emit({ type: "reasoning-start", summary: step.summary });
        else if (step.type === "reasoning-progress") emit({ type: "reasoning-progress", summary: step.summary } as ProviderStreamEvent);
        else if (step.type === "reasoning-end") emit({ type: "reasoning-end", summary: step.summary });
        else if (step.type === "delta") emit({ type: "delta", delta: step.delta ?? "" });
        else if (step.type === "error") {
          emit({ type: "error", error: Object.assign(new Error(step.summary ?? "fail"), step.call) as never });
          return;
        }
      }
      if (script.throwError !== undefined) throw script.throwError;
      emit({ type: "done" });
    },
  };
}

interface Frames { reasoning: Array<Record<string, unknown>>; transcriptAppended: string[] }

function boot(store: SqliteTranscriptStore, adapter: ProviderAdapter) {
  const registry = createProviderRegistry();
  registry.register(adapter);
  const frames: Frames = { reasoning: [], transcriptAppended: [] };
  const publish = (channel: string, payload: unknown) => {
    if (channel === "reasoning") frames.reasoning.push(payload as Record<string, unknown>);
    if (channel === "transcript" && (payload as { type?: string }).type === "appended") {
      frames.transcriptAppended.push(String(JSON.stringify(payload).slice(0, 200)));
    }
  };
  let n = 0;
  const newId = (role: string) => "id-" + role + "-" + (++n);
  const runner = createTurnRunner({ registry, store, publish, newId: newId });
  return { runner, frames, store };
}

describe("P2.4 reasoning protocol", () => {
  it("never infers reasoning when the pair does not declare the capability", async () => {
    const { db } = tmpStore();
    const adapter = reasoningAdapter("xai", { events: [{ type: "delta", delta: "ok" }] });
    const { runner, frames } = boot(db, adapter);
    runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "r-1" });
    await runner.flush("a");
    expect(frames.reasoning).toEqual([]);
    db.close();
  });

  it("exposes only bounded sanitized summaries when the pair declares the capability", async () => {
    const { db } = tmpStore();
    const restore = overrideProviderCapability("xai", "grok-4.6", { reasoning: true });
    try {
      const adapter = reasoningAdapter("xai", {
        events: [
          { type: "reasoning-start", summary: "  analisando\u0000\u0001 a pergunta  " },
          { type: "reasoning-progress", summary: "step 1: narrowing\n\n\noptions" },
          { type: "reasoning-progress", summary: "step 2: " + "x".repeat(2000) },
          { type: "reasoning-end", summary: "conclusao parcial" },
          { type: "delta", delta: "resposta" },
        ],
      });
      const { runner, frames } = boot(db, adapter);
      runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "r-2" });
      await runner.flush("a");
      const types = frames.reasoning.map((f) => f.type);
      expect(types).toEqual(["start", "progress", "progress", "end"]);
      const start = frames.reasoning[0]!;
      expect(String(start.summary)).toContain("analisando");
      expect(String(start.summary)).not.toContain(String.fromCharCode(0));
      const second = frames.reasoning[2]!;
      expect(Buffer.byteLength(String(second.summary ?? ""), "utf8")).toBeLessThanOrEqual(512);
      for (const frame of frames.reasoning) {
        expect(frame).toMatchObject({ agentId: "a" });
        expect(frame.ordered).toMatchObject({ epoch: expect.any(String), sequence: expect.any(Number) });
      }
      const sequences = frames.reasoning.map((f) => (f.ordered as { sequence: number }).sequence);
      expect(sequences).toEqual([...sequences].sort((x, y) => x - y));
      expect(db.getEntries("a").some((e) => JSON.stringify(e).includes("narrowing"))).toBe(false);
    } finally {
      restore();
      db.close();
    }
  });

  it("drops reasoning events that arrive after content (invalid order) and after end", async () => {
    const { db } = tmpStore();
    const restore = overrideProviderCapability("xai", "grok-4.6", { reasoning: true });
    try {
      const adapter = reasoningAdapter("xai", {
        events: [
          { type: "delta", delta: "primeiro" },
          { type: "reasoning-start", summary: "tarde demais" },
          { type: "reasoning-progress", summary: "x" },
        ],
      });
      const { runner, frames } = boot(db, adapter);
      runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "r-3" });
      await runner.flush("a");
      expect(frames.reasoning).toEqual([]);
    } finally {
      restore();
      db.close();
    }
  });

  it("terminalizes open reasoning on abort with reason interrupted and never persists", async () => {
    const { db } = tmpStore();
    const restore = overrideProviderCapability("xai", "grok-4.6", { reasoning: true });
    try {
      const adapter = reasoningAdapter("xai", {
        events: [{ type: "reasoning-start", summary: "aberta" }, { type: "reasoning-progress", summary: "pensando" }],
        throwError: { name: "AbortError", code: "ABORT_ERR", message: "aborted" },
      });
      const { runner, frames } = boot(db, adapter);
      runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "r-4" });
      await runner.flush("a");
      const last = frames.reasoning[frames.reasoning.length - 1];
      expect(last?.type).toBe("end");
      expect(last?.reason).toBe("interrupted");
      expect(db.getEntries("a").some((e) => JSON.stringify(e).includes("pensando"))).toBe(false);
    } finally {
      restore();
      db.close();
    }
  });

  it("terminalizes open reasoning on error with reason error", async () => {
    const { db } = tmpStore();
    const restore = overrideProviderCapability("xai", "grok-4.6", { reasoning: true });
    try {
      const adapter = reasoningAdapter("xai", {
        events: [{ type: "reasoning-start", summary: "aberta" }],
        throwError: Object.assign(new Error("transaction-failed"), { status: 503 }),
      });
      const { runner, frames } = boot(db, adapter);
      runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "r-5" });
      await runner.flush("a");
      const last = frames.reasoning[frames.reasoning.length - 1];
      expect(last?.type).toBe("end");
      expect(last?.reason).toBe("error");
    } finally {
      restore();
      db.close();
    }
  });

  it("does not emit reasoning frames for unknown pairs even if the adapter emits them", async () => {
    const { db } = tmpStore();
    const adapter = reasoningAdapter("xai", {
      events: [{ type: "reasoning-start", summary: "x" }, { type: "reasoning-progress", summary: "y" }, { type: "reasoning-end" }, { type: "delta", delta: "ok" }],
    });
    const { runner, frames } = boot(db, adapter);
    runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "r-6" });
    await runner.flush("a");
    expect(frames.reasoning).toEqual([]);
    db.close();
  });
});
