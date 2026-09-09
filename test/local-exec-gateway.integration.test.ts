import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { LocalExecutionBroker } from "../src/execution/broker.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";
import { GATEWAY_HOST, startServer, stopServer, type ServerHandle } from "../src/main.js";
import { createProviderRegistry, type ProviderAdapter, type ProviderChatRequest } from "../src/providers/router.js";

let handle: ServerHandle | undefined; let dir: string | undefined;
afterEach(async () => { if (handle) await stopServer(handle); handle = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const turnRequests = (requests: ProviderChatRequest[]) => requests.filter((request) => (request.purpose ?? "turn") === "turn");
const post = (h: ServerHandle, path: string, body: unknown) => new Promise<{status:number; json:any}>((resolve, reject) => {
  const req = http.request({ host: GATEWAY_HOST, port: h.port, path, method: "POST", headers: { "content-type": "application/json" }, agent: false }, (res) => {
    const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }));
  }); req.on("error", reject); req.end(JSON.stringify(body));
});
async function waitForStoreClosed(h: ServerHandle, agentId: string, conversationId: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      h.store.getEntries(agentId, conversationId);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`store close timeout after ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
class Backend implements ExecutionBackend { calls: ExecutionRequest[] = []; async execute(request: ExecutionRequest): Promise<ExecutionResult> { this.calls.push(request); return { ok: true, operation: "file.list", entries: [] }; } }

describe("local tool approval through gateway", () => {
  it("stopServer aborta aprovações pendentes", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-local-exec-stop-"));
    const backend = new Backend();
    const broker = new LocalExecutionBroker(backend, () => "ask");
    handle = await startServer(0, { executionBroker: broker, stateRoot: join(dir, "state"), runtimeRoot: join(dir, "runtime"), browserRoot: join(dir, "browser"), allowUnauthenticatedLocalGateway: true, storePath: join(dir, "store.db"), configPath: join(dir, "config.json"), keystoreDir: join(dir, "keys"), workspacesRoot: join(dir, "workspaces") });
    const pending = broker.execute("openbot-default", "stop-1", { operation: "file.list", path: "." });
    expect(broker.pendingCount).toBe(1);
    await stopServer(handle); handle = undefined;
    await expect(pending).resolves.toMatchObject({ ok: false, code: "aborted" });
    expect(broker.pendingCount).toBe(0);
    expect(backend.calls).toHaveLength(0);
  });

  it("resolveLocalToolPermission distingue aprovação expirada", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-local-exec-expired-"));
    const broker = new LocalExecutionBroker(new Backend(), () => "ask", undefined, 10);
    handle = await startServer(0, {
      executionBroker: broker,
      stateRoot: join(dir, "state"), runtimeRoot: join(dir, "runtime"), browserRoot: join(dir, "browser"),
      allowUnauthenticatedLocalGateway: true,
      storePath: join(dir, "store.db"), configPath: join(dir, "config.json"), keystoreDir: join(dir, "keys"),
      workspacesRoot: join(dir, "workspaces"),
    });

    await expect(broker.execute("openbot-default", "expired-1", { operation: "file.list", path: "." }))
      .resolves.toMatchObject({ ok: false, code: "permission_denied", message: "Approval request timed out." });
    const late = await post(handle, "/api/resolveLocalToolPermission", {
      agentId: "openbot-default",
      requestId: "expired-1",
      decision: "allow",
    });
    expect(late.status).toBe(409);
    expect(late.json.failure).toMatch(/expirada/i);
  });

  it("resolveLocalToolPermission libera o turno pendente", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-local-exec-"));
    const config = new ConfigStore({ configPath: join(dir, "config.json") });
    config.setHostSettings({ ...config.snapshot().hostSettings, localToolPermission: "ask" });
    const backend = new Backend();
    const broker = new LocalExecutionBroker(backend, () => config.snapshot().hostSettings.localToolPermission ?? "ask");
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = { name: "xai", async streamChat(request, emit) {
      requests.push(request);
      if (requests.length === 1) emit({ type: "tool-call", call: { id: "approval-1", type: "function", function: { name: "file", arguments: '{"op":"list","path":"."}' } } });
      else emit({ type: "delta", delta: "feito" });
    } };
    const registry = createProviderRegistry(); registry.register(adapter);
    handle = await startServer(0, {
      config, registry, executionBroker: broker,
      stateRoot: join(dir, "state"), runtimeRoot: join(dir, "runtime"), browserRoot: join(dir, "browser"), allowUnauthenticatedLocalGateway: true,
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      storePath: join(dir, "store.db"), keystoreDir: join(dir, "keys"),
      workspacesRoot: join(dir, "workspaces"),
    });

    expect((await post(handle, "/api/createAgent", { id: "openbot-default", name: "Test Default" })).status).toBe(200);
    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", prompt: "liste" })).status).toBe(200);
    for (let i = 0; i < 50 && broker.pendingCount === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(broker.pendingCount).toBe(1); expect(backend.calls).toHaveLength(0);
    const approvalCard = handle.store.getEntries("openbot-default").find((entry) =>
      entry.kind === "send-message" && entry.message.type === "local-tool-permission");
    expect(approvalCard?.kind).toBe("send-message");
    if (approvalCard?.kind !== "send-message" || approvalCard.message.type !== "local-tool-permission") {
      throw new Error("approval card was not persisted");
    }
    const requestId = approvalCard.message.ask.requestId;
    expect(requestId).toMatch(/^turn:.+\0approval-1$/u);
    expect(handle.store.getEntries("openbot-default")).toContainEqual(expect.objectContaining({
      kind: "send-message", id: requestId, message: expect.objectContaining({
        type: "local-tool-permission",
        ask: expect.objectContaining({
          status: "pending",
          requestId,
          action: "list-directory",
          target: ".",
          expiresAtMs: expect.any(Number),
        }),
      }),
    }));
    const crossAgent = await post(handle, "/api/resolveLocalToolPermission", { agentId: "other-agent", requestId, resolution: "allow-once" });
    expect(crossAgent.status).toBe(404);
    expect(broker.pendingCount).toBe(1);
    expect(backend.calls).toHaveLength(0);
    const approval = await post(handle, "/api/resolveLocalToolPermission", { agentId: "openbot-default", requestId, decision: "allow" });
    expect(approval.status).toBe(200);
    await handle.runner.flush("openbot-default");
    expect(backend.calls).toEqual([{ operation: "file.list", path: "." }]);
    expect(turnRequests(requests)).toHaveLength(2);
    expect(requests.every((request) => ["turn", "memory-reflection", undefined].includes(request.purpose))).toBe(true);
  });

  it("mantém card e decisão na conversa de origem após troca da conversa ativa", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-local-exec-conversation-"));
    const config = new ConfigStore({ configPath: join(dir, "config.json") });
    config.setHostSettings({ ...config.snapshot().hostSettings, localToolPermission: "ask" });
    const broker = new LocalExecutionBroker(new Backend(), () => "ask");
    let streams = 0;
    const adapter: ProviderAdapter = { name: "xai", async streamChat(_request, emit) {
      streams += 1;
      if (streams === 1) emit({ type: "tool-call", call: { id: "conversation-approval", type: "function", function: { name: "file", arguments: '{"op":"list","path":"."}' } } });
      else emit({ type: "delta", delta: "feito" });
    } };
    const registry = createProviderRegistry(); registry.register(adapter);
    handle = await startServer(0, {
      config, registry, executionBroker: broker,
      stateRoot: join(dir, "state"), runtimeRoot: join(dir, "runtime"), browserRoot: join(dir, "browser"),
      allowUnauthenticatedLocalGateway: true,
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      storePath: join(dir, "store.db"), keystoreDir: join(dir, "keys"), workspacesRoot: join(dir, "workspaces"),
    });
    expect((await post(handle, "/api/createAgent", { id: "openbot-default", name: "Conversation Bot" })).status).toBe(200);
    const origin = handle.conversationStore.create("openbot-default", { title: "Origem" });
    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", conversationId: origin.id, prompt: "liste" })).status).toBe(200);
    for (let i = 0; i < 100 && broker.pendingCount === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(broker.pendingCount).toBe(1);
    const approvalCard = handle.store.getEntries("openbot-default", origin.id).find((entry) =>
      entry.kind === "send-message" && entry.message.type === "local-tool-permission");
    expect(approvalCard?.kind).toBe("send-message");
    if (approvalCard?.kind !== "send-message" || approvalCard.message.type !== "local-tool-permission") throw new Error("approval card missing");
    const requestId = approvalCard.message.ask.requestId;

    const other = handle.conversationStore.create("openbot-default", { title: "Outra" });
    expect(handle.conversationStore.getActive("openbot-default")?.id).toBe(other.id);
    expect((await post(handle, "/api/resolveLocalToolPermission", { agentId: "openbot-default", requestId, decision: "allow" })).status).toBe(200);
    await handle.runner.flush("openbot-default");

    expect(handle.store.getInteractionDecision("openbot-default", requestId, "local-tool-permission", origin.id)).toMatchObject({ decision: "allow" });
    expect(handle.store.getInteractionDecision("openbot-default", requestId, "local-tool-permission", other.id)).toBeNull();
  });

  it("mantém a expiração na conversa de origem após troca da conversa ativa", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-local-exec-expiry-conversation-"));
    const config = new ConfigStore({ configPath: join(dir, "config.json") });
    config.setHostSettings({ ...config.snapshot().hostSettings, localToolPermission: "ask" });
    const broker = new LocalExecutionBroker(new Backend(), () => "ask", undefined, 250);
    const adapter: ProviderAdapter = { name: "xai", async streamChat(_request, emit) {
      emit({ type: "tool-call", call: { id: "expiring-approval", type: "function", function: { name: "file", arguments: '{"op":"list","path":"."}' } } });
    } };
    const registry = createProviderRegistry(); registry.register(adapter);
    handle = await startServer(0, {
      config, registry, executionBroker: broker,
      stateRoot: join(dir, "state"), runtimeRoot: join(dir, "runtime"), browserRoot: join(dir, "browser"),
      allowUnauthenticatedLocalGateway: true,
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      storePath: join(dir, "store.db"), keystoreDir: join(dir, "keys"), workspacesRoot: join(dir, "workspaces"),
    });
    expect((await post(handle, "/api/createAgent", { id: "openbot-default", name: "Expiry Bot" })).status).toBe(200);
    const origin = handle.conversationStore.create("openbot-default", { title: "Origem" });
    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", conversationId: origin.id, prompt: "liste" })).status).toBe(200);
    for (let i = 0; i < 100 && broker.pendingCount === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(broker.pendingCount).toBe(1);
    const other = handle.conversationStore.create("openbot-default", { title: "Outra" });
    for (let i = 0; i < 150 && broker.pendingCount > 0; i++) await new Promise((resolve) => setTimeout(resolve, 3));
    expect(broker.pendingCount).toBe(0);

    const expiredInOrigin = handle.store.getEntries("openbot-default", origin.id).some((entry) =>
      entry.kind === "send-message" && entry.message.type === "local-tool-permission" && entry.message.ask.status === "expired");
    const expiredInOther = handle.store.getEntries("openbot-default", other.id).some((entry) =>
      entry.kind === "send-message" && entry.message.type === "local-tool-permission" && entry.message.ask.status === "expired");
    expect(expiredInOrigin).toBe(true);
    expect(expiredInOther).toBe(false);
  });

  it("mantém stores abertos após timeout até o drain tardio do turno", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-late-drain-"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat() {
        await blocked;
      },
    });
    handle = await startServer(0, {
      registry,
      stateRoot: join(dir, "state"), runtimeRoot: join(dir, "runtime"), browserRoot: join(dir, "browser"),
      allowUnauthenticatedLocalGateway: true,
      storePath: join(dir, "store.db"), configPath: join(dir, "config.json"), keystoreDir: join(dir, "keys"),
      workspacesRoot: join(dir, "workspaces"),
    });
    expect((await post(handle, "/api/createAgent", { id: "openbot-default", name: "Late Drain Bot", provider: "xai", model: "grok-4.6" })).status).toBe(200);
    const active = handle.conversationStore.ensureDefault("openbot-default");
    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", conversationId: active.id, prompt: "aguarde" })).status).toBe(200);
    for (let i = 0; i < 100 && handle.runner.getStatus().runningTurns === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(handle.runner.getStatus().runningTurns).toBe(1);

    const closingHandle = handle;
    await expect(stopServer(closingHandle, { turnTimeoutMs: 10 })).rejects.toThrow(/timed out|timeout|encerra/i);
    handle = undefined;
    expect(closingHandle.server.listening).toBe(false);
    expect(() => closingHandle.store.getEntries("openbot-default", active.id)).not.toThrow();

    release();
    await closingHandle.runner.waitForDrain();
    await waitForStoreClosed(closingHandle, "openbot-default", active.id);
  });
});
