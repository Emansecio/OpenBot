import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProviderRegistry } from "../src/providers/router.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { createMemoryTranscriptStore } from "../src/rpc/send.js";
import { registerRpcHandlers } from "../src/rpc/index.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { Gateway } from "../src/server/gateway.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";

const handles: ServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function boot(script: Parameters<typeof createFakeAdapter>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "openbot-conversation-runtime-"));
  roots.push(root);
  const registry = createProviderRegistry();
  const adapter = createFakeAdapter("xai", script);
  registry.register(adapter);
  const handle = await startServer(0, {
    stateRoot: root,
    disableAgentHome: true,
    registry,
    allowUnauthenticatedLocalGateway: true,
  });
  if (!handle.config.snapshot().agents.some((agent) => agent.id === "openbot-default")) {
    handle.config.update({ agents: [{ id: "openbot-default", name: "Default", avatarId: "avatar-default" }] });
    handle.conversationStore.ensureDefault("openbot-default");
  }
  handles.push(handle);
  return { handle, adapter, root };
}

function rpcContext(handle: ServerHandle, events: Array<{ channel: string; payload: unknown }>) {
  return {
    getStatus: () => handle.runner.getStatus(),
    publish: (channel: string, payload: unknown) => events.push({ channel, payload }),
    method: "test",
  };
}

function turnInvocations(adapter: { invocations: Array<{ req: { purpose?: string } }> }) {
  return adapter.invocations.filter((invocation): invocation is { req: { purpose?: string; messages: unknown[] } } => (
    (invocation.req.purpose ?? "turn") === "turn"
  ));
}

describe("conversation-aware turn runtime", () => {
  it("keeps provider history and live entries partitioned by conversation", async () => {
    const { handle, adapter } = await boot({ deltas: ["ok"] });
    const agentId = "openbot-default";
    const first = handle.conversationStore.getActive(agentId)!;
    handle.runner.sendPrompt({ agentId, conversationId: first.id, prompt: "alpha" });
    await handle.runner.flush(agentId);

    const second = handle.conversationStore.create(agentId, { title: "Segunda" });
    handle.runner.sendPrompt({ agentId, conversationId: second.id, prompt: "beta" });
    await handle.runner.flush(agentId);

    const turns = turnInvocations(adapter);
    expect(turns).toHaveLength(2);
    expect(adapter.invocations.every((invocation) => ["turn", "memory-reflection", undefined].includes(invocation.req.purpose))).toBe(true);
    expect(JSON.stringify(turns[1]!.req.messages)).toContain("beta");
    expect(JSON.stringify(turns[1]!.req.messages)).not.toContain("alpha");
    expect(handle.store.getEntries(agentId, first.id).some((entry) => entry.kind === "message" && entry.content === "beta")).toBe(false);
    expect(handle.store.getEntries(agentId, second.id).some((entry) => entry.kind === "message" && entry.content === "alpha")).toBe(false);
  });

  it("routes reflection through the same process-wide admission singleton", async () => {
    const { handle, adapter } = await boot({ deltas: ["ok"] });
    const agentId = "openbot-default";
    const conversationId = handle.conversationStore.getActive(agentId)!.id;
    handle.runner.sendPrompt({ agentId, conversationId, prompt: "registre esta observação" });
    await handle.runner.flush(agentId);
    for (let attempt = 0; attempt < 50 && (!adapter.invocations.some((invocation) => invocation.req.purpose === "memory-reflection") || handle.providerAdmission.metrics().active !== 0); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(adapter.invocations.some((invocation) => invocation.req.purpose === "memory-reflection")).toBe(true);
    expect(handle.providerAdmission.metrics()).toMatchObject({ active: 0, waiting: 0 });
    expect(handle.providerAdmission.metrics().admitted).toBeGreaterThanOrEqual(2);
  });

  it("scopes the same client nonce independently to each conversation", async () => {
    const { handle, adapter } = await boot({ deltas: ["ok"] });
    const agentId = "openbot-default";
    const first = handle.conversationStore.getActive(agentId)!;
    handle.runner.sendPrompt({ agentId, conversationId: first.id, prompt: "first", clientNonce: "same-nonce" });
    await handle.runner.flush(agentId);
    const second = handle.conversationStore.create(agentId, { title: "Segunda" });
    handle.runner.sendPrompt({ agentId, conversationId: second.id, prompt: "second", clientNonce: "same-nonce" });
    await handle.runner.flush(agentId);

    expect(turnInvocations(adapter)).toHaveLength(2);
    expect(handle.runner.acceptanceStatus(agentId, "same-nonce", first.id).outcome).toBe("found");
    expect(handle.runner.acceptanceStatus(agentId, "same-nonce", second.id).outcome).toBe("found");
    expect(() => handle.runner.acceptanceStatus(agentId, "same-nonce")).toThrow(/ambíguo/i);
  });

  it("rejects stale conversation sends and publishes a snapshot on RPC activation", async () => {
    const { handle } = await boot({ deltas: ["ok"] });
    const agentId = "openbot-default";
    const first = handle.conversationStore.getActive(agentId)!;
    const second = handle.conversationStore.create(agentId, { title: "Segunda" });
    const events: Array<{ channel: string; payload: unknown }> = [];
    handle.runner.setPublish((channel, payload) => events.push({ channel, payload }));
    const activate = handle.gateway.listHandlers().get("activateConversation")!;
    await activate({ agentId, conversationId: second.id }, rpcContext(handle, events));
    expect(events.at(-1)?.payload).toMatchObject({ type: "snapshot", agentId, conversationId: second.id, entries: [] });
    expect(() => handle.runner.sendPrompt({ agentId, conversationId: first.id, prompt: "stale" })).toThrow(/ativa/i);
  });

  it("allows activation while busy but keeps destructive mutation blocked", async () => {
    const { handle } = await boot({ deltas: ["one", "two"], deltaDelayMs: 40 });
    const agentId = "openbot-default";
    const first = handle.conversationStore.getActive(agentId)!;
    const second = handle.conversationStore.create(agentId, { title: "Segunda" });
    handle.runner.sendPrompt({ agentId, conversationId: second.id, prompt: "busy" });
    const activate = handle.gateway.listHandlers().get("activateConversation")!;
    expect(activate({ agentId, conversationId: first.id }, rpcContext(handle, []))).toMatchObject({
      conversation: { id: first.id },
    });
    const rename = handle.gateway.listHandlers().get("renameConversation")!;
    expect(() => rename({ agentId, conversationId: second.id, title: "não agora" }, rpcContext(handle, []))).toThrow(/ocupado/i);
    await handle.runner.flush(agentId);
    expect(handle.store.getEntries(agentId, second.id)).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
    }));
    expect(handle.store.getEntries(agentId, first.id)).not.toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
    }));
  });

  it("retries the failure in its original conversation after switching chats", async () => {
    const { handle, adapter } = await boot({ deltas: ["retry-ok"] });
    const agentId = "openbot-default";
    const first = handle.conversationStore.getActive(agentId)!;
    handle.store.append(agentId, [{
      kind: "message",
      id: "failed-user",
      role: "user",
      content: "retry me",
      timestampMs: 1,
      turnId: "turn:failed",
      clientNonce: "nonce:failed",
      fromUser: { name: "Usuário", authId: "local" },
    }], first.id);
    handle.store.append(agentId, [{
      kind: "notice",
      id: "failed-notice",
      type: "provider-error",
      level: "error",
      retryable: true,
      turnId: "turn:failed",
      provider: "xai",
      model: "grok-4.6",
      clientNonce: "nonce:failed",
    }], first.id);
    const second = handle.conversationStore.create(agentId, { title: "Segunda" });
    handle.conversationStore.activate(agentId, second.id);
    handle.runner.retryPrompt(agentId);
    await handle.runner.flush(agentId);
    expect(turnInvocations(adapter)).toHaveLength(1);
    expect(handle.store.getEntries(agentId, first.id)).toContainEqual(expect.objectContaining({ type: "retry-attempt", retryFailureTurnId: "turn:failed" }));
    expect(handle.store.getEntries(agentId, second.id)).toEqual([]);
  });

  it("rejects explicit archived retries and still retries the latest live failure", async () => {
    const { handle, adapter } = await boot({ deltas: ["retry-ok"] });
    const agentId = "openbot-default";
    const archived = handle.conversationStore.getActive(agentId)!;
    const live = handle.conversationStore.create(agentId, { title: "Live" });
    handle.store.append(agentId, [{
      kind: "message",
      id: "archived-user",
      role: "user",
      content: "retry archived",
      timestampMs: 1,
      turnId: "turn:archived",
      clientNonce: "nonce:archived",
      fromUser: { name: "Usuário", authId: "local" },
    }, {
      kind: "notice",
      id: "archived-notice",
      type: "provider-error",
      level: "error",
      retryable: true,
      turnId: "turn:archived",
      provider: "xai",
      model: "grok-4.6",
      clientNonce: "nonce:archived",
    }], archived.id);
    handle.conversationStore.archive(agentId, archived.id);
    handle.conversationStore.activate(agentId, live.id);
    handle.store.append(agentId, [{
      kind: "message",
      id: "live-user",
      role: "user",
      content: "retry live",
      timestampMs: 2,
      turnId: "turn:live",
      clientNonce: "nonce:live",
      fromUser: { name: "Usuário", authId: "local" },
    }, {
      kind: "notice",
      id: "live-notice",
      type: "provider-error",
      level: "error",
      retryable: true,
      turnId: "turn:live",
      provider: "xai",
      model: "grok-4.6",
      clientNonce: "nonce:live",
    }], live.id);

    expect(() => handle.runner.retryPrompt(agentId, archived.id)).toThrow(/arquivada/i);

    handle.runner.retryPrompt(agentId);
    await handle.runner.flush(agentId);

    expect(turnInvocations(adapter)).toHaveLength(1);
    expect(handle.store.getEntries(agentId, live.id)).toContainEqual(expect.objectContaining({
      kind: "notice",
      type: "retry-attempt",
      retryFailureTurnId: "turn:live",
    }));
    expect(handle.store.getEntries(agentId, archived.id).some((entry) => (
      entry.kind === "notice" && entry.type === "retry-attempt"
    ))).toBe(false);
  });

  it("persists the active conversation across a restart", async () => {
    const firstBoot = await boot({ deltas: ["ok"] });
    const agentId = "openbot-default";
    const second = firstBoot.handle.conversationStore.create(agentId, { title: "Segunda" });
    firstBoot.handle.conversationStore.activate(agentId, second.id);
    const root = firstBoot.root;
    const handle = handles.pop()!;
    await stopServer(handle);
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", { deltas: ["ok"] }));
    const restarted = await startServer(0, { stateRoot: root, disableAgentHome: true, registry, allowUnauthenticatedLocalGateway: true });
    handles.push(restarted);
    expect(restarted.conversationStore.getActive(agentId)?.id).toBe(second.id);
  });

  it("round-trips memory partitions, active state, tools, and nonce bindings", () => {
    const store = createMemoryTranscriptStore();
    const conversations = store.conversationStore!;
    const agentId = "memory-agent";
    const first = conversations.ensureDefault(agentId);
    const second = conversations.create!(agentId, { title: "Segunda" });
    store.append(agentId, [{ kind: "message", id: "first", role: "user", content: "um", timestampMs: 1 }], first.id);
    store.append(agentId, [{ kind: "tool-call", id: "tool-first", name: "one", summary: "one", status: "running", localToolCallId: "local-first" }], first.id);
    store.append(agentId, [{ kind: "message", id: "second", role: "user", content: "dois", timestampMs: 2 }], second.id);
    store.rememberAcceptedNonce(agentId, "same", first.id);
    store.rememberAcceptedNonce(agentId, "same", second.id);
    const snapshot = store.snapshotAgent!(agentId);

    store.clear(agentId);
    store.restoreAgent!(agentId, snapshot);
    expect(store.getEntries(agentId, first.id)).toContainEqual(expect.objectContaining({ id: "first" }));
    expect(store.getEntries(agentId, second.id)).toContainEqual(expect.objectContaining({ id: "second" }));
    expect(store.findToolCallByLocalId!(agentId, "local-first", first.id)).toMatchObject({ id: "tool-first" });
    expect(store.getActiveConversationId!(agentId)).toBe(second.id);
    expect(store.findAcceptedNonceConversations!(agentId, "same")).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it("createConversation RPC makes the new chat active and publishes an empty snapshot", async () => {
    const { handle } = await boot({ deltas: ["ok"] });
    const agentId = "openbot-default";
    const first = handle.conversationStore.getActive(agentId)!;
    handle.store.append(agentId, [{
      kind: "message",
      id: "seed",
      role: "user",
      content: "primeira",
      timestampMs: 1,
    }], first.id);
    const events: Array<{ channel: string; payload: unknown }> = [];
    handle.runner.setPublish((channel, payload) => events.push({ channel, payload }));
    const create = handle.gateway.listHandlers().get("createConversation")!;
    const created = await create({ agentId, title: "Nova" }, rpcContext(handle, events)) as {
      conversation: { id: string; title: string; titleSource: string };
    };
    expect(created).toMatchObject({
      conversation: { title: "Nova", titleSource: "manual" },
    });
    expect(handle.conversationStore.getActive(agentId)?.id).toBe(created.conversation.id);
    expect(events.at(-1)?.payload).toMatchObject({
      type: "snapshot",
      agentId,
      conversationId: created.conversation.id,
      entries: [],
    });
  });

  it("uses the injected SQLite store connection for conversations", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-injected-store-"));
    roots.push(root);
    const injected = new SqliteTranscriptStore({ path: ":memory:" });
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["ok"] });
    registry.register(adapter);
    const handle = await startServer(0, {
      stateRoot: root,
      disableAgentHome: true,
      registry,
      allowUnauthenticatedLocalGateway: true,
      store: injected,
    });
    handles.push(handle);
    handle.config.update({ agents: [{ id: "injected", name: "Injected", avatarId: "avatar-injected" }] });
    const active = handle.conversationStore.ensureDefault("injected");
    handle.runner.sendPrompt({ agentId: "injected", conversationId: active.id, prompt: "same db" });
    await handle.runner.flush("injected");
    expect(handle.conversationStore).toBe(injected.conversationStore);
    expect(injected.getEntries("injected", active.id)).toContainEqual(expect.objectContaining({ content: "same db" }));
    expect(handle.conversationStore.getActive("injected")?.id).toBe(active.id);
    const getActive = handle.gateway.listHandlers().get("getActiveConversation")!;
    expect(getActive({ agentId: "injected" }, rpcContext(handle, []))).toMatchObject({ id: active.id });
  });

  it("normalizes acceptance-status body and missing conversation errors in SQLite and memory", async () => {
    const { handle } = await boot({ deltas: ["ok"] });
    const sqliteHandler = handle.gateway.listHandlers().get("promptAcceptanceStatus")!;
    expect(() => sqliteHandler(null, rpcContext(handle, []))).toThrow(/corpo deve ser um objeto/i);
    let sqliteError: unknown;
    try {
      sqliteHandler({ agentId: "openbot-default", clientNonce: "missing", conversationId: "no-such-chat" }, rpcContext(handle, []));
    } catch (error) {
      sqliteError = error;
    }
    expect(sqliteError).toMatchObject({ status: 404 });

    const memory = createMemoryTranscriptStore();
    memory.conversationStore!.ensureDefault("memory-status");
    const memoryGateway = new Gateway();
    const { runner } = registerRpcHandlers(memoryGateway, { store: memory });
    const memoryHandler = memoryGateway.listHandlers().get("promptAcceptanceStatus")!;
    expect(() => memoryHandler(null, {
      getStatus: () => runner.getStatus(),
      publish: () => undefined,
      method: "promptAcceptanceStatus",
    })).toThrow(/corpo deve ser um objeto/i);
    let memoryError: unknown;
    try {
      memoryHandler({ agentId: "memory-status", clientNonce: "missing", conversationId: "no-such-chat" }, {
        getStatus: () => runner.getStatus(),
        publish: () => undefined,
        method: "promptAcceptanceStatus",
      });
    } catch (error) {
      memoryError = error;
    }
    expect(memoryError).toMatchObject({ status: 404 });
  });
});
