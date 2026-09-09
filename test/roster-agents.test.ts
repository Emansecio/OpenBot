import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { ConfigStore } from "../src/config/store.js";
import type { ProviderAdapter, ProviderStreamEvent } from "../src/providers/router.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";
import { normalizeSendPrompt } from "../src/rpc/send.js";

async function boot(seedDefault = true) {
  const dir = mkdtempSync(join(tmpdir(), "openbot-roster-"));
  let handle: ServerHandle | undefined;
  onTestFinished(async () => {
    try {
      if (handle !== undefined) await stopServer(handle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const configPath = join(dir, "config.json");
  if (seedDefault) {
    const config = new ConfigStore({ configPath });
    config.update({ agents: [{ id: "openbot-default", name: "Local User", avatarId: "openbot-default" }] });
    config.close();
  }
  handle = await startServer(0, {
    stateRoot: join(dir, "state"),
    allowUnauthenticatedLocalGateway: true,
    runtimeRoot: join(dir, "runtime"),
    browserRoot: join(dir, "browser"),
    workspacesRoot: join(dir, "workspaces"),
    storePath: join(dir, "store.db"),
    configPath,
    keystoreDir: join(dir, "keys"),
  });
  return handle;
}

const bootEmpty = () => boot(false);

async function post(handle: ServerHandle, method: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as { ok: boolean; value?: unknown; failure?: string } };
}

function nextRpcRequest(handle: ServerHandle, method: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (request: IncomingMessage) => {
      if (request.url !== `/api/${method}`) return;
      handle.server.off("request", listener);
      resolve();
    };
    handle.server.on("request", listener);
  });
}

describe.concurrent("roster multi-agent", () => {
  it("mantém o estado inicial sem bots e rejeita operações que exigem um agente", async () => {
    const handle = await bootEmpty();
    expect(handle.config.snapshot().agents).toEqual([]);
    expect((await post(handle, "listAgents", {})).json).toMatchObject({ ok: true, value: [] });
    expect((await post(handle, "getAgent", { id: "missing" })).status).toBe(400);
    expect((await post(handle, "openAgent", {})).status).toBe(400);
    expect((await post(handle, "getLocalRuntimeStatus", {})).status).toBe(400);
  });

  it("persiste nome e aparência do perfil local sem criar um bot", async () => {
    const handle = await bootEmpty();

    expect((await post(handle, "getLocalProfile", {})).json).toMatchObject({
      ok: true,
      value: { name: "OpenBot Local", avatarId: "openbot-default" },
    });

    const pngBase64 = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");
    const saved = await post(handle, "updateLocalProfile", {
      name: "  Openbot  ",
      avatarShape: "rounded",
      avatarColor: "#7c3aed",
      avatarPngBase64: pngBase64,
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({
      ok: true,
      value: {
        name: "Openbot",
        avatarShape: "rounded",
        avatarColor: "#7c3aed",
        avatarPngBase64: pngBase64,
      },
    });
    expect(handle.config.snapshot()).toMatchObject({
      profile: {
        name: "Openbot",
        avatarShape: "rounded",
        avatarColor: "#7c3aed",
        hasCustomAvatar: true,
      },
      agents: [],
    });
    expect(handle.config.snapshot().profile.avatarPngBase64).toBeUndefined();

    expect((await post(handle, "updateLocalProfile", { name: "   " })).status).toBe(400);
    expect((await post(handle, "updateLocalProfile", {
      avatarPngBase64: Buffer.from("not-png").toString("base64"),
    })).status).toBe(400);

    const removed = await post(handle, "updateLocalProfile", { avatarPngBase64: null });
    expect(removed.status).toBe(200);
    expect((removed.json.value as Record<string, unknown>).avatarPngBase64).toBeUndefined();
    expect(handle.config.snapshot().profile.hasCustomAvatar).toBeUndefined();
    expect(existsSync(join(dirname(handle.config.path), "profile-avatar.png"))).toBe(false);
  });

  it("createAgent devolve {agent} no shape do cliente e listAgents o inclui", async () => {
    const handle = await boot();
    const created = await post(handle, "createAgent", {
      name: "Assistente de notas",
      title: "Curador de conhecimento",
      description: "Organiza anotações",
      origin: "user",
      isKickstartRequested: true,
      avatarShape: "blob",
      avatarColor: "purple",
    });
    expect(created.status).toBe(200);
    expect(created.json.ok).toBe(true);
    const envelope = created.json.value as { agent: Record<string, unknown> };
    expect(envelope.agent).toBeDefined();
    const agent = envelope.agent;
    expect(agent.name).toBe("Assistente de notas");
    expect(agent.title).toBe("Curador de conhecimento");
    expect(agent.description).toBe("Organiza anotações");
    expect(agent.origin).toBe("user");
    expect(agent.isGroup).toBe(false);
    expect(agent.avatarShape).toBe("blob");
    expect(agent.avatarColor).toBe("purple");
    expect(agent.lastMessageId).toBeNull();
    expect(agent.lastEntry).toBeNull();
    expect(agent.awaitingUserResponse).toBeNull();
    expect(agent.memberIds).toEqual([]);
    expect(agent.conversationPartnerIds).toEqual([]);
    expect(typeof agent.id).toBe("string");
    expect(agent.id).not.toBe("openbot-default");
    const listed = await post(handle, "listAgents", {});
    const agents = listed.json.value as Array<{ id: string; name: string; isGroup: boolean }>;
    expect(agents.map((entry) => entry.id)).toContain(agent.id);
    expect(agents).toHaveLength(2);
    expect(agents.every((entry) => typeof entry.name === "string" && ! entry.isGroup)).toBe(true);
  });

  it("permite que um bot crie e configure outro bot pela ferramenta nativa", async () => {
    const handle = await boot();
    const requests: Array<{ purpose?: string; system?: string; tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> }> = [];
    let calls = 0;
    handle.registry.register({
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        if (request.purpose === "memory-reflection") {
          emit({ type: "delta", delta: "{}" });
          return;
        }
        calls += 1;
        if (calls === 1) {
          emit({
            type: "tool-call",
            call: {
              id: "create-child-1",
              type: "function",
              function: {
                name: "create_bot",
                arguments: JSON.stringify({
                  name: "Lumen",
                  title: "Curadora de pesquisa",
                  description: "Pesquisa fontes, compara evidências e registra conclusões com clareza.",
                  provider: "openai",
                  model: "gpt-5.6-sol",
                  reasoning_effort: "high",
                }),
              },
            },
          });
          return;
        }
        emit({ type: "delta", delta: "Lumen foi criada e configurada." });
      },
    });

    handle.runner.sendPrompt({ agentId: "openbot-default", prompt: "Crie a bot Lumen.", clientNonce: "create-bot:1" });
    await handle.runner.flush("openbot-default");

    const turnRequests = requests.filter((request) => request.purpose !== "memory-reflection");
    expect(turnRequests).toHaveLength(2);
    expect(turnRequests[0]?.tools?.map((tool) => tool.function.name)).toContain("create_bot");
    expect(turnRequests[0]?.system).toContain("create_bot");
    expect(turnRequests[0]?.system).toContain("explicitly asks");
    const toolMessage = [...(turnRequests[1]?.messages ?? [])].reverse().find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain('"ok":true');
    expect(toolMessage?.content).toContain('"name":"Lumen"');

    const created = handle.config.snapshot().agents.find((agent) => agent.name === "Lumen");
    expect(created).toMatchObject({
      title: "Curadora de pesquisa",
      description: "Pesquisa fontes, compara evidências e registra conclusões com clareza.",
      origin: "agent:openbot-default",
      runtimeMode: "developer",
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(existsSync(handle.homes!.pathFor(created!.id))).toBe(true);
  });

  it("rejeita configuração incompatível da ferramenta antes de criar resíduos", async () => {
    const handle = await boot();
    const beforeIds = handle.config.snapshot().agents.map((agent) => agent.id);
    let calls = 0;
    let toolFailure = "";
    handle.registry.register({
      name: "xai",
      async streamChat(request, emit) {
        if (request.purpose === "memory-reflection") {
          emit({ type: "delta", delta: "{}" });
          return;
        }
        calls += 1;
        if (calls === 1) {
          emit({
            type: "tool-call",
            call: {
              id: "create-invalid-child-1",
              type: "function",
              function: {
                name: "create_bot",
                arguments: JSON.stringify({
                  name: "Inválida",
                  description: "Não deve persistir.",
                  provider: "xai",
                  model: "gpt-5.6-sol",
                }),
              },
            },
          });
          return;
        }
        toolFailure = String([...request.messages].reverse().find((message) => message.role === "tool")?.content ?? "");
        emit({ type: "delta", delta: "A configuração inválida foi rejeitada." });
      },
    });

    handle.runner.sendPrompt({ agentId: "openbot-default", prompt: "Crie um bot com configuração inválida.", clientNonce: "create-bot:invalid" });
    await handle.runner.flush("openbot-default");

    expect(toolFailure).toContain("incompatível");
    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(beforeIds);
  });

  it("serializa criações concorrentes do mesmo id sem quarentenar a home vencedora", async () => {
    const handle = await bootEmpty();
    const results = await Promise.all([
      post(handle, "createAgent", { id: "same-id", name: "Primeiro" }),
      post(handle, "createAgent", { id: "same-id", name: "Segundo" }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(handle.config.snapshot().agents.filter((agent) => agent.id === "same-id")).toHaveLength(1);
    expect(existsSync(handle.homes!.pathFor("same-id"))).toBe(true);
    expect(await handle.homes!.listQuarantine()).toEqual([]);
  });

  it("torna idempotente uma rajada da mesma criação sem id explícito", async () => {
    const handle = await bootEmpty();
    const results = await Promise.all(Array.from({ length: 6 }, () => (
      post(handle, "createAgent", { name: "New Bot", origin: "user" })
    )));

    expect(results.every((result) => result.status === 200)).toBe(true);
    const ids = results.map((result) => (result.json.value as { agent: { id: string } }).agent.id);
    expect(new Set(ids).size).toBe(1);
    expect(handle.config.snapshot().agents).toHaveLength(1);
  });

  it("createAgent materializa Title igual ao Name e mantém os campos independentes", async () => {
    const handle = await bootEmpty();
    const created = await post(handle, "createAgent", { name: "Atlas" });
    const agent = (created.json.value as { agent: { id: string; name: string; title: string } }).agent;

    expect(agent).toMatchObject({ name: "Atlas", title: "Atlas" });
    expect(handle.config.snapshot().agents[0]).toMatchObject({ name: "Atlas", title: "Atlas" });

    const renamed = await post(handle, "updateAgent", { agentId: agent.id, name: "Atlas Prime" });
    expect(renamed.json.value).toMatchObject({ name: "Atlas Prime", title: "Atlas" });
  });

  it("rejeita Title inválido ou vazio sem alterar o agente", async () => {
    const handle = await boot();

    expect((await post(handle, "updateAgent", { agentId: "openbot-default", title: 42 })).status).toBe(400);
    expect((await post(handle, "updateAgent", { agentId: "openbot-default", title: "   " })).status).toBe(400);
    expect(handle.config.snapshot().agents[0]).toMatchObject({
      id: "openbot-default",
      name: "Local User",
    });
    expect(handle.config.snapshot().agents[0]?.title).toBeUndefined();
  });

  it("setAgentAvatarBytes persiste e getAgentAvatar devolve o png", async () => {
    const handle = await boot();
    const created = await post(handle, "createAgent", { name: "Com foto", origin: "user" });
    const id = (created.json.value as { agent: { id: string } }).agent.id;
    const pngBase64 = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");
    const saved = await post(handle, "setAgentAvatarBytes", { id, pngBase64 });
    expect(saved.status).toBe(200);
    expect(saved.json.ok).toBe(true);
    const avatar = await post(handle, "getAgentAvatar", { id });
    expect(avatar.json).toMatchObject({ ok: true, value: { pngBase64 } });
    expect(handle.config.snapshot().agents.find((agent) => agent.id === id)).toMatchObject({ hasCustomAvatar: true });
    expect(handle.config.snapshot().agents.find((agent) => agent.id === id)?.avatarPngBase64).toBeUndefined();
    const invalid = await post(handle, "setAgentAvatarBytes", { id, pngBase64: Buffer.from("not-png").toString("base64") });
    expect(invalid.status).toBe(400);
  });

  it("setProviderConfig grava provider e modelo juntos", async () => {
    const handle = await boot();
    const saved = await post(handle, "setProviderConfig", { provider: "openai", model: "gpt-5.6-sol" });
    expect(saved.json).toMatchObject({ ok: true, value: { provider: "openai", model: "gpt-5.6-sol" } });
    const read = await post(handle, "getProviderConfig", {});
    expect(read.json).toMatchObject({ ok: true, value: { provider: "openai", model: "gpt-5.6-sol" } });
    const def = await post(handle, "getAgentDefaultModel", {});
    expect(def.json).toMatchObject({ ok: true, value: { model: "gpt-5.6-sol", modelId: "gpt-5.6-sol" } });
  });

  it("recusa selecionar openai-compat sem baseURL", async () => {
    const handle = await boot();

    const provider = await post(handle, "setActiveProvider", { provider: "openai-compat" });
    const model = await post(handle, "setAgentDefaultModel", { model: "openai-compatible" });
    const config = await post(handle, "setProviderConfig", {
      provider: "openai-compat",
      model: "openai-compatible",
    });

    expect([provider.status, model.status, config.status]).toEqual([400, 400, 400]);
    expect((await post(handle, "getProviderConfig", {})).json).toMatchObject({
      ok: true,
      value: { provider: "xai", model: "grok-4.6", baseURL: null },
    });
    expect(handle.registry.has("openai-compat")).toBe(false);
  });

  it("não remove a baseURL enquanto openai-compat está em uso", async () => {
    const handle = await boot();
    const baseURL = "http://127.0.0.1:1234/v1";
    const saved = await post(handle, "setProviderConfig", {
      provider: "openai-compat",
      model: "openai-compatible",
      baseURL,
    });

    expect(saved.status).toBe(200);
    expect(handle.registry.has("openai-compat")).toBe(true);

    const removed = await post(handle, "setProviderConfig", { baseURL: null });
    expect(removed.status).toBe(400);
    expect(handle.config.snapshot().compatBaseUrl).toBe(baseURL);
    expect(handle.registry.has("openai-compat")).toBe(true);
  });

  it("ressincroniza o adapter ao selecionar openai-compat com baseURL válida", async () => {
    const handle = await boot();
    const baseURL = "http://127.0.0.1:1234/v1";
    expect((await post(handle, "setProviderConfig", { baseURL })).status).toBe(200);

    handle.registry.unregister("openai-compat");
    expect((await post(handle, "setActiveProvider", { provider: "openai-compat" })).status).toBe(200);
    expect(handle.registry.has("openai-compat")).toBe(true);

    expect((await post(handle, "setActiveProvider", { provider: "xai" })).status).toBe(200);
    handle.registry.unregister("openai-compat");
    expect((await post(handle, "setAgentDefaultModel", { model: "openai-compatible" })).status).toBe(200);
    expect(handle.registry.has("openai-compat")).toBe(true);
  });

  it("recusa valores não booleanos nos quatro handlers de flags", async () => {
    const handle = await boot();
    const agentId = "openbot-default";
    const results = [
      await post(handle, "setAgentUnread", { agentId, unread: "false" }),
      await post(handle, "setAgentHiddenFromSidebar", { agentId, hidden: "false" }),
      await post(handle, "setAgentNotificationsEnabled", { agentId, enabled: "false" }),
      await post(handle, "setAgentNotifyOnUpdates", { agentId, enabled: "false" }),
    ];

    expect(results.map((result) => result.status)).toEqual([400, 400, 400, 400]);
  });

  it.sequential("updateAgent devolve exatamente o updatedAt persistido", async () => {
    const handle = await boot();
    let tick = 100;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => tick += 1);
    let responseUpdatedAt: number | undefined;
    let persistedUpdatedAt: number | undefined;
    try {
      const updated = await post(handle, "updateAgent", { agentId: "openbot-default", name: "Renamed" });
      responseUpdatedAt = (updated.json.value as { updatedAt?: number }).updatedAt;
      persistedUpdatedAt = handle.config.snapshot().agents[0]?.updatedAt;
    } finally {
      clock.mockRestore();
    }

    expect(responseUpdatedAt).toBe(persistedUpdatedAt);
  });

  it("updateAgent persiste Title independente de Name e o restaura do disco", async () => {
    const handle = await boot();

    const updated = await post(handle, "updateAgent", {
      agentId: "openbot-default",
      name: "Atlas",
      title: "Pesquisador técnico",
      description: "Investiga documentação e código.",
    });

    expect(updated.status).toBe(200);
    expect(updated.json.value).toMatchObject({
      name: "Atlas",
      title: "Pesquisador técnico",
      description: "Investiga documentação e código.",
    });

    const listed = await post(handle, "listAgents", {});
    expect(listed.json.value).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "openbot-default",
        name: "Atlas",
        title: "Pesquisador técnico",
      }),
    ]));

    const reloaded = new ConfigStore({ configPath: handle.config.path });
    expect(reloaded.snapshot().agents[0]).toMatchObject({
      name: "Atlas",
      title: "Pesquisador técnico",
    });
  });

  it("duplicateAgent preserva o Title explícito e mantém o Name da cópia independente", async () => {
    const handle = await boot();
    await post(handle, "updateAgent", {
      agentId: "openbot-default",
      name: "Atlas",
      title: "Pesquisador técnico",
    });

    const duplicated = await post(handle, "duplicateAgent", { agentId: "openbot-default" });

    expect(duplicated.status).toBe(200);
    expect(duplicated.json.value).toMatchObject({
      agent: {
        name: "Atlas (cópia)",
        title: "Pesquisador técnico",
      },
    });
  });

  it("duplicateAgent materializa o Title efetivo de um registro legado", async () => {
    const handle = await boot();
    expect(handle.config.snapshot().agents[0]?.title).toBeUndefined();

    const duplicated = await post(handle, "duplicateAgent", { agentId: "openbot-default" });

    expect(duplicated.json.value).toMatchObject({
      agent: { name: "Local User (cópia)", title: "Local User" },
    });
    expect(handle.config.snapshot().agents[1]).toMatchObject({ title: "Local User" });
  });

  it("configuração com agentId altera somente o agente alvo", async () => {
    const handle = await boot();
    const createdA = await post(handle, "createAgent", { name: "A" });
    const createdB = await post(handle, "createAgent", { name: "B" });
    const idA = (createdA.json.value as { agent: { id: string } }).agent.id;
    const idB = (createdB.json.value as { agent: { id: string } }).agent.id;
    const before = handle.config.snapshot();
    const beforeB = before.agents.find((agent) => agent.id === idB);

    expect((await post(handle, "setAgentDefaultModel", { agentId: idA, model: "gpt-5.6-sol" })).status).toBe(200);
    expect((await post(handle, "setProviderConfig", { agentId: idA, provider: "xai", model: "grok-4.6" })).status).toBe(200);
    expect((await post(handle, "setActiveProvider", { agentId: idA, provider: "openai" })).status).toBe(200);

    const after = handle.config.snapshot();
    expect({ provider: after.activeProvider, model: after.globalModel, baseURL: after.compatBaseUrl }).toEqual({
      provider: before.activeProvider,
      model: before.globalModel,
      baseURL: before.compatBaseUrl,
    });
    expect(after.agents.find((agent) => agent.id === idB)).toEqual(beforeB);
    expect(after.agents.find((agent) => agent.id === idA)).toMatchObject({ provider: "openai", model: "gpt-5.6-sol" });

    const scopedBaseUrl = await post(handle, "setProviderConfig", {
      agentId: idA,
      baseURL: "http://127.0.0.1:1234/v1",
    });
    expect(scopedBaseUrl.status).toBe(200);
    expect(handle.config.snapshot().compatBaseUrl).toBe("http://127.0.0.1:1234/v1");
    const beforeStaleSave = handle.config.snapshot().agents.find((agent) => agent.id === idA);
    await post(handle, "openAgent", { agentId: idB });
    const staleSave = await post(handle, "setProviderConfig", {
      agentId: idA,
      requireActive: true,
      provider: "xai",
      model: "grok-4.6",
    });
    expect(staleSave.status).toBe(400);
    expect(handle.config.snapshot().agents.find((agent) => agent.id === idA)).toEqual(beforeStaleSave);
  });

  it("configuração sem agentId aplica ao bot ativo sem alterar o global", async () => {
    const handle = await boot();
    const created = await post(handle, "createAgent", { name: "Ativo" });
    const id = (created.json.value as { agent: { id: string } }).agent.id;
    await post(handle, "openAgent", { id });
    const before = handle.config.snapshot();
    await post(handle, "setProviderConfig", { provider: "openai", model: "gpt-5.6-sol" });
    await post(handle, "setActiveProvider", { provider: "xai" });
    await post(handle, "setAgentDefaultModel", { model: "gpt-5.6-sol" });
    const after = handle.config.snapshot();
    expect({ provider: after.activeProvider, model: after.globalModel }).toEqual({ provider: before.activeProvider, model: before.globalModel });
    expect(after.agents.find((agent) => agent.id === id)).toMatchObject({ provider: "openai", model: "gpt-5.6-sol" });
  });

  it("sem bots, setAgentDefaultModel persiste modelo e provider globais do catálogo", async () => {
    const handle = await bootEmpty();

    const saved = await post(handle, "setAgentDefaultModel", { model: "gpt-5.6-sol" });

    expect(saved.status).toBe(200);
    expect(handle.config.snapshot()).toMatchObject({ globalModel: "gpt-5.6-sol", activeProvider: "openai", agents: [] });
  });

  it("sem bots, settings global salva provider e modelo com a proteção de bot ativo", async () => {
    const handle = await bootEmpty();

    const saved = await post(handle, "setProviderConfig", {
      requireActive: true,
      provider: "openai",
      model: "gpt-5.6-sol",
    });

    expect(saved.status).toBe(200);
    expect(handle.config.snapshot()).toMatchObject({ globalModel: "gpt-5.6-sol", activeProvider: "openai", agents: [] });
  });

  it("sem bots, rejeita modelo custom explicitamente", async () => {
    const handle = await bootEmpty();
    await post(handle, "setProviderConfig", { baseURL: "http://127.0.0.1:1234/v1" });

    const rejected = await post(handle, "setAgentDefaultModel", { model: "custom-local-model" });

    expect(rejected.status).toBe(400);
    expect(rejected.json.failure).toContain("modelo custom exige um agente");
    expect(handle.config.snapshot()).toMatchObject({ globalModel: "grok-4.6", activeProvider: "xai", agents: [] });
  });

  it("excluir agente remove a home e preserva o bot ativo quando outro é apagado", async () => {
    const handle = await boot();
    const victim = await post(handle, "createAgent", { id: "victim", name: "Victim" });
    expect(victim.status).toBe(200);
    const survivor = await post(handle, "createAgent", { id: "survivor", name: "Survivor" });
    expect(survivor.status).toBe(200);
    const victimRoot = handle.homes!.pathFor("victim");
    writeFileSync(join(victimRoot, "Documents", "private.txt"), "private");
    await post(handle, "openAgent", { id: "survivor" });
    const deleted = await post(handle, "deleteAgents", { ids: ["VICTIM"] });
    expect(deleted.status).toBe(200);
    expect(existsSync(victimRoot)).toBe(false);
    const listed = (await post(handle, "listAgents", {})).json.value as Array<{ id: string; isActive: boolean }>;
    expect(listed.find((agent) => agent.id === "survivor")?.isActive).toBe(true);
  });

  it("reverte homes anteriores quando uma exclusão em lote falha", async () => {
    const handle = await bootEmpty();
    await post(handle, "createAgent", { id: "batch-first", name: "First" });
    await post(handle, "createAgent", { id: "batch-second", name: "Second" });
    const firstRoot = handle.homes!.pathFor("batch-first");
    const secondRoot = handle.homes!.pathFor("batch-second");
    writeFileSync(join(secondRoot, ".openbot", "home.json"), "not-json");

    const deleted = await post(handle, "deleteAgents", { ids: ["batch-first", "batch-second"] });
    expect(deleted.status).toBe(500);
    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["batch-first", "batch-second"]);
    expect(existsSync(firstRoot)).toBe(true);
    expect(existsSync(secondRoot)).toBe(true);
    expect(await handle.homes!.listQuarantine()).toEqual([]);
  });

  it("restaura a home quando o commit do roster falha", async () => {
    const handle = await bootEmpty();
    await post(handle, "createAgent", { id: "commit-victim", name: "Commit victim" });
    const home = handle.homes!.pathFor("commit-victim");
    const releaseFence = vi.spyOn(
      handle.runtimeManager as typeof handle.runtimeManager & { releaseAgentFence: (agentId: string) => void },
      "releaseAgentFence",
    );
    const originalUpdate = handle.config.update.bind(handle.config);
    handle.config.update = (() => { throw new Error("config update failed"); });
    try {
      const failed = await post(handle, "deleteAgents", { ids: ["commit-victim"] });
      expect(failed.status).toBe(500);
    } finally {
      handle.config.update = originalUpdate;
    }
    expect(existsSync(home)).toBe(true);
    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["commit-victim"]);
    expect(await handle.homes!.listQuarantine()).toEqual([]);
    expect(releaseFence).toHaveBeenCalledWith("commit-victim");
  });

  it("restaura transcript, nonces, decisões e atividade se store.clear falhar depois de limpar", async () => {
    const handle = await bootEmpty();
    await post(handle, "createAgent", { id: "partial-victim", name: "Partial victim" });
    const seedEntry: TranscriptEntry = {
      kind: "message",
      id: "seed:message",
      role: "user",
      content: "estado que não pode ser perdido",
      timestampMs: 123,
    };
    handle.store.append("partial-victim", [seedEntry]);
    handle.store.rememberAcceptedNonce("partial-victim", "seed:nonce");
    handle.store.rememberInteractionDecision("partial-victim", "seed:request", "tool", "allow");

    handle.registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        emit({ type: "delta", delta: "atividade preservada" });
      },
    });
    handle.runner.sendPrompt({ agentId: "partial-victim", prompt: "atividade", clientNonce: "activity:1" });
    await handle.runner.flush("partial-victim");
    const beforeActivity = ((await post(handle, "listAgents", {})).json.value as Array<{
      id: string;
      lastMessagePreview: string | null;
    }>).find((agent) => agent.id === "partial-victim");
    const beforeEntries = [...handle.store.getEntries("partial-victim")];

    const originalClear = handle.store.clear.bind(handle.store);
    handle.store.clear = ((agentId: string) => {
      originalClear(agentId);
      throw new Error("store clear failed after deletion");
    });
    try {
      const failed = await post(handle, "deleteAgents", { ids: ["partial-victim"] });
      expect(failed.status).toBe(500);
    } finally {
      handle.store.clear = originalClear;
    }

    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["partial-victim"]);
    expect(existsSync(handle.homes!.pathFor("partial-victim"))).toBe(true);
    expect([...handle.store.getEntries("partial-victim")]).toEqual(beforeEntries);
    expect(handle.store.hasAcceptedNonce("partial-victim", "seed:nonce")).toBe(true);
    expect(handle.store.getInteractionDecision("partial-victim", "seed:request", "tool"))
      .toMatchObject({ decision: "allow" });
    const afterActivity = ((await post(handle, "listAgents", {})).json.value as Array<{
      id: string;
      lastMessagePreview: string | null;
    }>).find((agent) => agent.id === "partial-victim");
    expect(afterActivity?.lastMessagePreview).toBe(beforeActivity?.lastMessagePreview);
  });

  it("excluir o último bot deixa o roster vazio e não recria openbot-default", async () => {
    const handle = await bootEmpty();
    const created = await post(handle, "createAgent", { id: "last-bot", name: "Last bot" });
    expect(created.status).toBe(200);

    const deleted = await post(handle, "deleteAgents", { ids: ["last-bot"] });
    expect(deleted).toMatchObject({ status: 200, json: { ok: true, value: { ids: ["last-bot"] } } });
    expect(handle.config.snapshot().agents).toEqual([]);
    expect((await post(handle, "listAgents", {})).json).toMatchObject({ ok: true, value: [] });
    expect((await post(handle, "getAgent", { id: "openbot-default" })).status).toBe(400);
    expect((await post(handle, "ensureForeverBox", { id: "openbot-default" })).status).toBe(400);
  });

  it("deleteAgents aguarda o turno antes de limpar store e home", async () => {
    const handle = await boot();
    const created = await post(handle, "createAgent", { id: "late-victim", name: "Late victim" });
    expect(created.status).toBe(200);
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const lateAdapter: ProviderAdapter = {
      name: "xai",
      async streamChat(_request, emit: (event: ProviderStreamEvent) => void) {
        startedResolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        emit({ type: "delta", delta: "late write" });
      },
    };
    handle.registry.register(lateAdapter);
    handle.runner.sendPrompt({ agentId: "late-victim", prompt: "run", clientNonce: "late:1" });
    await started;

    const deleted = await post(handle, "deleteAgents", { ids: ["late-victim"] });
    expect(deleted.status).toBe(200);
    await handle.runner.flush("late-victim");
    expect(existsSync(handle.homes!.pathFor("late-victim"))).toBe(false);
    expect(handle.store.getEntries("late-victim")).toEqual([]);
  });

  it("deleteAgents preserva criação e atualização concorrentes após o callback", async () => {
    const handle = await boot();
    const survivor = await post(handle, "createAgent", { id: "survivor", name: "Survivor" });
    expect(survivor.status).toBe(200);

    let releaseFlush!: () => void;
    let flushStarted!: () => void;
    const flushReleased = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const flushEntered = new Promise<void>((resolve) => { flushStarted = resolve; });
    const flush = vi.spyOn(handle.runner, "flush").mockImplementation(async () => {
      flushStarted();
      await flushReleased;
    });

    try {
      const deleting = post(handle, "deleteAgents", { ids: ["openbot-default"] });
      await flushEntered;

      const updated = await post(handle, "updateAgent", { agentId: "survivor", name: "Survivor updated" });
      expect(updated.status).toBe(200);
      const created = await post(handle, "createAgent", { id: "concurrent-create", name: "Concurrent create" });
      expect(created.status).toBe(200);

      releaseFlush();
      expect((await deleting).status).toBe(200);
    } finally {
      flush.mockRestore();
    }

    expect(handle.config.snapshot().agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "survivor", name: "Survivor updated" }),
      expect.objectContaining({ id: "concurrent-create", name: "Concurrent create" }),
    ]));
    expect(handle.config.snapshot().agents.some((agent) => agent.id === "openbot-default")).toBe(false);
  });

  it("serializa exclusões concorrentes antes de permitir recriar o mesmo id", async () => {
    const handle = await bootEmpty();
    expect((await post(handle, "createAgent", { id: "delete-recreate", name: "Original" })).status).toBe(200);
    const homes = handle.homes!;
    const originalRemove = homes.remove.bind(homes);
    let removeCalls = 0;
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstEntry = new Promise<void>((resolve) => { firstEntered = resolve; });
    homes.remove = (async (agentId: string) => {
      removeCalls += 1;
      if (removeCalls === 1) {
        firstEntered();
        await firstRelease;
      }
      return originalRemove(agentId);
    });

    const firstDelete = post(handle, "deleteAgents", { ids: ["delete-recreate"] });
    await firstEntry;
    const secondDeleteReceived = nextRpcRequest(handle, "deleteAgents");
    const secondDelete = post(handle, "deleteAgents", { ids: ["delete-recreate"] });
    const recreateReceived = nextRpcRequest(handle, "createAgent");
    const recreated = post(handle, "createAgent", { id: "delete-recreate", name: "Recreated" });
    try {
      await Promise.all([secondDeleteReceived, recreateReceived]);
    } finally {
      releaseFirst();
    }

    await expect(firstDelete).resolves.toMatchObject({ status: 200 });
    await expect(secondDelete).resolves.toMatchObject({ status: 200 });
    await expect(recreated).resolves.toMatchObject({ status: 200 });
    expect(handle.config.snapshot().agents).toEqual([
      expect.objectContaining({ id: "delete-recreate", name: "Recreated" }),
    ]);
    expect(removeCalls).toBe(1);
  });

  it("não ressuscita o agente quando avatar e exclusão concorrem", async () => {
    const handle = await bootEmpty();
    expect((await post(handle, "createAgent", { id: "avatar-delete", name: "Avatar delete" })).status).toBe(200);
    const homes = handle.homes!;
    const originalEnsure = homes.ensure.bind(homes);
    let releaseEnsure!: () => void;
    const ensureRelease = new Promise<void>((resolve) => { releaseEnsure = resolve; });
    let ensureEntered!: () => void;
    const ensureEntry = new Promise<void>((resolve) => { ensureEntered = resolve; });
    let blocked = false;
    homes.ensure = (async (agentId: string) => {
      if (agentId === "avatar-delete" && !blocked) {
        blocked = true;
        ensureEntered();
        await ensureRelease;
      }
      return originalEnsure(agentId);
    });
    const pngBase64 = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");

    const avatar = post(handle, "setAgentAvatarBytes", { id: "avatar-delete", pngBase64 });
    await ensureEntry;
    const deletionReceived = nextRpcRequest(handle, "deleteAgents");
    const deletion = post(handle, "deleteAgents", { ids: ["avatar-delete"] });
    try {
      await deletionReceived;
    } finally {
      releaseEnsure();
    }

    await expect(avatar).resolves.toMatchObject({ status: 200 });
    await expect(deletion).resolves.toMatchObject({ status: 200 });
    expect(handle.config.snapshot().agents).toEqual([]);
    expect(existsSync(handle.homes!.pathFor("avatar-delete"))).toBe(false);
  });

  it("rejeita sendPrompt enquanto deleteAgents aguarda o turno em voo", async () => {
    const handle = await boot();
    const created = await post(handle, "createAgent", { id: "fenced-victim", name: "Fenced victim" });
    expect(created.status).toBe(200);

    let turn1StartedResolve!: () => void;
    const turn1Started = new Promise<void>((resolve) => { turn1StartedResolve = resolve; });
    let deletionAbortResolve!: () => void;
    const deletionAbort = new Promise<void>((resolve) => { deletionAbortResolve = resolve; });
    let releaseTurn1!: () => void;
    const turn1Release = new Promise<void>((resolve) => { releaseTurn1 = resolve; });
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        calls += 1;
        if (calls === 1) {
          turn1StartedResolve();
          request.signal?.addEventListener("abort", deletionAbortResolve, { once: true });
          await turn1Release;
        }
        emit({ type: "delta", delta: `turn ${calls}` });
      },
    };
    handle.registry.register(adapter);
    handle.runner.sendPrompt({ agentId: "fenced-victim", prompt: "turn 1", clientNonce: "fence:1" });
    await turn1Started;

    const deleting = post(handle, "deleteAgents", { ids: ["fenced-victim"] });
    await deletionAbort;
    const send2 = await post(handle, "sendPrompt", {
      agentId: "fenced-victim",
      prompt: "turn 2",
      clientNonce: "fence:2",
    });

    releaseTurn1();
    const deleted = await deleting;
    await handle.runner.flush("fenced-victim");

    expect(send2.status).toBe(409);
    expect(deleted.status).toBe(200);
    expect(calls).toBe(1);
    expect(handle.store.getEntries("fenced-victim")).toEqual([]);
  });

  it("setAgentAvatarBytes restaura arquivo quando config.mutate falha", async () => {
    const handle = await boot();
    const created = await post(handle, "createAgent", { name: "Rollback avatar", origin: "user" });
    const id = (created.json.value as { agent: { id: string } }).agent.id;
    const previousPngBase64 = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");
    const nextPngBase64 = Buffer.from("89504e470d0a1a0a00000001", "hex").toString("base64");
    expect((await post(handle, "setAgentAvatarBytes", { id, pngBase64: previousPngBase64 })).status).toBe(200);
    const avatarPath = join(handle.homes!.pathFor(id), ".openbot", "avatar.png");
    const before = readFileSync(avatarPath);
    const originalMutate = handle.config.mutate.bind(handle.config);
    handle.config.mutate = (() => { throw new Error("config mutate failed"); });
    try {
      const failed = await post(handle, "setAgentAvatarBytes", { id, pngBase64: nextPngBase64 });
      expect(failed.status).toBe(500);
    } finally {
      handle.config.mutate = originalMutate;
    }
    expect(readFileSync(avatarPath)).toEqual(before);
    expect(handle.config.snapshot().agents.find((agent) => agent.id === id)).toMatchObject({
      hasCustomAvatar: true,
    });
    expect(handle.config.snapshot().agents.find((agent) => agent.id === id)?.avatarPngBase64)
      .toBeUndefined();
  });

  it("não persiste agente quando a criação da home falha", async () => {
    const handle = await boot();
    const root = handle.homes!.pathFor("ghost");
    mkdirSync(join(root, ".openbot"), { recursive: true });
    writeFileSync(join(root, ".openbot", "home.json"), JSON.stringify({ agentId: "other", layoutVersion: 1, createdAt: new Date().toISOString() }));
    const created = await post(handle, "createAgent", { id: "ghost", name: "Ghost" });
    expect(created.status).toBe(500);
    expect(handle.config.snapshot().agents.some((agent) => agent.id === "ghost")).toBe(false);
  });

  it("remove a home recém-criada quando o commit do createAgent falha", async () => {
    const handle = await bootEmpty();
    const originalUpdate = handle.config.update.bind(handle.config);
    handle.config.update = (() => { throw new Error("config update failed"); });
    try {
      expect((await post(handle, "createAgent", { id: "create-rollback", name: "Create rollback" })).status).toBe(500);
    } finally {
      handle.config.update = originalUpdate;
    }

    expect(existsSync(handle.homes!.pathFor("create-rollback"))).toBe(false);
    expect(handle.config.snapshot().agents).toEqual([]);
    expect((await handle.homes!.listQuarantine()).map((entry) => entry.agentId)).toEqual(["create-rollback"]);
  });

  it("remove a home recém-criada quando o commit do duplicateAgent falha", async () => {
    const handle = await bootEmpty();
    await post(handle, "createAgent", { id: "duplicate-source", name: "Duplicate source" });
    const originalUpdate = handle.config.update.bind(handle.config);
    handle.config.update = (() => { throw new Error("config update failed"); });
    try {
      expect((await post(handle, "duplicateAgent", { agentId: "duplicate-source" })).status).toBe(500);
    } finally {
      handle.config.update = originalUpdate;
    }

    const activeIds = handle.config.snapshot().agents.map((agent) => agent.id);
    expect(activeIds).toEqual(["duplicate-source"]);
    const quarantined = await handle.homes!.listQuarantine();
    expect(quarantined).toHaveLength(1);
    expect(existsSync(handle.homes!.pathFor(quarantined[0]!.agentId))).toBe(false);
  });

  it.sequential("testa o endpoint do provider selecionado usando a chave salva", async () => {
    const handle = await boot();
    await post(handle, "setBoxSecrets", { secrets: { openai: "saved-openai-key" } });
    const realFetch = globalThis.fetch;
    const upstream: { url: string; authorization?: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(`http://127.0.0.1:${handle.port}/`)) return realFetch(input, init);
      const headers = new Headers(init?.headers);
      upstream.push({ url, authorization: headers.get("authorization") ?? undefined });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }), { status: 200 });
    });
    try {
      const tested = await post(handle, "testProviderConnection", {
        agentId: "openbot-default",
        provider: "openai",
        baseURL: "https://attacker.invalid/v1",
      });

      expect(tested.status).toBe(200);
      expect(tested.json.ok).toBe(true);
      expect(upstream).toEqual([{ url: "https://api.openai.com/v1/models", authorization: "Bearer saved-openai-key" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("kickstartAgent não deixa introdução pendente", async () => {
    const handle = await boot();
    const kicked = await post(handle, "kickstartAgent", { id: "openbot-default" });
    expect(kicked.json).toMatchObject({ ok: true, value: { isIntroductionInFlight: false } });
  });

  it("openAgentTail aceita o limit 500 do cliente", async () => {
    const handle = await boot();
    const page = await post(handle, "openAgentTail", { id: "openbot-default", limit: 500 });
    expect(page.status).toBe(200);
    expect(page.json.ok).toBe(true);
    const value = page.json.value as { entries: unknown[]; nextBeforeSeq?: string };
    expect(Array.isArray(value.entries)).toBe(true);
  });

  it("setBoxSecrets aceita o mapa secrets do Electron", async () => {
    const handle = await boot();
    const saved = await post(handle, "setBoxSecrets", { secrets: { xai: "test-key-xai" } });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ ok: true, value: { upserted: ["xai"] } });
    expect(typeof (saved.json.value as { synced?: boolean }).synced).toBe("boolean");
    const status = await post(handle, "getBoxSecretsStatus", {});
    expect(status.json.ok).toBe(true);
    const names = (status.json.value as { secrets: string[] }).secrets;
    expect(names).toContain("xai");
    expect(JSON.stringify(status.json)).not.toContain("test-key-xai");
  });

  it("sendPrompt aceita text do composer e attachmentPaths", async () => {
    const handle = await boot();
    const attachmentPath = join(handle.homes!.pathFor("openbot-default"), "Documents", "fixture.txt");
    mkdirSync(join(handle.homes!.pathFor("openbot-default"), "Documents"), { recursive: true });
    writeFileSync(attachmentPath, "fixture attachment", "utf8");
    const composerPayload = {
      id: "openbot-default",
      text: "Teste",
      clientNonce: "n1",
      attachmentPaths: [attachmentPath],
      attachmentNames: ["renamed-fixture.txt"],
    };
    expect(normalizeSendPrompt(composerPayload)).toMatchObject({
      agentId: "openbot-default",
      prompt: "Teste",
      attachments: [{ path: attachmentPath, name: "renamed-fixture.txt" }],
    });
    const sent = await post(handle, "sendPrompt", composerPayload);
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ ok: true, value: { accepted: true } });
  });
});
