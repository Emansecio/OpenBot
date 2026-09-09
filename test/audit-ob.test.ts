import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { isSafeSearchRegex } from "../src/execution/commands.js";
import { createKeystore } from "../src/keystore/index.js";
import { localFileBackend } from "../src/keystore/backend.js";
import { randomBytes } from "node:crypto";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { classifyProviderError, defaultRegistry,createProviderRegistry } from "../src/providers/router.js";
import { MAX_PROVIDER_TRANSCRIPT_MESSAGES, MAX_SEND_QUEUE_PER_AGENT, createTurnRunner } from "../src/rpc/send.js";
import { createGateway } from "../src/server/gateway.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";

const dirs: string[] = [];
const handles: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-audit-"));
  dirs.push(dir);
  return dir;
}

async function boot(extra: Parameters<typeof startServer>[1] = {}): Promise<ServerHandle> {
  const dir = tempDir();
  const allowUnauthenticatedLocalGateway = extra.gatewayToken === undefined;
  const handle = await startServer(0, {
    disableAgentHome: true,
    stateRoot: join(dir, "state"),
    runtimeRoot: join(dir, "runtime"),
    browserRoot: join(dir, "browser"),
    ...(allowUnauthenticatedLocalGateway ? { allowUnauthenticatedLocalGateway: true } : {}),
    configPath: join(dir, "openbot-config.json"),
    storePath: join(dir, "store.db"),
    keystoreDir: dir,
    ...extra,
  });
  handles.push(handle);
  return handle;
}

async function post(handle: ServerHandle, method: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("audit remaining findings", () => {
  it("OB-02/07 local-file backend persiste e delete some do disco", async () => {
    const dir = tempDir();
    const key = randomBytes(32);
    const first = createKeystore({ dir, writeBackend: localFileBackend(key) });
    expect(first.isPersistent()).toBe(true);
    await first.upsert("xai", "xai-persist-1");
    const raw = readFileSync(first.getFile(), "utf8");
    expect(raw).not.toContain("xai-persist-1");
    const second = createKeystore({ dir, writeBackend: localFileBackend(key) });
    expect(await second.reveal("xai")).toBe("xai-persist-1");
    expect(await second.delete("xai")).toBe(true);
    const third = createKeystore({ dir, writeBackend: localFileBackend(key) });
    expect(await third.reveal("xai")).toBeNull();
  });

  it("OB-03 não persiste baseURL inválida", async () => {
    const handle = await boot();
    const before = handle.config.snapshot().compatBaseUrl;
    const result = await post(handle, "setProviderConfig", {
      model: "openai-compatible",
      baseURL: "ftp://invalid.example/v1",
    });
    expect(result.status).toBe(400);
    expect(handle.config.snapshot().compatBaseUrl).toBe(before);
  });

  it("OB-04 não limpa baseURL enquanto openai-compat está em uso", async () => {
    const handle = await boot();
    const ok = await post(handle, "setProviderConfig", {
      model: "openai-compatible",
      baseURL: "http://127.0.0.1:1234/v1",
    });
    expect(ok.status).toBe(200);
    expect(handle.registry.has("openai-compat")).toBe(true);
    expect(defaultRegistry.has("openai-compat")).toBe(false);
    const cleared = await post(handle, "setProviderConfig", { baseURL: null });
    expect(cleared.status).toBe(400);
    expect(handle.config.snapshot().compatBaseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(handle.registry.has("openai-compat")).toBe(true);
  });

  it("OB-05 recusa RPC sem token quando o gateway exige", async () => {
    const handle = await boot({ gatewayToken: "secret-token-ob05" });
    const denied = await post(handle, "countAgents", {});
    expect(denied.status).toBe(401);
    const allowed = await post(handle, "countAgents", {}, { authorization: "Bearer secret-token-ob05" });
    expect(allowed.status).toBe(200);
  });

  it("OB-08 setHostSettings rejeita localToolPermission inválido", async () => {
    const handle = await boot();
    const before = handle.config.snapshot().hostSettings.localToolPermission;
    const result = await post(handle, "setHostSettings", {
      timezone: "America/Sao_Paulo",
      pinnedAgents: [],
      autoReviewEnabled: false,
      localToolPermission: "sometimes",
    });
    expect(result.status).toBe(400);
    expect(handle.config.snapshot().hostSettings.localToolPermission).toBe(before);
  });

  it("rejeita a tentativa de alterar a execução local automática", async () => {
    const handle = await boot();
    handle.config.update({ hostSettings: { ...handle.config.snapshot().hostSettings, localToolPermission: "always" } });
    const result = await post(handle, "setHostSettings", {
      ...handle.config.snapshot().hostSettings,
      localToolPermission: "ask",
    });
    expect(result.status).toBe(400);
    expect(handle.config.snapshot().hostSettings.localToolPermission).toBe("always");
  });

  it("OB-09 timeout vira network retryable", () => {
    const err = Object.assign(new Error("provider request timed out"), { name: "AbortError", code: "ETIMEDOUT" });
    const classified = classifyProviderError(err);
    expect(classified.kind).toBe("network");
    expect(classified.retryable).toBe(true);
  });

  it("OB-10 aceita accountSlot+clientNonce", async () => {
    const handle = await boot();
    await post(handle, "createAgent", { id: "openbot-default", name: "Test Default" });
    await post(handle, "sendPrompt", { agentId: "openbot-default", prompt: "oi", clientNonce: "slot-1" });
    const status = await post(handle, "promptAcceptanceStatus", { accountSlot: "default", clientNonce: "slot-1" });
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ ok: true, value: { outcome: "found", record: { status: "accepted" } } });
    const missing = await post(handle, "promptAcceptanceStatus", { accountSlot: "default", clientNonce: "not-dispatched" });
    expect(missing.status).toBe(200);
    expect(missing.json).toMatchObject({ ok: true, value: { outcome: "not-found" } });
    await post(handle, "createAgent", { id: "other-acceptance", name: "Other" });
    await post(handle, "sendPrompt", { agentId: "other-acceptance", prompt: "oi", clientNonce: "slot-1" });
    const ambiguous = await post(handle, "promptAcceptanceStatus", { accountSlot: "default", clientNonce: "slot-1" });
    expect(ambiguous.status).toBe(409);
  });

  it("OB-11/12 widgets e flags de agente não ficam presos no default", async () => {
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("openai", { deltas: ["ok"] }));
    const handle = await boot({ registry });
    const created = await post(handle, "createAgent", { name: "Other" });
    const id = (created.json.value as { agent: { id: string } }).agent.id;
    const widget = await post(handle, "respondToWidget", { agentId: id, entryId: "w1", value: "ok" });
    expect(widget.status).toBe(200);
    const unread = await post(handle, "setAgentUnread", { agentId: id, unread: true });
    expect(unread.status).toBe(200);
    expect((unread.json.value as { hasUnread: boolean }).hasUnread).toBe(true);
    const hidden = await post(handle, "setAgentHiddenFromSidebar", { agentId: id, hidden: true });
    expect((hidden.json.value as { hiddenFromSidebar: boolean }).hiddenFromSidebar).toBe(true);
    // P2.4: reactToMessage now targets a durable persisted entry. Create a real
    // message first — the inert stub has been retired and a missing target is
    // fail-closed 404.
    const sent = await post(handle, "sendPrompt", { agentId: id, prompt: "alvo da reaction", clientNonce: "ob11-target" });
    expect(sent.status).toBe(200);
    await handle.runner.flush(id);
    const conversationId = handle.conversationStore?.getActive(id)?.id;
    expect(conversationId).toBeTypeOf("string");
    const entry = handle.store.getEntries(id, conversationId as string).find((entry) => entry.kind === "message" && entry.role === "user");
    expect(entry).toBeDefined();
    const reacted = await post(handle, "reactToMessage", { agentId: id, messageId: (entry as { id: string }).id, reaction: "heart" });
    expect(reacted.status).toBe(200);
  });

  it("OB-11/12 P2.4: reactToMessage fails closed (404) for a missing entry", async () => {
    const handle = await boot();
    const created = await post(handle, "createAgent", { name: "Other" });
    const id = (created.json.value as { agent: { id: string } }).agent.id;
    const reacted = await post(handle, "reactToMessage", { agentId: id, messageId: "m1", reaction: "heart" });
    expect(reacted.status).toBe(404);
  });

  it("OB-19 prepare-upgrade usa runningTurns do runner", async () => {
    let releaseTurn!: () => void;
    let markStarted!: () => void;
    const blockedTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const turnStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat() {
        markStarted();
        await blockedTurn;
      },
    });
    const handle = await boot({ registry });
    try {
      await post(handle, "createAgent", { id: "openbot-default", name: "Test Default" });
      await post(handle, "sendPrompt", { agentId: "openbot-default", prompt: "oi", clientNonce: "ob19-running" });
      await withTimeout(turnStarted, "turn start");
      expect(handle.runner.getStatus().runningTurns).toBe(1);

      const response = await fetch(`http://127.0.0.1:${handle.port}/prepare-upgrade`, { method: "POST" });
      const body = await response.json() as { runningTurns: number };
      expect(body.runningTurns).toBe(handle.runner.getStatus().runningTurns);
      expect(body.runningTurns).toBe(1);
    } finally {
      releaseTurn();
      await handle.runner.flush("openbot-default");
    }
  });

  it("OB-21 recusa fila acima do teto", () => {
    const registry = defaultRegistry;
    const previous = registry.get("xai");
    registry.register({
      name: "xai",
      async streamChat() {
        await new Promise(() => undefined);
      },
    });
    try {
      const runner = createTurnRunner({ registry });
      expect(MAX_SEND_QUEUE_PER_AGENT).toBeGreaterThan(0);
      expect(MAX_PROVIDER_TRANSCRIPT_MESSAGES).toBeGreaterThan(0);
      for (let i = 0; i < MAX_SEND_QUEUE_PER_AGENT; i += 1) {
        expect(runner.sendPrompt({ agentId: "a", prompt: `p${i}` })).toBeInstanceOf(Promise);
      }
      expect(() => runner.sendPrompt({ agentId: "a", prompt: "overflow" })).toThrow(/fila cheia/);
    } finally {
      if (previous) registry.register(previous);
    }
  });

  it("OB-25 rejeita regex insegura", () => {
    expect(isSafeSearchRegex("foo")).toBe(true);
    expect(isSafeSearchRegex("(.*){1000}")).toBe(false);
    expect(isSafeSearchRegex("(.*)(.*)")).toBe(false);
  });

  it("OB-28 query de canal fora da allowlist é ignorada", async () => {
    const gateway = createGateway({ sseChannels: new Set(["transcript"]) });
    const server = createServer(gateway.createHandler());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/events?channels=transcript,secrets-leak`, {
        headers: { accept: "text/event-stream" },
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      try {
        const forbidden = gateway.publish("secrets-leak", { marker: "forbidden-ob28" });
        const allowed = gateway.publish("transcript", { marker: "allowed-ob28" });
        expect(forbidden.eligibleClients).toBe(0);
        expect(allowed.eligibleClients).toBe(1);

        const decoder = new TextDecoder();
        let received = "";
        while (!received.includes("allowed-ob28")) {
          const chunk = await withTimeout(reader.read(), "SSE frame");
          expect(chunk.done).toBe(false);
          received += decoder.decode(chunk.value, { stream: true });
        }
        expect(received).toContain('"channel":"transcript"');
        expect(received).not.toContain("forbidden-ob28");
      } finally {
        await reader.cancel();
      }
    } finally {
      gateway.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
