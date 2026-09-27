import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { ConfigStore } from "../src/config/store.js";

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

// Concurrent tests must register cleanup on their own context, never the global hook.
async function boot(onTestFinished: RegisterCleanup, seedDefault = true) {
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

const bootEmpty = (onTestFinished: RegisterCleanup) => boot(onTestFinished, false);

async function post(handle: ServerHandle, method: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as { ok: boolean; value?: unknown; failure?: string } };
}


describe.concurrent("roster multi-agent", () => {

  it("setProviderConfig grava provider e modelo juntos", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const saved = await post(handle, "setProviderConfig", { provider: "openai", model: "gpt-5.6-sol" });
    expect(saved.json).toMatchObject({ ok: true, value: { provider: "openai", model: "gpt-5.6-sol" } });
    const read = await post(handle, "getProviderConfig", {});
    expect(read.json).toMatchObject({ ok: true, value: { provider: "openai", model: "gpt-5.6-sol" } });
    const def = await post(handle, "getAgentDefaultModel", {});
    expect(def.json).toMatchObject({ ok: true, value: { model: "gpt-5.6-sol", modelId: "gpt-5.6-sol" } });
  });

  it("get/setAgentDefaultModel devolvem esforço e Fast efetivos do agente", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const agentId = "openbot-default";
    const provider = await post(handle, "setProviderConfig", {
      agentId,
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      serviceTier: "default",
    });
    expect(provider.status).toBe(200);

    const current = await post(handle, "getAgentDefaultModel", { agentId });
    expect(current.json).toMatchObject({
      ok: true,
      value: {
        model: "gpt-5.6-sol",
        modelId: "gpt-5.6-sol",
        maxMode: true,
        parameters: [
          { id: "effort", value: "low" },
          { id: "fast", value: "false" },
        ],
      },
    });

    const changed = await post(handle, "setAgentDefaultModel", { agentId, model: "gpt-5.6-terra" });
    expect(changed.json).toMatchObject({
      ok: true,
      value: {
        model: "gpt-5.6-terra",
        modelId: "gpt-5.6-terra",
        parameters: [
          { id: "effort", value: "low" },
          { id: "fast", value: "false" },
        ],
      },
    });
  });

  it("recusa selecionar openai-compat sem baseURL", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);

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

  it("não remove a baseURL enquanto openai-compat está em uso", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("ressincroniza o adapter ao selecionar openai-compat com baseURL válida", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("recusa valores não booleanos nos quatro handlers de flags", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const agentId = "openbot-default";
    const results = [
      await post(handle, "setAgentUnread", { agentId, unread: "false" }),
      await post(handle, "setAgentHiddenFromSidebar", { agentId, hidden: "false" }),
      await post(handle, "setAgentNotificationsEnabled", { agentId, enabled: "false" }),
      await post(handle, "setAgentNotifyOnUpdates", { agentId, enabled: "false" }),
    ];

    expect(results.map((result) => result.status)).toEqual([400, 400, 400, 400]);
  });

  it.sequential("updateAgent devolve exatamente o updatedAt persistido", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("updateAgent persiste Title independente de Name e o restaura do disco", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);

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

  it("duplicateAgent preserva o Title explícito e mantém o Name da cópia independente", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("duplicateAgent carrega o avatar customizado para a cópia", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const created = await post(handle, "createAgent", { name: "Com foto", origin: "user" });
    const id = (created.json.value as { agent: { id: string } }).agent.id;
    const pngBase64 = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");
    expect((await post(handle, "setAgentAvatarBytes", { id, pngBase64 })).status).toBe(200);

    const duplicated = await post(handle, "duplicateAgent", { agentId: id });

    expect(duplicated.status).toBe(200);
    const copyId = (duplicated.json.value as { agent: { id: string; hasCustomPicture: boolean } }).agent.id;
    expect((duplicated.json.value as { agent: { hasCustomPicture: boolean } }).agent.hasCustomPicture).toBe(true);
    const avatar = await post(handle, "getAgentAvatar", { id: copyId });
    expect(avatar.json).toMatchObject({ ok: true, value: { pngBase64 } });
    expect(handle.config.snapshot().agents.find((agent) => agent.id === copyId)).toMatchObject({ hasCustomAvatar: true });
  });

  it("duplicateAgent materializa o Title efetivo de um registro legado", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    expect(handle.config.snapshot().agents[0]?.title).toBeUndefined();

    const duplicated = await post(handle, "duplicateAgent", { agentId: "openbot-default" });

    expect(duplicated.json.value).toMatchObject({
      agent: { name: "Local User (cópia)", title: "Local User" },
    });
    expect(handle.config.snapshot().agents[1]).toMatchObject({ title: "Local User" });
  });

  it("configuração com agentId altera somente o agente alvo", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("configuração sem agentId aplica ao bot ativo sem alterar o global", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("sem bots, setAgentDefaultModel persiste modelo e provider globais do catálogo", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);

    const saved = await post(handle, "setAgentDefaultModel", { model: "gpt-5.6-sol" });

    expect(saved.status).toBe(200);
    expect(handle.config.snapshot()).toMatchObject({ globalModel: "gpt-5.6-sol", activeProvider: "openai", agents: [] });
  });

  it("sem bots, settings global salva provider e modelo com a proteção de bot ativo", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);

    const saved = await post(handle, "setProviderConfig", {
      requireActive: true,
      provider: "openai",
      model: "gpt-5.6-sol",
    });

    expect(saved.status).toBe(200);
    expect(handle.config.snapshot()).toMatchObject({ globalModel: "gpt-5.6-sol", activeProvider: "openai", agents: [] });
  });

  it("sem bots, rejeita modelo custom explicitamente", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    await post(handle, "setProviderConfig", { baseURL: "http://127.0.0.1:1234/v1" });

    const rejected = await post(handle, "setAgentDefaultModel", { model: "custom-local-model" });

    expect(rejected.status).toBe(400);
    expect(rejected.json.failure).toContain("modelo custom exige um agente");
    expect(handle.config.snapshot()).toMatchObject({ globalModel: "grok-4.6", activeProvider: "xai", agents: [] });
  });
});
