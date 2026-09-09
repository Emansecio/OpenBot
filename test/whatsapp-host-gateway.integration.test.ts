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

let handle: ServerHandle | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (handle) await stopServer(handle);
  handle = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const turnRequests = (requests: ProviderChatRequest[]) => requests.filter((request) => (request.purpose ?? "turn") === "turn");

const post = (h: ServerHandle, path: string, body: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
  const req = http.request({
    host: GATEWAY_HOST,
    port: h.port,
    path,
    method: "POST",
    headers: { "content-type": "application/json" },
    agent: false,
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }));
  });
  req.on("error", reject);
  req.end(JSON.stringify(body));
});

class Backend implements ExecutionBackend {
  calls: ExecutionRequest[] = [];
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.calls.push(request);
    if (request.operation === "whatsapp") {
      return {
        ok: true,
        operation: "whatsapp",
        op: request.op,
        stdout: "sweep-ok",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }
    return { ok: true, operation: "file.list", entries: [] };
  }
}

const whatsappTool = { type: "function" as const, function: { name: "whatsapp", parameters: { type: "object" } } };
const fileTool = { type: "function" as const, function: { name: "file", parameters: { type: "object" } } };

describe("whatsapp host tool through gateway", () => {
  it("uses the CLI tool normally without a dedicated per-bot preference", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-wa-host-"));
    const config = new ConfigStore({ configPath: join(dir, "config.json") });
    const backend = new Backend();
    const broker = new LocalExecutionBroker(backend, () => "always");
    const requests: ProviderChatRequest[] = [];
    const planned = ["whatsapp", "file", "whatsapp"];
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        if ((request.purpose ?? "turn") !== "turn") return;
        if (!request.messages.some((message) => message.role === "tool")) {
          const next = planned.shift();
          if (next === "whatsapp") {
            emit({ type: "tool-call", call: { id: `wa-${planned.length}`, type: "function", function: { name: "whatsapp", arguments: '{"op":"sweep"}' } } });
            return;
          }
          if (next === "file") {
            emit({ type: "tool-call", call: { id: `file-${planned.length}`, type: "function", function: { name: "file", arguments: '{"op":"list","path":"."}' } } });
            return;
          }
        }
        emit({ type: "delta", delta: "feito" });
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    handle = await startServer(0, {
      config,
      registry,
      executionBroker: broker,
      stateRoot: join(dir, "state"),
      runtimeRoot: join(dir, "runtime"),
      browserRoot: join(dir, "browser"),
      allowUnauthenticatedLocalGateway: true,
      tools: [fileTool, whatsappTool],
      storePath: join(dir, "store.db"),
      keystoreDir: join(dir, "keys"),
      workspacesRoot: join(dir, "workspaces"),
    });

    expect((await post(handle, "/api/createAgent", { id: "openbot-default", name: "Atendimento" })).status).toBe(200);
    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", prompt: "ve as mensagens" })).status).toBe(200);
    await handle.runner.flush("openbot-default");
    expect(backend.calls).toEqual([{ operation: "whatsapp", op: "sweep" }]);
    expect(broker.pendingCount).toBe(0);
    expect(handle.store.getEntries("openbot-default").filter((entry) =>
      entry.kind === "send-message" && entry.message.type === "local-tool-permission")).toHaveLength(0);

    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", prompt: "liste a home" })).status).toBe(200);
    await handle.runner.flush("openbot-default");
    expect(backend.calls).toContainEqual({ operation: "file.list", path: "." });
    expect(handle.store.getEntries("openbot-default").filter((entry) =>
      entry.kind === "send-message" && entry.message.type === "local-tool-permission")).toHaveLength(0);

    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", prompt: "sweep de novo" })).status).toBe(200);
    await handle.runner.flush("openbot-default");
    expect(backend.calls.filter((call) => call.operation === "whatsapp")).toHaveLength(2);
    expect(turnRequests(requests).length).toBeGreaterThanOrEqual(3);
  });

  it("still follows the general ask policy for local tools", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-wa-once-"));
    const config = new ConfigStore({ configPath: join(dir, "config.json") });
    const backend = new Backend();
    const broker = new LocalExecutionBroker(backend, () => "ask");
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        if ((request.purpose ?? "turn") !== "turn") return;
        if (!request.messages.some((message) => message.role === "tool")) {
          emit({ type: "tool-call", call: { id: `wa-${request.messages.length}`, type: "function", function: { name: "whatsapp", arguments: '{"op":"doctor"}' } } });
          return;
        }
        emit({ type: "delta", delta: "feito" });
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    handle = await startServer(0, {
      config,
      registry,
      executionBroker: broker,
      stateRoot: join(dir, "state"),
      runtimeRoot: join(dir, "runtime"),
      browserRoot: join(dir, "browser"),
      allowUnauthenticatedLocalGateway: true,
      tools: [whatsappTool],
      storePath: join(dir, "store.db"),
      keystoreDir: join(dir, "keys"),
      workspacesRoot: join(dir, "workspaces"),
    });
    expect((await post(handle, "/api/createAgent", { id: "openbot-default", name: "Once" })).status).toBe(200);
    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", prompt: "doctor" })).status).toBe(200);
    for (let i = 0; i < 50 && broker.pendingCount === 0; i++) await new Promise((r) => setTimeout(r, 2));
    const first = broker.peekPending(broker.pendingRequestIds()[0] ?? "", "openbot-default");
    expect(first?.operation).toBe("whatsapp");
    const requestId = broker.pendingRequestIds()[0];
    expect((await post(handle, "/api/resolveLocalToolPermission", {
      agentId: "openbot-default",
      requestId,
      decision: "allow-once",
    })).status).toBe(200);
    await handle.runner.flush("openbot-default");
    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", prompt: "doctor de novo" })).status).toBe(200);
    for (let i = 0; i < 50 && broker.pendingCount === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(broker.pendingCount).toBe(1);
  });

  it("respects the general disabled policy without a dedicated preference", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-wa-never-"));
    const config = new ConfigStore({ configPath: join(dir, "config.json") });
    const backend = new Backend();
    const broker = new LocalExecutionBroker(backend, () => "never");
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        if ((request.purpose ?? "turn") !== "turn") return;
        if (!request.messages.some((message) => message.role === "tool")) {
          emit({ type: "tool-call", call: { id: `wa-${request.messages.length}`, type: "function", function: { name: "whatsapp", arguments: '{"op":"doctor"}' } } });
          return;
        }
        emit({ type: "delta", delta: "feito" });
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    handle = await startServer(0, {
      config,
      registry,
      executionBroker: broker,
      stateRoot: join(dir, "state"),
      runtimeRoot: join(dir, "runtime"),
      browserRoot: join(dir, "browser"),
      allowUnauthenticatedLocalGateway: true,
      tools: [whatsappTool],
      storePath: join(dir, "store.db"),
      keystoreDir: join(dir, "keys"),
      workspacesRoot: join(dir, "workspaces"),
    });
    expect((await post(handle, "/api/createAgent", { id: "openbot-default", name: "Never" })).status).toBe(200);
    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", prompt: "doctor" })).status).toBe(200);
    await handle.runner.flush("openbot-default");
    expect(backend.calls).toHaveLength(0);
    expect(broker.pendingCount).toBe(0);
  });
});
