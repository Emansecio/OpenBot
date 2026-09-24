import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { ConfigStore } from "../src/config/store.js";
import { normalizeSendPrompt } from "../src/rpc/send.js";

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
  it("mantém o estado inicial sem bots e rejeita operações que exigem um agente", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    expect(handle.config.snapshot().agents).toEqual([]);
    expect((await post(handle, "listAgents", {})).json).toMatchObject({ ok: true, value: [] });
    expect((await post(handle, "getAgent", { id: "missing" })).status).toBe(400);
    expect((await post(handle, "openAgent", {})).status).toBe(400);
    expect((await post(handle, "getLocalRuntimeStatus", {})).status).toBe(400);
  });

  it("persiste nome e aparência do perfil local sem criar um bot", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);

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

  it("createAgent devolve {agent} no shape do cliente e listAgents o inclui", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("permite que um bot crie e configure outro bot pela ferramenta nativa", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("rejeita configuração incompatível da ferramenta antes de criar resíduos", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("serializa criações concorrentes do mesmo id sem quarentenar a home vencedora", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    const results = await Promise.all([
      post(handle, "createAgent", { id: "same-id", name: "Primeiro" }),
      post(handle, "createAgent", { id: "same-id", name: "Segundo" }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(handle.config.snapshot().agents.filter((agent) => agent.id === "same-id")).toHaveLength(1);
    expect(existsSync(handle.homes!.pathFor("same-id"))).toBe(true);
    expect(await handle.homes!.listQuarantine()).toEqual([]);
  });

  it("torna idempotente uma rajada da mesma criação sem id explícito", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    const results = await Promise.all(Array.from({ length: 6 }, () => (
      post(handle, "createAgent", { name: "New Bot", origin: "user" })
    )));

    expect(results.every((result) => result.status === 200)).toBe(true);
    const ids = results.map((result) => (result.json.value as { agent: { id: string } }).agent.id);
    expect(new Set(ids).size).toBe(1);
    expect(handle.config.snapshot().agents).toHaveLength(1);
  });

  it("createAgent materializa Title igual ao Name e mantém os campos independentes", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
    const created = await post(handle, "createAgent", { name: "Atlas" });
    const agent = (created.json.value as { agent: { id: string; name: string; title: string } }).agent;

    expect(agent).toMatchObject({ name: "Atlas", title: "Atlas" });
    expect(handle.config.snapshot().agents[0]).toMatchObject({ name: "Atlas", title: "Atlas" });

    const renamed = await post(handle, "updateAgent", { agentId: agent.id, name: "Atlas Prime" });
    expect(renamed.json.value).toMatchObject({ name: "Atlas Prime", title: "Atlas" });
  });

  it("rejeita Title inválido ou vazio sem alterar o agente", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);

    expect((await post(handle, "updateAgent", { agentId: "openbot-default", title: 42 })).status).toBe(400);
    expect((await post(handle, "updateAgent", { agentId: "openbot-default", title: "   " })).status).toBe(400);
    expect(handle.config.snapshot().agents[0]).toMatchObject({
      id: "openbot-default",
      name: "Local User",
    });
    expect(handle.config.snapshot().agents[0]?.title).toBeUndefined();
  });

  it("setAgentAvatarBytes persiste e getAgentAvatar devolve o png", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("setAgentAvatarBytes restaura arquivo quando config.mutate falha", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("não persiste agente quando a criação da home falha", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const root = handle.homes!.pathFor("ghost");
    mkdirSync(join(root, ".openbot"), { recursive: true });
    writeFileSync(join(root, ".openbot", "home.json"), JSON.stringify({ agentId: "other", layoutVersion: 1, createdAt: new Date().toISOString() }));
    const created = await post(handle, "createAgent", { id: "ghost", name: "Ghost" });
    expect(created.status).toBe(500);
    expect(handle.config.snapshot().agents.some((agent) => agent.id === "ghost")).toBe(false);
  });

  it("remove a home recém-criada quando o commit do createAgent falha", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
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

  it("remove a home recém-criada quando o commit do duplicateAgent falha", async ({ onTestFinished }) => {
    const handle = await bootEmpty(onTestFinished);
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

  it.sequential("testa o endpoint do provider selecionado usando a chave salva", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("kickstartAgent não deixa introdução pendente", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const kicked = await post(handle, "kickstartAgent", { id: "openbot-default" });
    expect(kicked.json).toMatchObject({ ok: true, value: { isIntroductionInFlight: false } });
  });

  it("openAgentTail aceita o limit 500 do cliente", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
    const page = await post(handle, "openAgentTail", { id: "openbot-default", limit: 500 });
    expect(page.status).toBe(200);
    expect(page.json.ok).toBe(true);
    const value = page.json.value as { entries: unknown[]; nextBeforeSeq?: string };
    expect(Array.isArray(value.entries)).toBe(true);
  });

  it("setBoxSecrets aceita o mapa secrets do Electron", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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

  it("sendPrompt aceita text do composer e attachmentPaths", async ({ onTestFinished }) => {
    const handle = await boot(onTestFinished);
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
