/**
 * T10 — Turn runner mínimo (src/rpc/send.ts): unit tests do pipeline
 * envio → stream → transcript → eventos SSE (sem HTTP — o runner direto).
 *
 * Cobertura (plano §3 T10 — Done):
 *   - sendPrompt aceita → {accepted:true} (ack após persistir o echo);
 *   - dedupe por clientNonce (ledger de aceitação): retry do MESMO nonce
 *     retorna accepted SEM rodar de novo (turno único);
 *   - fila EXCLUSIVA por agente: turns do mesmo agente serializam (1 turno em
 *     curso por vez); agentes diferentes rodam em paralelo;
 *   - monta system prompt + transcript (entries kind "message" → diálogo);
 *   - eventos SSE `transcript` (snapshot no início / appended no tail) com
 *     kinds e message.type EXATOS do contrato (mapa-frontend §3.3):
 *     message / user-attachment / tool-call / notice — shapes que a UI
 *     renderiza sem duplicar a resposta textual;
 *   - provider ausente → notice de erro (sem quebrar a fila);
 *   - TranscriptStore INJETÁVEL (T11 pluga o sqlite pela mesma interface).
 *
 * Nota: o resolveProvider DEFAULT do runner usa o catálogo estático (Decisão
 * §8.3) — modelo default `grok-4.6` → provider "xai". Os testes registram o
 * adapter fake como "xai" para exercitar esse caminho real; onde um provider
 * arbitrário é preciso, passam `resolveProvider` explícito.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createProviderRegistry, type ProviderChatRequest } from "../src/providers/router.js";
import { createKeystore } from "../src/keystore/index.js";
import { XaiAdapter } from "../src/providers/xai.js";
import { MAX_PROVIDER_TEXT_CONTEXT_BYTES, createMemoryTranscriptStore, createTurnRunner, type TranscriptStore } from "../src/rpc/send.js";
import {
  canonicalProviderRequestBytes,
  providerRequestBodyBytes,
  resolveModelCapabilities,
} from "../src/memory/model-context.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { makeRunner, fakeXai } from "./helpers/turn-runner.js";

describe("T10 TranscriptStore injetável (T11 pluga o sqlite)", () => {
  it("store custom é usado para transcript e ledger — runner não sabe do storage", async () => {
    const { registry } = fakeXai();
    const seen: string[] = [];
    const nonces = new Set<string>();
    const customStore: TranscriptStore = {
      getEntries: (agentId) => {
        seen.push(`get:${agentId}`);
        return [];
      },
      append: (agentId, entries) => {
        seen.push(`append:${agentId}:${entries.length}`);
      },
      beginTurnAttempt: (attempt) => seen.push(`turn:begin:${attempt.agentId}:${attempt.turnId}`),
      updateTurnAttempt: (agentId, turnId, phase) => seen.push(`turn:${phase}:${agentId}:${turnId}`),
      finishTurnAttempt: (agentId, turnId) => seen.push(`turn:finish:${agentId}:${turnId}`),
      clear: (agentId) => {
        seen.push(`clear:${agentId}`);
      },
      getAgentTranscriptTail: () => ({ entries: [] }),
      openAgentTail: (agentId, limit) => {
        seen.push(`tail:${agentId}:${limit}`);
        return { entries: [] };
      },
      getConversationOutline: () => ({ title: null, lastMessage: null }),
      getRecentEntries: () => [],
      getEarliestUser: () => undefined,
      getLatestAssistant: () => undefined,
      getOpenToolCalls: () => [],
      hasAcceptedNonce: (agentId, nonce) => {
        seen.push(`has:${agentId}:${nonce}`);
        return nonces.has(`${agentId}:${nonce}`);
      },
      claimAcceptedNonce: (agentId, nonce) => {
        seen.push(`claim:${agentId}:${nonce}`);
        const key = `${agentId}:${nonce}`;
        if (nonces.has(key)) return false;
        nonces.add(key);
        return true;
      },
      rememberAcceptedNonce: (agentId, nonce) => {
        seen.push(`remember:${agentId}:${nonce}`);
        nonces.add(`${agentId}:${nonce}`);
      },
      forgetAcceptedNonce: (agentId, nonce) => {
        seen.push(`forget:${agentId}:${nonce}`);
        nonces.delete(`${agentId}:${nonce}`);
      },
      trimAcceptedNonces: (agentId, cap) => {
        seen.push(`trim:${agentId}:${cap}`);
      },
      replace: () => false,
    };
    const { runner } = makeRunner({ registry, store: customStore });

    runner.sendPrompt({ agentId: "a", prompt: "p", clientNonce: "nonce:store" });
    await runner.flush("a");

    expect(seen).toContain("tail:a:500");
    expect(seen.some((s) => s.startsWith("append:a:"))).toBe(true);
    expect(seen).toContain("claim:a:nonce:store");
    expect(seen).toContain("trim:a:1000");
    expect(seen.some((entry) => entry.startsWith("turn:begin:a:turn:"))).toBe(true);
    expect(seen.some((entry) => entry.startsWith("turn:provider-pending:a:turn:"))).toBe(true);
    expect(seen.some((entry) => entry.startsWith("turn:streaming:a:turn:"))).toBe(true);
    expect(seen.some((entry) => entry.startsWith("turn:finish:a:turn:"))).toBe(true);
  });

  it("ledger FIFO do store em memória remove o nonce mais antigo", () => {
    const store = createMemoryTranscriptStore();
    store.rememberAcceptedNonce("a", "n1");
    store.rememberAcceptedNonce("a", "n2");
    store.trimAcceptedNonces("a", 1);

    expect(store.hasAcceptedNonce("a", "n1")).toBe(false);
    expect(store.hasAcceptedNonce("a", "n2")).toBe(true);
  });

  it("keystore real injetada resolve chave de adapter real via registry (paridade com T6/T7)", async () => {
    const registry = createProviderRegistry();
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const fetchImpl = fetchMock as unknown as typeof globalThis.fetch;
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openbot-rpc-keystore-"));
    try {
      const keystore = createKeystore({ dir, writeBackend: undefined, legacyReadBackend: undefined });
      await keystore.upsert("xai", "xai-secreta");
      const adapter = new XaiAdapter({
        baseUrl: "http://127.0.0.1:1/v1",
        keystore,
        fetchImpl,
      });
      registry.register(adapter);

      const { runner } = makeRunner({ registry });
      runner.sendPrompt({ agentId: "a", prompt: "p" });
      await runner.flush("a");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]?.[1];
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer xai-secreta");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "grok-4.6", stream: true });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("send/tool xAI mede o body chat real, não apenas o envelope canônico", async () => {
    const registry = createProviderRegistry();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(String(init?.body));
      const payload = [
        { choices: [{ delta: { content: "done" } }] },
        "[DONE]",
      ];
      const body = payload.map((event) => event === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    registry.register(new XaiAdapter({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "xai-test", fetchImpl }));
    const system = "s".repeat(128);
    const prompt = "p".repeat(256);
    const maxTokens = resolveModelCapabilities("grok-4.6", "xai").maxOutputTokens;
    const toolWithPadding = (padding: number) => [{
      type: "function" as const,
      function: { name: "lookup", parameters: { type: "object", description: "d".repeat(padding) } },
    }];
    const canonicalWithoutPadding = canonicalProviderRequestBytes({
      model: "grok-4.6",
      system,
      messages: [{ role: "user", content: prompt }],
      tools: toolWithPadding(0),
      maxTokens,
    });
    const tools = toolWithPadding(MAX_PROVIDER_TEXT_CONTEXT_BYTES - canonicalWithoutPadding - 10);
    const ungatedRequest: ProviderChatRequest = {
      model: "grok-4.6",
      system,
      messages: [{ role: "user", content: prompt }],
      tools,
      maxTokens,
    };
    expect(canonicalProviderRequestBytes(ungatedRequest)).toBe(MAX_PROVIDER_TEXT_CONTEXT_BYTES - 10);
    expect(providerRequestBodyBytes("xai", ungatedRequest)).toBeGreaterThan(MAX_PROVIDER_TEXT_CONTEXT_BYTES);
    const runner = createTurnRunner({
      registry,
      systemPrompt: () => system,
      tools,
      toolExecutor: async () => ({ handled: true, ok: true, content: "tool ok", result: { ok: true } }),
    });

    runner.sendPrompt({ agentId: "a", prompt });
    await runner.flush("a");

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0] ?? "{}") as { model: string; messages: ProviderChatRequest["messages"]; tools: NonNullable<ProviderChatRequest["tools"]>; max_tokens: number };
    const canonical = canonicalProviderRequestBytes({
      model: body.model,
      system: body.messages[0]?.role === "system" && typeof body.messages[0].content === "string" ? body.messages[0].content : undefined,
      messages: body.messages.filter((message) => message.role !== "system"),
      tools: body.tools,
      maxTokens: body.max_tokens,
    });
    const bodyBytes = Buffer.byteLength(calls[0] ?? "", "utf8");
    expect(bodyBytes).toBeLessThanOrEqual(MAX_PROVIDER_TEXT_CONTEXT_BYTES);
    expect(bodyBytes).toBeGreaterThan(MAX_PROVIDER_TEXT_CONTEXT_BYTES - 512);
    expect(bodyBytes).toBeGreaterThan(canonical + 25);
  });
});

describe("tool-call lookups without full transcript scans", () => {
  it("uses an optional local tool-call lookup without scanning getEntries", () => {
    const store = createMemoryTranscriptStore();
    const pending = {
      kind: "tool-call" as const,
      id: "tool-entry",
      localToolCallId: "turn:tool-entry",
      name: "file",
      summary: "read Documents/note.txt",
      status: "pending" as const,
    };
    store.append("agent", [pending]);
    const getEntries = vi.spyOn(store, "getEntries").mockImplementation(() => {
      throw new Error("full transcript scan");
    });
    const runner = createTurnRunner({ store });
    const publishToolCall = (runner as unknown as {
      publishToolCall: (agentId: string, entry: Extract<TranscriptEntry, { kind: "tool-call" }>) => void;
    }).publishToolCall.bind(runner);

    publishToolCall("agent", { ...pending, status: "running" });

    expect(getEntries).not.toHaveBeenCalled();
    expect(store.findToolCallByLocalId?.("agent", "turn:tool-entry")).toMatchObject({ status: "running" });
  });

  it("uses the SQLite local tool-call index without scanning getEntries", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const pending = {
        kind: "tool-call" as const,
        id: "sqlite-tool-entry",
        localToolCallId: "turn:sqlite-tool-entry",
        name: "file",
        summary: "read Documents/note.txt",
        status: "pending" as const,
      };
      store.append("agent", [pending]);
      const getEntries = vi.spyOn(store, "getEntries").mockImplementation(() => {
        throw new Error("full transcript scan");
      });
      const runner = createTurnRunner({ store });
      const publishToolCall = (runner as unknown as {
        publishToolCall: (agentId: string, entry: Extract<TranscriptEntry, { kind: "tool-call" }>) => void;
      }).publishToolCall.bind(runner);

      publishToolCall("agent", { ...pending, status: "running" });

      expect(getEntries).not.toHaveBeenCalled();
      expect(store.findToolCallByLocalId("agent", "turn:sqlite-tool-entry")).toMatchObject({ status: "running" });
    } finally {
      store.close();
    }
  });

  it("publishes the completed tool snapshot through the durable tail without scanning getEntries", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      store.append("agent", Array.from({ length: 2_000 }, (_, index) => ({
        kind: "message" as const,
        id: `history:${index}`,
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `h${index}`,
        timestampMs: index,
        streaming: false,
      })));
      const pending = {
        kind: "tool-call" as const,
        id: "sqlite-tool-complete",
        localToolCallId: "turn:sqlite-tool-complete",
        name: "file",
        summary: "read Documents/note.txt",
        status: "pending" as const,
      };
      store.append("agent", [pending]);
      let tailReads = 0;
      const openDurableAgentTail = store.openDurableAgentTail.bind(store);
      store.getEntries = () => {
        throw new Error("full transcript scan");
      };
      store.openDurableAgentTail = (agentId, limit, beforeSeq, conversationId) => {
        tailReads += 1;
        return openDurableAgentTail(agentId, limit, beforeSeq, conversationId);
      };
      const events: Array<{ channel: string; payload: unknown }> = [];
      const runner = createTurnRunner({
        store,
        publish: (channel, payload) => {
          events.push({ channel, payload });
        },
      });
      const publishToolCall = (runner as unknown as {
        publishToolCall: (agentId: string, entry: Extract<TranscriptEntry, { kind: "tool-call" }>) => void;
      }).publishToolCall.bind(runner);

      publishToolCall("agent", {
        ...pending,
        status: "completed",
        result: { ok: true, operation: "file.read", path: "Documents/note.txt", bytes: 1 },
      });

      const snapshot = events.find((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot")
        ?.payload as { entries: TranscriptEntry[]; truncated?: boolean; method?: string } | undefined;
      expect(tailReads).toBe(1);
      expect(snapshot?.entries.at(-1)).toMatchObject({ id: "sqlite-tool-complete", status: "completed" });
      expect(snapshot).toMatchObject({ truncated: true, method: "openAgentTail" });
    } finally {
      store.close();
    }
  });
});
