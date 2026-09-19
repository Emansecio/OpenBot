import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogService } from "../src/providers/model-catalog.js";
import { connectionFingerprint, createXaiCatalogSource, createOpenCodeCatalogSource, createCompatCatalogSource, codexCatalogPage } from "../src/providers/model-discovery.js";
import { ConfigStore } from "../src/config/store.js";
import { registerRosterHandlers } from "../src/rpc/roster.js";
import { Gateway } from "../src/server/gateway.js";
import { createTurnRunner } from "../src/rpc/send.js";
import { createProviderRegistry, type ProviderChatRequest } from "../src/providers/router.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "openbot-catalog-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const connection = connectionFingerprint("fixture-connection");

describe("model catalog", () => {
  it("persists Fast per bot and pins it across tool rounds while recording actual tiers", async () => {
    const directory = root();
    const configPath = join(directory, "config.json");
    const catalog = new ModelCatalogService({ sources: { openai: {
      connectionKey: async () => connection,
      discover: async () => [{ id: "gpt-6-astra", serviceTiers: ["priority"], supportedReasoningEfforts: ["medium", "high"] }, { id: "gpt-5.6-sol", serviceTiers: [], supportedReasoningEfforts: ["medium"] }],
    } } });
    await catalog.get("openai");
    const config = new ConfigStore({ configPath, allowUnverifiedModels: true });
    config.modelCatalog = catalog;
    config.update({ agents: ["alpha", "beta"].map(id => ({ id, name: id, avatarId: "default", provider: "openai" as const, model: "gpt-6-astra" })) });
    const store = new SqliteTranscriptStore({ path: join(directory, "store.db") });
    const gateway = new Gateway();
    registerRosterHandlers(gateway, config, undefined, undefined, undefined, undefined, store);
    const set = (body: unknown) => gateway.listHandlers().get("setProviderConfig")!(body, {} as never);
    const get = () => gateway.listHandlers().get("getProviderConfig")!({ agentId: "alpha" }, {} as never);
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({ name: "openai", async streamChat(request, emit) {
      requests.push(request);
      emit({ type: "service-tier", actual: requests.length === 1 ? "default" : "priority" });
      if (requests.length === 1) {
        await set({ agentId: "alpha", serviceTier: "default" });
        emit({ type: "tool-call", call: { id: "clock", type: "function", function: { name: "clock", arguments: "{}" } } });
      } else emit({ type: "delta", delta: "Concluído." });
    } });
    const runner = createTurnRunner({ config, registry, store,
      tools: [{ type: "function", function: { name: "clock", parameters: { type: "object", properties: {} } } }],
      toolExecutor: async () => ({ handled: true, ok: true, content: "12:00" }),
    });
    try {
      await expect(Promise.resolve(get())).resolves.toMatchObject({ serviceTier: "default" });
      await expect(set({ agentId: "alpha", serviceTier: "invalid" })).rejects.toThrow();
      await expect(set({ agentId: "alpha", model: "gpt-5.6-sol", serviceTier: "priority" })).rejects.toThrow("Fast não confirmado");
      await set({ agentId: "alpha", serviceTier: "priority" });
      const reopened = new ConfigStore({ configPath, allowUnverifiedModels: true });
      expect(reopened.snapshot().agents.map(a => a.serviceTier)).toEqual(["priority", undefined]);
      reopened.close();
      await runner.sendPrompt({ agentId: "alpha", prompt: "Consulte o relógio", clientNonce: "fast-turn" });
      await runner.flush("alpha");
      expect(requests.map(r => r.modelResolution?.serviceTier)).toEqual(["priority", "priority"]);
      expect(store.getLatestAssistant("alpha")).toMatchObject({ serviceTierOutcome: { requested: "priority", actual: ["default", "priority"] } });
      await expect(Promise.resolve(get())).resolves.toMatchObject({ serviceTier: "default", lastServiceTier: { requested: "priority", actual: ["default", "priority"] } });
      await runner.sendPrompt({ agentId: "alpha", prompt: "Continue", clientNonce: "standard-turn" });
      await runner.flush("alpha");
      expect(requests.at(-1)?.modelResolution?.serviceTier).toBe("default");
    } finally { store.close(); config.close(); catalog.close(); }
  });
  it("makes discovered Astra selectable with pinned Codex capabilities and reasoning", async () => {
    const catalog = new ModelCatalogService({ sources: { openai: {
      connectionKey: async () => connection,
      discover: async () => [{ id: "gpt-6-astra", inputModalities: ["text", "image"], supportedReasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium" }],
    } } });
    try {
      const result = await catalog.get("openai", true);
      expect(result.models.find(model => model.id === "gpt-6-astra")).toMatchObject({ selectable: true, availability: "listed", supportsVision: true });
      expect(catalog.resolve("openai", "gpt-6-astra", "high")).toMatchObject({ protocol: "codex", entry: { contextWindow: 272000, maxOutputTokens: 16384 }, capabilities: { streaming: true, tools: true, images: true } });
    } finally { catalog.close(); }
  });
  it("executes a saved model after restart and pins its context through a tool round and catalog refresh", async () => {
    const directory = root();
    const configPath = join(directory, "config.json");
    let contextWindow = 320000;
    const sources = { xai: { connectionKey: async () => connection, discover: async () => [{ id: "grok-4.6", contextWindow }] } };
    const catalog = new ModelCatalogService({ directory: join(directory, "catalog"), sources });
    await catalog.get("xai");
    const config = new ConfigStore({ configPath, allowUnverifiedModels: true });
    config.modelCatalog = catalog;
    config.update({ agents: [{ id: "catalog-bot", name: "Catalog bot", avatarId: "default", provider: "xai", model: "grok-4.6" }] });
    config.close(); catalog.close();
    const restored = new ModelCatalogService({ directory: join(directory, "catalog"), sources });
    await restored.initialize();
    const reopened = new ConfigStore({ configPath, allowUnverifiedModels: true });
    reopened.modelCatalog = restored;
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({ name: "xai", async streamChat(request, emit) {
      requests.push(request);
      if (requests.length === 1) {
        contextWindow = 128000;
        await restored.get("xai", true);
        emit({ type: "tool-call", call: { id: "clock-1", type: "function", function: { name: "clock", arguments: "{}" } } });
      } else emit({ type: "delta", delta: "Concluído." });
    } });
    const store = new SqliteTranscriptStore({ path: join(directory, "store.db") });
    const runner = createTurnRunner({ config: reopened, registry, store,
      tools: [{ type: "function", function: { name: "clock", parameters: { type: "object", properties: {} } } }],
      toolExecutor: async () => ({ handled: true, ok: true, content: "12:00" }),
    });
    try {
      await runner.sendPrompt({ agentId: "catalog-bot", prompt: "Consulte o relógio", clientNonce: "catalog-turn" });
      await runner.flush("catalog-bot");
      expect(requests).toHaveLength(2);
      expect(requests.map(r => r.modelResolution?.entry.contextWindow)).toEqual([320000, 320000]);
      expect(requests[0]?.sessionId).toBe(requests[1]?.sessionId);
      const user = store.getEntries("catalog-bot").find(e => e.kind === "message" && e.role === "user");
      expect(user).toMatchObject({ modelResolution: { entry: { contextWindow: 320000 } } });
      await runner.sendPrompt({ agentId: "catalog-bot", prompt: "Outra mensagem", clientNonce: "catalog-turn-2" });
      await runner.flush("catalog-bot");
      expect(requests[2]?.modelResolution?.entry.contextWindow).toBe(128000);
    } finally { store.close(); restored.close(); reopened.close(); }
  });

  it("deduplicates, forces refresh, retains stale state, restores cache and invalidates connection", async () => {
    const directory = root();
    let key = connection;
    let fail = false;
    const discover = vi.fn(async () => { if (fail) throw new Error("secret-provider-error"); return [{ id: "grok-4.6" }, { id: "future" }]; });
    const sources = { xai: { connectionKey: async () => key, discover } };
    const catalog = new ModelCatalogService({ directory, sources });
    await Promise.all([catalog.get("xai"), catalog.get("xai")]);
    expect(discover).toHaveBeenCalledTimes(1);
    await catalog.get("xai");
    expect(discover).toHaveBeenCalledTimes(1);
    const fresh = await catalog.get("xai", true);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(fresh.models.find(m => m.id === "future")).toMatchObject({ selectable: false, availability: "listed" });
    expect(catalog.resolve("xai", "grok-4.6").entry.id).toBe("grok-4.6");
    fail = true;
    const stale = await catalog.get("xai", true);
    expect(stale.state).toBe("stale");
    expect(JSON.stringify(stale)).not.toContain("secret-provider-error");
    const restarted = new ModelCatalogService({ directory, sources });
    await restarted.initialize();
    expect(restarted.peek("xai").models).toEqual(stale.models);
    expect(readFileSync(join(directory, "xai.json"), "utf8")).not.toContain("fixture-connection");
    key = connectionFingerprint("other-account");
    await restarted.synchronize("xai");
    expect(restarted.peek("xai").models.some(m => m.id === "future")).toBe(false);
    catalog.close(); restarted.close();
  });

  it("reports confirmed empty, blocks removed models, and rejects late results after invalidation", async () => {
    let release!: (models: { id: string }[]) => void;
    const catalog = new ModelCatalogService({ sources: { xai: { connectionKey: async () => connection, discover: () => new Promise(resolve => { release = resolve; }) } } });
    const pending = catalog.get("xai");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    catalog.invalidate("xai"); release([{ id: "late" }]);
    await pending;
    expect(catalog.peek("xai").models.some(m => m.id === "late")).toBe(false);
    const empty = catalog.get("xai", true);
    await Promise.resolve(); await Promise.resolve(); release([]);
    expect((await empty).state).toBe("empty");
    expect(() => catalog.resolve("xai", "grok-4.6")).toThrow(/ausente/);
    catalog.close();
  });

  it("bounds discovery timeout without converting failure to an empty catalog", async () => {
    let aborted = false;
    const catalog = new ModelCatalogService({ timeoutMs: 15, sources: { xai: { connectionKey: async () => connection, discover: signal => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }) } } });
    expect((await catalog.get("xai")).state).toBe("unavailable");
    expect(aborted).toBe(true);
    catalog.close();
  });

  it("preserves unverified saved selections on restart and blocks pending models through direct RPC", async () => {
    const configPath = join(root(), "config.json");
    const config = new ConfigStore({ configPath, allowUnverifiedModels: true });
    const catalog = new ModelCatalogService({ sources: { xai: { connectionKey: async () => connection, discover: async () => [{ id: "grok-4.6" }, { id: "future" }] } } });
    await catalog.get("xai");
    config.modelCatalog = catalog;
    config.update({ activeProvider: "xai", globalModel: "grok-4.6" });
    expect(() => config.update({ agents: [{ id: "model-only", name: "Model only", avatarId: "default", model: "gpt-5.6-sol" }] })).not.toThrow();
    const restarted = new ConfigStore({ configPath, allowUnverifiedModels: true });
    expect(restarted.snapshot().globalModel).toBe("grok-4.6");
    const gateway = new Gateway();
    registerRosterHandlers(gateway, config);
    const handler = gateway.listHandlers().get("setProviderConfig")!;
    await expect(Promise.resolve().then(() => handler({ provider: "xai", model: "future" }, {} as never))).rejects.toThrow();
    expect(config.snapshot().globalModel).toBe("grok-4.6");
    catalog.close();
  });
});

describe("discovery protocols", () => {
  it("uses announced service tiers, retaining the legacy Fast field only when the new field is absent", () => {
    const models = codexCatalogPage({ data: [
      { model: "gpt-6-astra", serviceTiers: [{ id: "priority" }, { id: "other" }] },
      { model: "gpt-5.6-sol", additionalSpeedTiers: ["fast"] },
      { model: "gpt-5.6-luna", serviceTiers: [], additionalSpeedTiers: ["fast"] },
    ] }).models;
    expect(models.map(m => m.serviceTiers)).toEqual([["priority"], ["priority"], []]);
  });
  it("joins xAI endpoints, keeps aliases and excludes non-text outputs", async () => {
    const oauth = { catalogConnectionKey: async () => connection, resolveCredential: async () => ({ accessToken: "fixture-token" }), rejectCredential: vi.fn(), hasCredential: async () => true };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
      return Response.json(String(url).endsWith("/language-models")
        ? { models: [{ id: "grok-4.6", aliases: ["grok-alias"], input_modalities: ["text", "image"], output_modalities: ["text"] }, { id: "image-only", output_modalities: ["image"] }] }
        : { data: [{ id: "grok-4.6", context_length: 100000 }] });
    }) as unknown as typeof fetch;
    const source = createXaiCatalogSource({ oauth, fetchImpl });
    expect(await source.discover(new AbortController().signal)).toEqual([{ id: "grok-4.6", contextWindow: 100000, aliases: ["grok-alias"], inputModalities: ["text", "image"], supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] }]);
  });

  it.each([401, 403, 500])("fails the whole xAI refresh on partial HTTP %i", async status => {
    const oauth = { catalogConnectionKey: async () => connection, resolveCredential: async () => ({ accessToken: "fixture-token" }), rejectCredential: vi.fn(), hasCredential: async () => true };
    const source = createXaiCatalogSource({ oauth, fetchImpl: (async url => String(url).endsWith("/models") ? new Response("private-error", { status }) : Response.json({ models: [] })) as typeof fetch });
    await expect(source.discover(new AbortController().signal)).rejects.toThrow(`HTTP ${status}`);
    expect(oauth.rejectCredential).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it("lists unknown public Go models without credentials and normalizes prefixes", async () => {
    const source = createOpenCodeCatalogSource({ connectionKey: async () => connection, fetchImpl: (async (_url, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ data: [{ id: "omen-alpha" }, { id: "opencode-go/glm-5.3" }] });
    }) as typeof fetch });
    expect((await source.discover(new AbortController().signal)).map(m => m.id)).toEqual(["opencode-go/omen-alpha", "opencode-go/glm-5.3"]);
  });

  it("intersects Codex efforts without substituting an incompatible saved effort", () => {
    expect(codexCatalogPage({ data: [{ model: "gpt-5.6-sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "ultra" }], inputModalities: ["text"] }], nextCursor: "next" })).toMatchObject({ models: [{ supportedReasoningEfforts: ["high"] }], nextCursor: "next" });
  });

  it("discovers openai-compat limits from the configured endpoint /models", async () => {
    const source = createCompatCatalogSource({
      baseUrl: () => "https://127.0.0.1:9/v1",
      apiKey: async () => "fixture-compat-key",
      fetchImpl: (async (url, init) => {
        expect(String(url)).toBe("https://127.0.0.1:9/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-compat-key");
        return Response.json({ data: [
          { id: "custom-llm", context_length: 64_000, max_output_tokens: 8_192 },
          { id: "openrouter-style", top_provider: { context_length: 200_000 } },
          { id: "opaque" },
        ] });
      }) as typeof fetch,
    });
    expect(await source.hasConnection?.()).toBe(true);
    const models = await source.discover(new AbortController().signal);
    expect(models).toEqual([
      { id: "custom-llm", contextWindow: 64_000, maxOutputTokens: 8_192, maxRequestBytes: 1024 * 1024 },
      { id: "openrouter-style", contextWindow: 200_000, maxOutputTokens: 16_384, maxRequestBytes: 1024 * 1024 },
      { id: "opaque" },
    ]);
  });

  it("marks openai-compat models selectable only after endpoint discovery", async () => {
    let baseUrl: string | undefined;
    const source = createCompatCatalogSource({
      baseUrl: () => baseUrl,
      fetchImpl: (async () => Response.json({ data: [
        { id: "served-model", context_length: 128_000, max_completion_tokens: 4_096 },
        { id: "my-custom-model" },
      ] })) as typeof fetch,
    });
    const catalog = new ModelCatalogService({ sources: { "openai-compat": source } });
    try {
      await catalog.initialize();
      // Sem endpoint configurado: a fonte reporta `connected: false` —
      // o catálogo distingue "desconectado" de "indisponível" em vez de
      // inventar um erro de catálogo.
      const offline = catalog.peek("openai-compat");
      expect(offline.connected).toBe(false);
      expect(offline.models.find(m => m.id === "openai-compatible")).toBeDefined();

      // Modelo custom antes de qualquer descoberta: fallback conservador da
      // entrada genérica (compatibilidade com configs antigas).
      expect(catalog.resolve("openai-compat", "my-custom-model").entry.contextWindow).toBe(128_000);

      baseUrl = "https://127.0.0.1:9/v1";
      const discovered = await catalog.get("openai-compat", true);
      const served = discovered.models.find(m => m.id === "served-model");
      expect(served).toMatchObject({ selectable: true, availability: "listed", contextWindow: 128_000, maxOutputTokens: 4_096 });
      const resolution = catalog.resolve("openai-compat", "served-model");
      expect(resolution.protocol).toBe("chat");
      expect(resolution.entry.maxRequestBytes).toBeGreaterThan(0);

      // A listing with only an id confirms existence; preserve the generic
      // conservative limits that admitted the explicit custom model before discovery.
      const minimal = discovered.models.find(m => m.id === "my-custom-model");
      expect(minimal).toMatchObject({ selectable: true, availability: "listed", contextWindow: 128_000, maxOutputTokens: 16_384, maxRequestBytes: 1024 * 1024 });
      expect(catalog.resolve("openai-compat", "my-custom-model").entry.contextWindow).toBe(128_000);

      // Com catálogo descoberto, modelo que o endpoint não anuncia é rejeitado.
      expect(() => catalog.resolve("openai-compat", "not-served")).toThrow();
    } finally { catalog.close(); }
  });

  it("keeps explicitly incompatible openai-compat limits pending", async () => {
    const catalog = new ModelCatalogService({ sources: { "openai-compat": {
      connectionKey: async () => connection,
      discover: async () => [{ id: "inconsistent-model", contextWindow: 4_096, maxOutputTokens: 8_192 }],
    } } });
    try {
      const discovered = await catalog.get("openai-compat", true);
      expect(discovered.models.find(m => m.id === "inconsistent-model")).toMatchObject({ selectable: false, availability: "listed" });
      expect(() => catalog.resolve("openai-compat", "inconsistent-model")).toThrow(/limites/);
    } finally { catalog.close(); }
  });
});
