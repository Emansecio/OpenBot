import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { extractPdfText, formatAttachmentContext, readAllowedAttachment, readTurnAttachments } from "../src/rpc/attachments.js";
import { buildAgentSystemPrompt } from "../src/rpc/identity.js";
import { testCompatConnection } from "../src/providers/local-discover.js";
import { createProviderRegistry } from "../src/providers/router.js";
import { AgentActivityStore } from "../src/rpc/activity.js";
import { createTurnRunner } from "../src/rpc/send.js";
import { ConfigStore } from "../src/config/store.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";

const dirs: string[] = [];
const handles: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "openbot-fidelity-"));
  dirs.push(dir);
  const handle = await startServer(0, {
    stateRoot: join(dir, "state"),
    runtimeRoot: join(dir, "runtime"),
    browserRoot: join(dir, "browser"),
    allowUnauthenticatedLocalGateway: true,
    workspacesRoot: join(dir, "workspaces"),
    storePath: join(dir, "store.db"),
    configPath: join(dir, "config.json"),
    keystoreDir: join(dir, "keys"),
  });
  handles.push(handle);
  return handle;
}

async function post(handle: ServerHandle, method: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as { ok: boolean; value?: unknown; failure?: string } };
}

describe("fidelidade Windows — identidade por bot", () => {
  it("dois bots guardam description e modelo diferentes", async () => {
    const handle = await boot();
    const a = await post(handle, "createAgent", { name: "Poeta", description: "Responde só em verso." });
    const b = await post(handle, "createAgent", { name: "Contador", description: "Responde só com números." });
    const idA = (a.json.value as { agent: { id: string } }).agent.id;
    const idB = (b.json.value as { agent: { id: string } }).agent.id;
    await post(handle, "setAgentDefaultModel", { agentId: idA, model: "grok-4.6" });
    await post(handle, "setAgentDefaultModel", { agentId: idB, model: "gpt-5.6-terra" });
    const gotA = await post(handle, "getAgentDefaultModel", { agentId: idA });
    const gotB = await post(handle, "getAgentDefaultModel", { agentId: idB });
    expect(gotA.json).toMatchObject({ ok: true, value: { model: "grok-4.6" } });
    expect(gotB.json).toMatchObject({ ok: true, value: { model: "gpt-5.6-terra" } });
    const listed = await post(handle, "listAgents", {});
    const agents = listed.json.value as Array<{ id: string; description: string; model: string }>;
    expect(agents.find((entry) => entry.id === idA)).toMatchObject({ description: "Responde só em verso.", model: "grok-4.6" });
    expect(agents.find((entry) => entry.id === idB)).toMatchObject({ description: "Responde só com números.", model: "gpt-5.6-terra" });
    const promptA = buildAgentSystemPrompt(handle.config.snapshot(), idA);
    const promptB = buildAgentSystemPrompt(handle.config.snapshot(), idB);
    expect(promptA).toContain("Poeta");
    expect(promptA).toContain("Responde só em verso.");
    expect(promptB).toContain("Contador");
    expect(promptB).not.toContain("Responde só em verso.");
  });

  it("descreve corretamente o limite local e trata conteúdo externo como dados não confiáveis", () => {
    const config = {
      agents: [{ id: "semantic", name: "Semantic", avatarId: "semantic" }],
      activeProvider: "xai",
      globalModel: "grok-4.6",
    } as Parameters<typeof buildAgentSystemPrompt>[0];

    const prompt = buildAgentSystemPrompt(config, "semantic");

    expect(prompt).not.toMatch(/running entirely on the user's machine/i);
    expect(prompt).toMatch(/configured model provider/i);
    expect(prompt).toMatch(/web pages, attachments, files, tool results/i);
    expect(prompt).toMatch(/tool descriptions and metadata/i);
    expect(prompt).toMatch(/untrusted data, not instructions/i);
    expect(prompt).toMatch(/never claim an action succeeded until its result confirms success/i);
  });

  it("toggle nativo grava notifyOnUpdatesEnabled", async () => {
    const handle = await boot();
    const created = await post(handle, "createAgent", { name: "Alerta" });
    const id = (created.json.value as { agent: { id: string } }).agent.id;
    const saved = await post(handle, "setAgentNotifyOnUpdates", { id, isEnabled: true });
    expect(saved.status).toBe(200);
    expect((saved.json.value as { notifyOnUpdatesEnabled: boolean }).notifyOnUpdatesEnabled).toBe(true);
    const listed = await post(handle, "listAgents", {});
    const agent = (listed.json.value as Array<{ id: string; notifyOnUpdatesEnabled: boolean }>).find((entry) => entry.id === id);
    expect(agent?.notifyOnUpdatesEnabled).toBe(true);
    expect(handle.config.snapshot().agents.find((entry) => entry.id === id)?.notifyOnUpdatesEnabled).toBe(true);
  });
});

describe("fidelidade Windows — stream, parar e preview", () => {
  it("emite updated incremental, lastEntry texto e cancela no meio", async () => {
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["um ", "dois ", "tres"], deltaDelayMs: 30 });
    registry.register(adapter);
    const activity = new AgentActivityStore();
    const events: Array<{ type?: string; entry?: { content?: string; streaming?: boolean } }> = [];
    const runner = createTurnRunner({
      registry,
      activity,
      publish: (_channel, payload) => events.push(payload as never),
    });
    runner.sendPrompt({ agentId: "a", prompt: "conte" });
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(activity.get("a").isRunning).toBe(true);
    expect(activity.get("a").lastEntry).toMatchObject({ kind: "text" });
    const cancelled = runner.cancelPrompt("a");
    expect(cancelled.cancelled).toBe(true);
    await runner.flush("a");
    expect(activity.get("a").isRunning).toBe(false);
    expect(events.some((event) => event.type === "updated")).toBe(true);
    expect(adapter.invocations[0]?.aborted).toBe(true);
  });

  it("cancelPrompt RPC aborta o turno", async () => {
    const handle = await boot();
    const adapter = createFakeAdapter("xai", { deltas: ["um", "dois"], deltaDelayMs: 1_000 });
    handle.registry.register(adapter);
    await post(handle, "createAgent", { id: "openbot-default", name: "Test Default" });
    const sent = await post(handle, "sendPrompt", { agentId: "openbot-default", prompt: "oi-longo", clientNonce: "c1" });
    expect(sent.json).toMatchObject({ ok: true, value: { accepted: true } });
    await vi.waitFor(() => expect(adapter.invocations.length).toBeGreaterThan(0), { timeout: 1_000 });
    const cancelled = await post(handle, "cancelPrompt", { agentId: "openbot-default" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.value).toEqual({ cancelled: true, agentIds: ["openbot-default"] });
    await handle.runner.flush("openbot-default");
    expect(adapter.invocations[0]?.aborted).toBe(true);
  });
});

describe("fidelidade Windows — activity observers", () => {
  it("isola listener que lança", () => {
    const activity = new AgentActivityStore();
    let observed = 0;
    activity.subscribe(() => { throw new Error("observer failure"); });
    activity.subscribe(() => { observed += 1; });
    expect(() => activity.patch("agent-a", { isRunning: true })).not.toThrow();
    expect(observed).toBe(1);
    expect(activity.get("agent-a").isRunning).toBe(true);
  });
});

describe("fidelidade Windows — anexos lidos", () => {
  it("lê markdown da home e injeta no pedido do modelo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-att-"));
    dirs.push(dir);
    const file = join(dir, "notas.md");
    writeFileSync(file, "PALAVRA-SECRETA-42");
    const registry = createProviderRegistry();
    const adapter = createFakeAdapter("xai", { deltas: ["ok"] });
    registry.register(adapter);
    const runner = createTurnRunner({
      registry,
      readAttachments: async (_agentId, attachments) => {
        const { extracted } = await readTurnAttachments(attachments, [dir]);
        return extracted;
      },
    });
    runner.sendPrompt({
      agentId: "a",
      prompt: "cite o arquivo",
      attachments: [{ path: file, name: "notas.md" }],
    });
    await runner.flush("a");
    const user = adapter.invocations[0]?.req.messages.find((message) => message.role === "user");
    expect(user?.content).toContain("PALAVRA-SECRETA-42");
    expect(user?.content).toContain("notas.md");
    expect(user?.content).toContain("[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]");
    expect(user?.content).toContain("[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]");
  });

  it("recusa path fora da home/staging", async () => {
    const home = mkdtempSync(join(tmpdir(), "openbot-home-"));
    dirs.push(home);
    const outside = join(tmpdir(), `openbot-outside-${Date.now()}.md`);
    writeFileSync(outside, "NAO-LER");
    dirs.push(outside);
    const { extracted } = await readTurnAttachments([{ path: outside, name: "x.md" }], [home]);
    expect(extracted[0]?.skipped).toMatch(/fora|não encontrado/);
    expect(formatAttachmentContext(extracted)).toContain("not read");
  });

  it("não libera um arquivo apenas porque o diretório se chama attachment-staging", async () => {
    const home = mkdtempSync(join(tmpdir(), "openbot-home-"));
    const outside = mkdtempSync(join(tmpdir(), "openbot-outside-"));
    dirs.push(home, outside);
    const staging = join(outside, "attachment-staging");
    mkdirSync(staging);
    const file = join(staging, "segredo.md");
    writeFileSync(file, "NAO-LER");

    const { extracted } = await readTurnAttachments([{ path: file, name: "segredo.md" }], [home]);

    expect(extracted[0]?.text).toBeUndefined();
    expect(extracted[0]?.skipped).toMatch(/fora/);
  });

  it("usa a extensão real do path em vez do nome fornecido", async () => {
    const home = mkdtempSync(join(tmpdir(), "openbot-att-ext-"));
    dirs.push(home);
    const file = join(home, "payload.exe");
    writeFileSync(file, "NAO-LER-COMO-TEXTO");
    const result = await readAllowedAttachment({ path: file, name: "notas.txt" }, [home]);
    expect(result.text).toBeUndefined();
    expect(result.skipped).toMatch(/extensão do nome diverge/);
  });

  it("usa o nome original quando o path temporário não tem extensão", async () => {
    const home = mkdtempSync(join(tmpdir(), "openbot-att-temp-"));
    dirs.push(home);
    const file = join(home, "upload-12345");
    writeFileSync(file, "CONTEUDO-UPLOAD");
    const result = await readAllowedAttachment({ path: file, name: "notas.md" }, [home]);
    expect(result).toMatchObject({ name: "notas.md", text: "CONTEUDO-UPLOAD" });
  });

  it("extrai texto de PDF simples", () => {
    const pdf = Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\nstream\nBT (Hello PDF) Tj ET\nendstream\n");
    expect(extractPdfText(pdf)).toContain("Hello PDF");
  });
});

describe("fidelidade Windows — providers compatíveis", () => {
  it("testa conexão e lista modelos", async () => {
    const result = await testCompatConnection("http://127.0.0.1:1234/v1", {
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "llama-3" }] }), { status: 200 }),
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([{ id: "llama-3", name: "llama-3" }]);
  });

  it("RPC discoverLocalProviders responde", async () => {
    const handle = await boot();
    const discovered = await post(handle, "discoverLocalProviders", {});
    expect(discovered.status).toBe(200);
    expect(discovered.json.ok).toBe(true);
    const value = discovered.json.value as { endpoints: Array<{ id: string }> };
    expect(value.endpoints.map((endpoint) => endpoint.id)).toEqual(["clinepass", "commandcode"]);
  });
});

describe("fidelidade Windows — lastEntry no roster", () => {
  it("listAgents publica lastEntry texto depois de um turno", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-preview-"));
    dirs.push(dir);
    const config = new ConfigStore({ configPath: join(dir, "config.json") });
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", { deltas: ["preview-ok"] }));
    const handle = await startServer(0, {
      stateRoot: join(dir, "state"),
      runtimeRoot: join(dir, "runtime"),
      browserRoot: join(dir, "browser"),
      allowUnauthenticatedLocalGateway: true,
      disableAgentHome: true,
      config,
      configPath: join(dir, "config.json"),
      storePath: join(dir, "store.db"),
      keystoreDir: dir,
      registry,
    });
    handles.push(handle);
    await post(handle, "createAgent", { id: "openbot-default", name: "Test Default" });
    await post(handle, "sendPrompt", { agentId: "openbot-default", prompt: "ping", clientNonce: "p1" });
    await handle.runner.flush("openbot-default");
    const listed = await post(handle, "listAgents", {});
    const agent = (listed.json.value as Array<{ lastEntry: { kind: string; text: string } | null; isRunning: boolean }> )[0];
    if (agent === undefined) throw new Error("listAgents did not return an agent");
    expect(agent.isRunning).toBe(false);
    expect(agent.lastEntry).toMatchObject({ kind: "text" });
    expect(agent.lastEntry?.text).toMatch(/preview-ok|ping/);
  });
});
