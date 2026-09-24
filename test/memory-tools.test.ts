import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { ContextAssembler, executeMemoryForgetTool, executeMemoryRememberTool, executeMemorySearchTool, MEMORY_FORGET_TOOL_NAME, MEMORY_REMEMBER_TOOL_NAME, MEMORY_SEARCH_TOOL_NAME, MEMORY_TOOL_RESULT_LIMIT_BYTES, OPENBOT_UNTRUSTED_MEMORY_CONTEXT_BEGIN } from "../src/memory/context.js";
import { createGateway } from "../src/server/gateway.js";
import { registerRpcHandlers } from "../src/rpc/index.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { USER_PROFILE_AGENT_ID } from "../src/memory/types.js";

function createTranscriptStore(): SqliteTranscriptStore {
  return new SqliteTranscriptStore({ path: ":memory:" });
}

function callRpc(gateway: ReturnType<typeof createGateway>, method: string, body: unknown): Promise<unknown> | unknown {
  const handler = gateway.listHandlers().get(method);
  if (!handler) throw new Error(`handler ausente: ${method}`);
  return handler(body, {
    method,
    getStatus: () => ({ isBusy: false, activeAgentId: null }),
    publish: () => undefined,
  });
}


describe("memory context integration", () => {

  it("injects identity, preference, and constraint memories in Core memories without prompt overlap", () => {
    const store = createTranscriptStore();
    const currentConversation = store.conversationStore.create("agent-a").id;
    const otherConversation = store.conversationStore.create("agent-a").id;
    store.memoryStore.setSettings("agent-a", "automatic");
    store.memoryStore.upsertMemory("agent-a", {
      kind: "preference",
      canonicalKey: "core-preference",
      text: "prefers zzzqxp silent mode always",
      trust: "external_observation",
      sourceConversationId: otherConversation,
    }, { kind: "admin" });
    store.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "core-fact",
      text: "project uses qxwmrt build pipeline",
      trust: "external_observation",
      sourceConversationId: otherConversation,
    }, { kind: "admin" });

    const assembled = new ContextAssembler().assemble({
      agentId: "agent-a",
      conversationId: currentConversation,
      prompt: "explain the weather today",
      recentStore: store,
      memoryStore: store.memoryStore,
      mode: "automatic",
      conversation: { temporary: false },
      systemText: "",
      toolText: "",
    });
    const contextMessage = assembled.messages.find((message) => (
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes(OPENBOT_UNTRUSTED_MEMORY_CONTEXT_BEGIN)
    ));
    expect(contextMessage).toBeDefined();
    const content = String(contextMessage?.content);
    expect(content).toContain("Core memories");
    expect(content).toContain("zzzqxp silent mode");
    expect(content).not.toContain("qxwmrt build pipeline");
    store.close();
  });

  it("updates an existing memory on repeated remember and forgets by canonicalKey", async () => {
    const store = createTranscriptStore();
    const conversationId = store.conversationStore.create("agent-a").id;
    store.memoryStore.setSettings("agent-a", "automatic");
    const rememberOptions = {
      memoryStore: store.memoryStore,
      mode: "automatic" as const,
      agentId: "agent-a",
      conversation: { temporary: false },
      conversationId,
      sourceEntryId: "user-entry-1",
      explicitIntent: true,
    };
    const remember = (text: string) => executeMemoryRememberTool({
      agentId: "agent-a",
      call: {
        id: `remember-${text.length}`,
        type: "function" as const,
        function: {
          name: MEMORY_REMEMBER_TOOL_NAME,
          arguments: JSON.stringify({ kind: "fact", canonicalKey: "release-check", text }),
        },
      },
    }, rememberOptions);
    const forget = (canonicalKey: string) => executeMemoryForgetTool({
      agentId: "agent-a",
      call: {
        id: "forget-release-check",
        type: "function" as const,
        function: {
          name: MEMORY_FORGET_TOOL_NAME,
          arguments: JSON.stringify({ canonicalKey }),
        },
      },
    }, { ...rememberOptions, explicitIntent: false, explicitForgetIntent: true });

    const first = await remember("First release note.");
    expect(first).toEqual(expect.objectContaining({ handled: true, ok: true }));
    if (!first.handled) throw new Error("memory_remember was not handled");
    expect(JSON.parse(String(first.content))).toMatchObject({ saved: true, updated: false });

    const second = await remember("Second release note.");
    expect(second).toEqual(expect.objectContaining({ handled: true, ok: true }));
    if (!second.handled) throw new Error("memory_remember was not handled");
    expect(JSON.parse(String(second.content))).toMatchObject({ saved: true, updated: true });
    expect(store.memoryStore.listMemories("agent-a")).toEqual([
      expect.objectContaining({
        canonicalKey: "release-check",
        text: "Second release note.",
        revision: 2,
        trust: "user",
        pinned: false,
      }),
    ]);

    const forgotten = await forget("release-check");
    expect(forgotten).toEqual(expect.objectContaining({ handled: true, ok: true }));
    expect(store.memoryStore.listMemories("agent-a")).toEqual([]);
    expect(store.memoryStore.listMemories("agent-a", { includeInactive: true })).toEqual([
      expect.objectContaining({ canonicalKey: "release-check", status: "forgotten" }),
    ]);

    const missing = await forget("missing-key");
    expect(missing).toEqual(expect.objectContaining({
      handled: true,
      ok: false,
      result: expect.objectContaining({ code: "not_found" }),
    }));
    store.close();
  });

  it("keeps a recreated memory updatable by the tool, also across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-memory-recreate-"));
    try {
      const dbPath = join(dir, "store.db");
      const remember = (store: SqliteTranscriptStore, conversationId: string, text: string) => executeMemoryRememberTool({
        agentId: "agent-a",
        call: {
          id: `remember-${text}`,
          type: "function" as const,
          function: {
            name: MEMORY_REMEMBER_TOOL_NAME,
            arguments: JSON.stringify({ kind: "preference", canonicalKey: "coffee-order", text }),
          },
        },
      }, {
        memoryStore: store.memoryStore,
        mode: "automatic" as const,
        agentId: "agent-a",
        conversation: { temporary: false },
        conversationId,
        sourceEntryId: "user-entry-1",
        explicitIntent: true,
      });
      const forget = (store: SqliteTranscriptStore, conversationId: string) => executeMemoryForgetTool({
        agentId: "agent-a",
        call: {
          id: "forget-coffee-order",
          type: "function" as const,
          function: {
            name: MEMORY_FORGET_TOOL_NAME,
            arguments: JSON.stringify({ canonicalKey: "coffee-order" }),
          },
        },
      }, {
        memoryStore: store.memoryStore,
        mode: "automatic" as const,
        agentId: "agent-a",
        conversation: { temporary: false },
        conversationId,
        sourceEntryId: "user-entry-1",
        explicitIntent: false,
        explicitForgetIntent: true,
      });

      const first = new SqliteTranscriptStore({ path: dbPath });
      first.memoryStore.setSettings("agent-a", "automatic");
      const conversationId = first.conversationStore.create("agent-a").id;

      const saved = await remember(first, conversationId, "Prefiro café sem açúcar.");
      expect(saved).toEqual(expect.objectContaining({ handled: true, ok: true }));
      if (!saved.handled) throw new Error("memory_remember was not handled");
      const savedId = JSON.parse(String(saved.content)).id as string;

      expect(await forget(first, conversationId)).toEqual(expect.objectContaining({ handled: true, ok: true }));

      const recreated = await remember(first, conversationId, "Prefiro café com leite.");
      expect(recreated).toEqual(expect.objectContaining({ handled: true, ok: true }));
      if (!recreated.handled) throw new Error("memory_remember was not handled");
      const recreatedId = JSON.parse(String(recreated.content)).id as string;
      expect(recreatedId).not.toBe(savedId);
      first.close();

      const second = new SqliteTranscriptStore({ path: dbPath });
      second.memoryStore.setSettings("agent-a", "automatic");
      const updated = await remember(second, conversationId, "Prefiro chá.");
      expect(updated).toEqual(expect.objectContaining({ handled: true, ok: true }));
      if (!updated.handled) throw new Error("memory_remember was not handled");
      expect(JSON.parse(String(updated.content))).toMatchObject({ saved: true, updated: true, id: recreatedId });

      expect(second.memoryStore.listMemories("agent-a")).toEqual([
        expect.objectContaining({ id: recreatedId, canonicalKey: "coffee-order", text: "Prefiro chá.", revision: 2 }),
      ]);
      expect(second.memoryStore.listMemories("agent-a", { includeInactive: true })).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: savedId, status: "forgotten", text: "Prefiro café sem açúcar." }),
      ]));
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets an explicit forget request retire a trust:user memory, while automatic authority stays blocked", async () => {
    const store = createTranscriptStore();
    const conversationId = store.conversationStore.create("agent-a").id;
    store.memoryStore.setSettings("agent-a", "automatic");
    const saved = store.memoryStore.upsertMemory("agent-a", {
      kind: "preference",
      canonicalKey: "coffee-order",
      text: "O usuário prefere café sem açúcar.",
      valueJson: null,
      trust: "user",
      sourceConversationId: conversationId,
      sourceEntryIds: [{ conversationId, entryId: "user-entry-1" }],
    }, { kind: "user" });

    const forget = (options: { explicitIntent: boolean; explicitForgetIntent?: boolean }) => executeMemoryForgetTool({
      agentId: "agent-a",
      call: {
        id: "forget-coffee",
        type: "function" as const,
        function: {
          name: MEMORY_FORGET_TOOL_NAME,
          arguments: JSON.stringify({ canonicalKey: "coffee-order" }),
        },
      },
    }, {
      memoryStore: store.memoryStore,
      mode: "automatic",
      agentId: "agent-a",
      conversation: { temporary: false },
      conversationId,
      sourceEntryId: "user-entry-2",
      explicitIntent: options.explicitIntent,
      explicitForgetIntent: options.explicitForgetIntent,
    });

    const automaticBlocked = await forget({ explicitIntent: false });
    expect(automaticBlocked).toEqual(expect.objectContaining({ handled: true, ok: false }));
    expect(store.memoryStore.getMemory("agent-a", saved.id)).toMatchObject({ status: "active" });

    const rememberIntentOnly = await forget({ explicitIntent: true });
    expect(rememberIntentOnly).toEqual(expect.objectContaining({ handled: true, ok: false }));
    expect(store.memoryStore.getMemory("agent-a", saved.id)).toMatchObject({ status: "active" });

    const explicitForget = await forget({ explicitIntent: false, explicitForgetIntent: true });
    expect(explicitForget).toEqual(expect.objectContaining({ handled: true, ok: true }));
    expect(store.memoryStore.getMemory("agent-a", saved.id)).toMatchObject({ status: "forgotten" });
    store.close();
  });

  it("bounds memory_search output and isolates results by agent", async () => {
    const store = createTranscriptStore();
    const conversationId = store.conversationStore.create("agent-a").id;
    store.memoryStore.setSettings("agent-a", "automatic");
    for (let index = 0; index < 12; index += 1) {
      store.memoryStore.upsertMemory("agent-a", {
        kind: "fact",
        canonicalKey: `alpha-${index}`,
        text: `alpha evidence ${index} ${"z".repeat(3_000)}`,
        trust: "verified_tool",
        sourceConversationId: conversationId,
      }, { kind: "admin" });
    }
    store.memoryStore.upsertMemory("agent-b", {
      kind: "fact",
      canonicalKey: "beta",
      text: "beta secret",
      trust: "verified_tool",
    }, { kind: "admin" });
    const result = await executeMemorySearchTool({
      agentId: "agent-a",
      call: {
        id: "call-1",
        type: "function",
        function: { name: MEMORY_SEARCH_TOOL_NAME, arguments: JSON.stringify({ query: "alpha", limit: 8 }) },
      },
    }, {
      memoryStore: store.memoryStore,
      mode: "automatic",
      agentId: "agent-a",
      conversation: { temporary: false },
    });
    expect(result.handled).toBe(true);
    if (!result.handled) throw new Error("memory_search should have been handled");
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MEMORY_TOOL_RESULT_LIMIT_BYTES);
    expect(result.content).toContain("alpha");
    expect(result.content).not.toContain("beta secret");
    store.close();
  });

  it("keeps the agent's own memory ahead of shared profile hits under tight limits", async () => {
    const store = createTranscriptStore();
    const conversationId = store.conversationStore.create("agent-a").id;
    store.memoryStore.setSettings("agent-a", "automatic");
    store.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
      kind: "preference",
      canonicalKey: "coffee-profile",
      text: "PROFILE coffee answer: black",
      trust: "user",
      sourceConversationId: conversationId,
    }, { kind: "admin" });
    store.memoryStore.upsertMemory("agent-a", {
      kind: "fact",
      canonicalKey: "coffee-agent",
      text: "AGENT coffee budget: 500",
      trust: "verified_tool",
      sourceConversationId: conversationId,
    }, { kind: "admin" });

    const search = async (args: Record<string, unknown>) => {
      const result = await executeMemorySearchTool({
        agentId: "agent-a",
        call: {
          id: "call-limited",
          type: "function",
          function: { name: MEMORY_SEARCH_TOOL_NAME, arguments: JSON.stringify(args) },
        },
      }, {
        memoryStore: store.memoryStore,
        mode: "automatic",
        agentId: "agent-a",
        conversation: { temporary: false },
      });
      if (!result.handled) throw new Error("memory_search should have been handled");
      return result;
    };

    const limited = await search({ query: "coffee", limit: 1 });
    expect(limited.ok).toBe(true);
    expect(limited.content).toContain("AGENT coffee budget");
    expect(limited.content).not.toContain("PROFILE coffee answer");

    const wider = await search({ query: "coffee", limit: 3 });
    expect(wider.content).toContain("AGENT coffee budget");
    expect(wider.content).toContain("PROFILE coffee answer");
    store.close();
  });

  it("exposes bounded memory RPCs and sanitizes job status", async () => {
    const store = createTranscriptStore();
    const conversationId = store.conversationStore.create("agent-a").id;
    const configRoot = mkdtempSync(join(tmpdir(), "openbot-memory-rpc-"));
    const config = new ConfigStore({ configPath: join(configRoot, "config.json") });
    config.update({ agents: [{ id: "agent-a", name: "Agent A", avatarId: "avatar-a" }] });
    const gateway = createGateway();
    registerRpcHandlers(gateway, { store, config });

    try {
      await callRpc(gateway, "setMemorySettings", { agentId: "agent-a", mode: "automatic" });
      const memory = store.memoryStore.upsertMemory("agent-a", {
        kind: "fact",
        canonicalKey: "rpc-memory",
        text: "valor inicial",
        trust: "verified_tool",
        sourceConversationId: conversationId,
      }, { kind: "admin" });
      for (let index = 0; index < 2; index += 1) {
        store.memoryStore.upsertMemory("agent-a", {
          kind: "fact",
          canonicalKey: `rpc-page-${index}`,
          text: `valor paginado ${index}`,
          trust: "verified_tool",
          sourceConversationId: conversationId,
        }, { kind: "admin" });
      }
      store.memoryStore.upsertSummary("agent-a", {
        conversationId,
        throughSequenceId: 1,
        summaryJson: {},
        renderedText: "resumo rpc",
      });
      const job = store.memoryStore.enqueueJob({
        agentId: "agent-a",
        conversationId,
        fromSequenceId: 0,
        throughSequenceId: 1,
      });
      store.memoryStore.claimJob("agent-a", job.id);
      store.memoryStore.deadJob("agent-a", job.id, { code: "reflection_failed", text: "detalhe interno" });

      const firstMemoryPage = await callRpc(gateway, "listMemoriesPage", {
        agentId: "agent-a",
        includeInactive: true,
        limit: 2,
      }) as { items: Array<{ id: string }>; nextCursor?: string };
      expect(firstMemoryPage.items).toHaveLength(2);
      expect(firstMemoryPage.nextCursor).toEqual(expect.any(String));
      const secondMemoryPage = await callRpc(gateway, "listMemoriesPage", {
        agentId: "agent-a",
        includeInactive: true,
        limit: 2,
        cursor: firstMemoryPage.nextCursor,
      }) as { items: Array<{ id: string }>; nextCursor?: string };
      expect(secondMemoryPage.items).toHaveLength(1);
      expect(secondMemoryPage.items.some((item) => firstMemoryPage.items.some((first) => first.id === item.id))).toBe(false);

      const legacyList = await callRpc(gateway, "listMemories", { agentId: "agent-a", includeInactive: true }) as Array<Record<string, unknown>>;
      expect(legacyList).not.toHaveLength(0);
      expect(legacyList[0]).not.toHaveProperty("canonicalKey");
      expect(legacyList[0]).not.toHaveProperty("valueJson");
      expect(legacyList[0]).not.toHaveProperty("sourceEntryIds");
      expect(legacyList[0]).not.toHaveProperty("revision");
      expect(legacyList[0]).toHaveProperty("scope", "agent");

      store.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
        kind: "preference",
        canonicalKey: "rpc-profile",
        text: "idioma preferido",
        trust: "user",
        sourceConversationId: null,
      }, { kind: "admin" });
      const profileList = await callRpc(gateway, "listMemories", { agentId: "agent-a", scope: "user" }) as Array<Record<string, unknown>>;
      expect(profileList[0]).toHaveProperty("scope", "user");

      const updated = await callRpc(gateway, "updateMemory", { agentId: "agent-a", memoryId: memory.id, text: "valor editado", pinned: true });
      expect((updated as { text: string; trust: string; pinned: boolean }).text).toBe("valor editado");
      expect((updated as { text: string; trust: string; pinned: boolean }).trust).toBe("user");
      expect((updated as { text: string; trust: string; pinned: boolean }).pinned).toBe(true);
      expect(updated).not.toHaveProperty("sourceEntryIds");
      expect(updated).not.toHaveProperty("revision");

      const history = await callRpc(gateway, "searchMemoryHistory", { agentId: "agent-a", query: "valor", limit: 5 }) as Array<Record<string, any>>;
      expect(Array.isArray(history)).toBe(true);
      expect(history.find((item) => item.memory)?.memory).not.toHaveProperty("canonicalKey");
      expect(history.find((item) => item.memory)?.memory).not.toHaveProperty("sourceEntryIds");
      const summaryHistory = await callRpc(gateway, "searchMemoryHistory", { agentId: "agent-a", query: "resumo", limit: 5 }) as Array<Record<string, any>>;
      expect(summaryHistory.find((item) => item.summary)?.summary).not.toHaveProperty("summaryJson");

      const status = await callRpc(gateway, "getMemoryStatus", { agentId: "agent-a", conversationId }) as {
        settings: { mode: string };
        summary: { conversationId: string; renderedTextBytes: number } | null;
        counts: { jobs: { dead: number } };
        jobs: { dead: Array<{ lastErrorCode: string | null; lastErrorText?: string }>; deadCount: number };
      };
      expect(status.settings.mode).toBe("automatic");
      expect(status.summary?.conversationId).toBe(conversationId);
      expect(status.summary?.renderedTextBytes).toBeGreaterThan(0);
      expect(status.counts.jobs.dead).toBe(1);
      expect(status.jobs.deadCount).toBe(1);
      expect(status.jobs.dead[0]?.lastErrorCode).toBe("reflection_failed");
      expect("lastErrorText" in (status.jobs.dead[0] ?? {})).toBe(false);

      const deleted = await callRpc(gateway, "deleteMemory", { agentId: "agent-a", memoryId: memory.id });
      expect(deleted).not.toHaveProperty("sourceEntryIds");
      expect(deleted).not.toHaveProperty("revision");
      expect(store.memoryStore.getMemory("agent-a", memory.id)?.status).toBe("forgotten");

      const profileMemory = store.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
        kind: "identity",
        canonicalKey: "rpc-profile-name",
        text: "nome perfil rpc",
        trust: "verified_tool",
      }, { kind: "admin" });
      store.memoryStore.upsertMemory("agent-a", {
        kind: "fact",
        canonicalKey: "rpc-bot-only",
        text: "só do bot",
        trust: "verified_tool",
        sourceConversationId: conversationId,
      }, { kind: "admin" });
      const userScopePage = await callRpc(gateway, "listMemoriesPage", {
        agentId: "agent-a",
        scope: "user",
        includeInactive: true,
        limit: 50,
      }) as { items: Array<{ id: string; text: string }> };
      expect(userScopePage.items.some((item) => item.id === profileMemory.id)).toBe(true);
      expect(userScopePage.items.some((item) => item.text === "só do bot")).toBe(false);
      await expect(() => callRpc(gateway, "listMemoriesPage", { agentId: "agent-a", scope: "bogus" })).toThrow(/scope inválido/i);
    } finally {
      config.close();
      store.close();
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it("rejects ghost agents and stale ownership before touching memory rows", async () => {
    const store = createTranscriptStore();
    const configRoot = mkdtempSync(join(tmpdir(), "openbot-memory-ownership-"));
    const config = new ConfigStore({ configPath: join(configRoot, "config.json") });
    config.update({ agents: [{ id: "agent-a", name: "Agent A", avatarId: "avatar-a" }] });
    const conversationId = store.conversationStore.create("agent-a").id;
    const otherConversationId = store.conversationStore.create("agent-b").id;
    const gateway = createGateway();
    registerRpcHandlers(gateway, { store, config });
    try {
      await expect(() => callRpc(gateway, "getMemorySettings", { agentId: "ghost" })).toThrow(/agente não encontrado/i);
      await expect(() => callRpc(gateway, "setMemorySettings", { agentId: "ghost", mode: "automatic" })).toThrow(/agente não encontrado/i);
      expect(store.memoryStore.snapshotAgent("ghost").settings).toBeNull();

      await expect(() => callRpc(gateway, "getMemoryStatus", { agentId: "agent-a", conversationId: otherConversationId })).toThrow(/conversation não encontrada para o agente/i);

      await callRpc(gateway, "setMemorySettings", { agentId: "agent-a", mode: "automatic" });
      config.update({ agents: [] });
      await expect(() => callRpc(gateway, "getMemorySettings", { agentId: "agent-a" })).toThrow(/agente não encontrado/i);
      await expect(() => callRpc(gateway, "setMemorySettings", { agentId: "agent-a", mode: "off" })).toThrow(/agente não encontrado/i);
      expect(store.memoryStore.getSummary("agent-a", conversationId)).toBeNull();
    } finally {
      config.close();
      store.close();
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it("reports exact memory and job aggregates without returning a huge dead payload", async () => {
    const store = createTranscriptStore();
    const configRoot = mkdtempSync(join(tmpdir(), "openbot-memory-status-"));
    const config = new ConfigStore({ configPath: join(configRoot, "config.json") });
    config.update({ agents: [{ id: "agent-a", name: "Agent A", avatarId: "avatar-a" }] });
    const conversationId = store.conversationStore.create("agent-a").id;
    const gateway = createGateway();
    registerRpcHandlers(gateway, { store, config });
    try {
      for (let index = 0; index < 501; index += 1) {
        store.memoryStore.upsertMemory("agent-a", {
          kind: "fact",
          canonicalKey: `memory-${index}`,
          text: `memória ${index}`,
          trust: "verified_tool",
          pinned: index < 17,
          sourceConversationId: conversationId,
        }, { kind: "admin" });
      }
      const forgotten = store.memoryStore.upsertMemory("agent-a", {
        kind: "fact",
        canonicalKey: "memory-forgotten",
        text: "memória esquecida",
        trust: "verified_tool",
        sourceConversationId: conversationId,
      }, { kind: "admin" });
      store.memoryStore.forgetMemory("agent-a", forgotten.id, { kind: "admin" });

      for (let index = 0; index < 1005; index += 1) {
        const job = store.memoryStore.enqueueJob({
          agentId: "agent-a",
          conversationId,
          fromSequenceId: index,
          throughSequenceId: index,
        });
        if (index < 2) {
          store.memoryStore.claimJob("agent-a", job.id);
          continue;
        }
        if (index < 5) {
          store.memoryStore.claimJob("agent-a", job.id);
          store.memoryStore.retryJob("agent-a", job.id, { code: `retry-${index}`, text: `detalhe ${"x".repeat(4000)}` });
          continue;
        }
        if (index < 18) {
          store.memoryStore.claimJob("agent-a", job.id);
          store.memoryStore.deadJob("agent-a", job.id, { code: `dead-${index}`, text: `segredo ${"y".repeat(4000)}` });
        }
      }

      const status = await callRpc(gateway, "getMemoryStatus", { agentId: "agent-a", conversationId }) as {
        counts: { active: number; pinned: number; inactive: number; jobs: { pending: number; running: number; retry: number; dead: number } };
        jobs: { pending: number; running: number; retry: number; dead: Array<{ lastErrorCode: string | null; lastErrorText?: string }>; deadCount: number };
      };
      expect(status.counts).toMatchObject({
        active: 501,
        pinned: 17,
        inactive: 1,
        jobs: { pending: 1, running: 2, retry: 0, dead: 13 },
      });
      expect(status.jobs.pending).toBe(1);
      expect(status.jobs.running).toBe(2);
      expect(status.jobs.retry).toBe(0);
      expect(status.jobs.deadCount).toBe(13);
      expect(status.jobs.dead.length).toBeLessThanOrEqual(10);
      expect(JSON.stringify(status.jobs.dead)).not.toContain("yyyy");
      expect(Buffer.byteLength(JSON.stringify(status), "utf8")).toBeLessThan(8_000);
    } finally {
      config.close();
      store.close();
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it("shares user profile memories across agents while rejecting non-profile kinds in the store", () => {
    const store = createTranscriptStore();
    const conversationA = store.conversationStore.create("agent-a").id;
    store.conversationStore.create("agent-b");
    store.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
      kind: "preference",
      canonicalKey: "answer-language",
      text: "PROFILE_SHARED_LANGUAGE_PT",
      trust: "verified_tool",
      sourceConversationId: conversationA,
    }, { kind: "admin" });
    expect(() => store.memoryStore.upsertMemory(USER_PROFILE_AGENT_ID, {
      kind: "fact",
      canonicalKey: "task-fact",
      text: "should not land in profile",
      trust: "verified_tool",
      sourceConversationId: conversationA,
    }, { kind: "admin" })).toThrow(expect.objectContaining({ code: "policy" }));

    const assembled = new ContextAssembler().assemble({
      agentId: "agent-b",
      conversationId: store.conversationStore.create("agent-b").id,
      prompt: "current task for agent b",
      recentStore: store,
      memoryStore: store.memoryStore,
      mode: "automatic",
      conversation: { temporary: false },
      systemText: "",
      toolText: "",
    });
    const serialized = JSON.stringify(assembled.messages);
    expect(serialized).toContain("Shared user profile");
    expect(serialized).toContain("PROFILE_SHARED_LANGUAGE_PT");
    store.close();
  });

  it("routes memory_remember scope:user to the shared profile pseudo-agent", async () => {
    const store = createTranscriptStore();
    const conversationId = store.conversationStore.create("agent-a").id;
    store.memoryStore.setSettings("agent-a", "automatic");
    const rememberOptions = {
      memoryStore: store.memoryStore,
      mode: "automatic" as const,
      agentId: "agent-a",
      conversation: { temporary: false },
      conversationId,
      sourceEntryId: "entry-profile",
      explicitIntent: true,
    };
    const identity = await executeMemoryRememberTool({
      agentId: "agent-a",
      call: {
        id: "remember-profile-identity",
        type: "function" as const,
        function: {
          name: MEMORY_REMEMBER_TOOL_NAME,
          arguments: JSON.stringify({
            kind: "identity",
            canonicalKey: "display-name",
            text: "PROFILE_NAME_ALICE",
            scope: "user",
          }),
        },
      },
    }, rememberOptions);
    expect(identity).toEqual(expect.objectContaining({ handled: true, ok: true }));
    expect(store.memoryStore.listMemories(USER_PROFILE_AGENT_ID).map((memory) => memory.text)).toEqual(["PROFILE_NAME_ALICE"]);
    expect(store.memoryStore.listMemories("agent-a")).toEqual([]);

    const invalid = await executeMemoryRememberTool({
      agentId: "agent-a",
      call: {
        id: "remember-profile-invalid",
        type: "function" as const,
        function: {
          name: MEMORY_REMEMBER_TOOL_NAME,
          arguments: JSON.stringify({
            kind: "procedure",
            canonicalKey: "deploy-steps",
            text: "not a profile fact",
            scope: "user",
          }),
        },
      },
    }, rememberOptions);
    expect(invalid).toEqual(expect.objectContaining({
      handled: true,
      ok: false,
      result: expect.objectContaining({ code: "validation" }),
    }));
    store.close();
  });
});
