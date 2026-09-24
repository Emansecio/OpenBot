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
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";
import { MAX_PROVIDER_TEXT_CONTEXT_BYTES, createMemoryTranscriptStore, createTurnRunner, type TurnRunnerOptions, type TranscriptStore } from "../src/rpc/send.js";
import {
  canonicalProviderRequestBytes,
  providerRequestBodyBytes,
  resolveModelCapabilities,
} from "../src/memory/model-context.js";

/** Coleta os eventos publicados pelo runner (pub fake — sem HTTP). */
function collectPublish() {
  const events: { channel: string; payload: unknown }[] = [];
  return {
    events,
    publish: (channel: string, payload: unknown) => {
      events.push({ channel, payload });
    },
  };
}

/** Relógio determinístico (entries com timestampMs estável e crescente). */
function fixedClock() {
  let t = 1_000;
  return {
    now: () => (t += 1),
  };
}

function ids() {
  let n = 0;
  return { newId: () => `id:${++n}` };
}

type RunnerOpts = Omit<TurnRunnerOptions, "now" | "newId"> & {
  now?: () => number;
  newId?: (role: "user" | "assistant") => string;
};

function makeRunner(opts: RunnerOpts = {}): {
  runner: ReturnType<typeof createTurnRunner>;
  events: ReturnType<typeof collectPublish>["events"];
} {
  const now = opts.now ?? fixedClock().now;
  const newId = opts.newId ?? ids().newId;
  const pub = collectPublish();
  const runner = createTurnRunner({
    registry: opts.registry,
    store: opts.store,
    config: opts.config,
    systemPrompt: opts.systemPrompt,
    resolveProvider: opts.resolveProvider,
    publish: pub.publish,
    now,
    newId,
    ledgerCap: opts.ledgerCap,
  });
  return { runner, events: pub.events };
}

/** Registra um adapter fake como "xai" (provider do modelo default do catálogo). */
function fakeXai(deltas: string[] = ["resposta"]): {
  registry: ReturnType<typeof createProviderRegistry>;
  adapter: ReturnType<typeof createFakeAdapter>;
} {
  const registry = createProviderRegistry();
  const adapter = createFakeAdapter("xai", { deltas });
  registry.register(adapter);
  return { registry, adapter };
}


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
