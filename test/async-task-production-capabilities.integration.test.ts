import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalExecutionBroker } from "../src/execution/broker.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import type { RpcHandler } from "../src/server/gateway.js";

const handles: ServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const budget = {
  maxWallMs: 10_000, maxProviderCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000,
  maxToolRounds: 4, maxToolCalls: 4, maxMcpCalls: 1, maxBrowserCommands: 2,
  maxResultBytes: 4_096, maxWorkspaceWriteBytes: 4_096, maxDepth: 1,
};

function handler(handle: ServerHandle, method: string): RpcHandler {
  const fn = handle.gateway.listHandlers().get(method);
  if (!fn) throw new Error(`missing RPC handler: ${method}`);
  return fn;
}

function context(handle: ServerHandle) {
  return { getStatus: () => handle.runner.getStatus(), publish: () => undefined, method: "test" } as never;
}

class SharedFakeBackend implements ExecutionBackend {
  readonly requests: ExecutionRequest[] = [];
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.requests.push(request);
    if (request.operation === "process.run") return { ok: true, operation: request.operation, stdout: "ok", stderr: "", exitCode: 0, durationMs: 1, stdoutTruncated: false, stderrTruncated: false };
    if (request.operation === "browser.navigate") return { ok: true, operation: request.operation, command: "navigate", tabId: "fake-tab", url: request.url, title: "Example", visible: true };
    if (request.operation === "file.write") return { ok: true, operation: request.operation, bytes: request.encoding === "base64" ? Buffer.from(request.content, "base64").byteLength : Buffer.byteLength(request.content) };
    return { ok: false, operation: request.operation, code: "unsupported", message: "unsupported test request" };
  }
}

async function startFixture(): Promise<{ handle: ServerHandle; backend: SharedFakeBackend }> {
  const root = mkdtempSync(join(tmpdir(), "openbot-async-production-caps-"));
  roots.push(root);
  const backend = new SharedFakeBackend();
  const handle = await startServer(0, {
    configPath: join(root, "config.json"), stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"), keystoreDir: join(root, "keystore"), storePath: join(root, "store.db"),
    executionBroker: new LocalExecutionBroker(backend, () => "always"),
    asyncTaskBrowserOrigins: ["https://example.com"], allowUnauthenticatedLocalGateway: true,
  });
  handles.push(handle);
  await handler(handle, "createAgent")({ id: "agent-a", name: "Agent A" }, context(handle));
  handle.config.update({ flags: { isAgentNetworkEnabled: true } });
  await handle.asyncTaskRuntime.stop();
  handle.asyncTaskRuntime.start();
  return { handle, backend };
}

async function dispatchAndWait(handle: ServerHandle, body: Record<string, unknown>): Promise<void> {
  const taskId = body.taskId as string;
  await handler(handle, "dispatchAsyncTask")(body, context(handle));
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !["completed", "failed", "cancelled"].includes(handle.asyncTaskStore.getTask(taskId)?.status ?? "")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function body(agentId: string, parentTurnId: string, objective: string, kind: "process" | "browser" | "filesystem", constraints: Record<string, unknown>, taskBudget = budget) {
  const taskId = randomUUID();
  const childRunId = randomUUID();
  const now = Date.now();
  return {
    taskId, agentId, parentTurnId, clientNonce: randomUUID(), input: { version: 1, objective, source: { kind: "parent_turn", agentId } },
    grant: { grantId: randomUUID(), taskId, parentAgentId: agentId, parentTurnId, childRunId, kind, constraints, issuedAt: now - 100, expiresAt: now + 5_000, version: 1, depth: 1 },
    budget: taskBudget, childRunId,
  };
}

describe("async task productive capability adapters", () => {
  it("executes process and allowed browser commands through the shared broker", async () => {
    const { handle, backend } = await startFixture();
    const home = handle.homes!.pathFor("agent-a");
    const processObjective = JSON.stringify({ version: 1, kind: "process", request: { operation: "process.run", executable: "node", argv: ["-e", "process.stdout.write('ok')"], cwd: home, timeoutMs: 1_000, networkProfile: "host" } });
    const processTask = body("agent-a", "turn-process", processObjective, "process", { operations: ["run"], executables: ["node"], cwdRoots: [home], networkProfiles: ["host"] });
    await dispatchAndWait(handle, processTask);
    expect(handle.asyncTaskStore.getTask(processTask.taskId as string)).toMatchObject({ status: "completed" });

    const hostFile = join(home, "Projects", "absolute.txt");
    const fileObjective = JSON.stringify({ version: 1, kind: "filesystem", request: { operation: "file.write", path: hostFile, content: "ok", encoding: "utf8" } });
    const fileTask = body("agent-a", "turn-file", fileObjective, "filesystem", { operations: ["write"], roots: [home] });
    await dispatchAndWait(handle, fileTask);
    expect(handle.asyncTaskStore.getTask(fileTask.taskId as string)).toMatchObject({ status: "completed" });

    const browserObjective = JSON.stringify({ version: 1, kind: "browser", origin: "https://example.com", request: { operation: "browser.navigate", url: "https://example.com/" } });
    const browserTask = body("agent-a", "turn-browser", browserObjective, "browser", { commandClasses: ["navigate"], origins: ["https://example.com"], partitionAgentId: "agent-a" });
    await dispatchAndWait(handle, browserTask);
    expect(handle.asyncTaskStore.getTask(browserTask.taskId as string)).toMatchObject({ status: "completed" });
    expect(backend.requests.map((request) => request.operation)).toEqual(["process.run", "file.write", "browser.navigate"]);
  });

  it("fails closed before the broker for unknown-size writes and virtual/shared paths", async () => {
    const { handle, backend } = await startFixture();
    const home = handle.homes!.pathFor("agent-a");
    const writeGrant = { operations: ["write"], roots: [home] };
    const blockedCommands = [
      { operation: "file.copy", source: "Projects/source", destination: "Projects/destination" },
      { operation: "file.move", source: "Projects/source", destination: "Projects/destination" },
      { operation: "file.trash", path: "Projects/source" },
      { operation: "file.restore", trashId: "550e8400-e29b-41d4-a716-446655440000", path: "Projects/restored" },
    ];
    for (const [index, request] of blockedCommands.entries()) {
      const task = body("agent-a", `turn-unknown-write-${index}`, JSON.stringify({ version: 1, kind: "filesystem", request }), "filesystem", writeGrant);
      await dispatchAndWait(handle, task);
      expect(handle.asyncTaskStore.getTask(task.taskId as string)).toMatchObject({ status: "failed", error: { code: "capability_denied" } });
    }
    const shared = body("agent-a", "turn-shared-path", JSON.stringify({ version: 1, kind: "filesystem", request: { operation: "file.write", path: "Documents/secret.txt", content: "xx", encoding: "utf8" } }), "filesystem", writeGrant);
    await dispatchAndWait(handle, shared);
    expect(handle.asyncTaskStore.getTask(shared.taskId as string)).toMatchObject({ status: "failed", error: { code: "capability_denied" } });
    const sharedProcess = body("agent-a", "turn-shared-process", JSON.stringify({ version: 1, kind: "process", request: { operation: "process.run", executable: "node", argv: [], cwd: "Documents", timeoutMs: 1_000, networkProfile: "host" } }), "process", { operations: ["run"], executables: ["node"], cwdRoots: [home], networkProfiles: ["host"] });
    await dispatchAndWait(handle, sharedProcess);
    expect(handle.asyncTaskStore.getTask(sharedProcess.taskId as string)).toMatchObject({ status: "failed", error: { code: "capability_denied" } });
    const sharedSearch = body("agent-a", "turn-shared-search", JSON.stringify({ version: 1, kind: "filesystem", request: { operation: "command.run", command: "search.files", cwd: ".", params: { paths: ["Documents"] } } }), "filesystem", { operations: ["list"], roots: [home] });
    await dispatchAndWait(handle, sharedSearch);
    expect(handle.asyncTaskStore.getTask(sharedSearch.taskId as string)).toMatchObject({ status: "failed", error: { code: "capability_denied" } });
    expect(backend.requests).toHaveLength(0);
  });

  it("reserves decoded file.write bytes before the broker and charges successful writes", async () => {
    const { handle, backend } = await startFixture();
    const home = handle.homes!.pathFor("agent-a");
    const grant = { operations: ["write"], roots: [home] };
    const over = body("agent-a", "turn-write-over", JSON.stringify({ version: 1, kind: "filesystem", request: { operation: "file.write", path: "Projects/over.txt", content: "ab", encoding: "utf8" } }), "filesystem", grant, { ...budget, maxWorkspaceWriteBytes: 1 });
    await dispatchAndWait(handle, over);
    expect(handle.asyncTaskStore.getTask(over.taskId as string)).toMatchObject({ status: "failed", error: { code: "budget_exhausted" } });
    expect(backend.requests).toHaveLength(0);

    const ok = body("agent-a", "turn-write-ok", JSON.stringify({ version: 1, kind: "filesystem", request: { operation: "file.write", path: "Projects/ok.txt", content: "ab", encoding: "utf8" } }), "filesystem", grant);
    await dispatchAndWait(handle, ok);
    expect(handle.asyncTaskStore.getTask(ok.taskId as string)).toMatchObject({ status: "completed" });
    expect(handle.asyncTaskStore.getBudgetState(ok.taskId as string)?.usage.used.workspaceWriteBytes).toBe(2);
    const base64 = body("agent-a", "turn-write-base64", JSON.stringify({ version: 1, kind: "filesystem", request: { operation: "file.write", path: "Projects/bytes.bin", content: "AP8=", encoding: "base64" } }), "filesystem", grant);
    await dispatchAndWait(handle, base64);
    expect(handle.asyncTaskStore.getTask(base64.taskId as string)).toMatchObject({ status: "completed" });
    expect(handle.asyncTaskStore.getBudgetState(base64.taskId as string)?.usage.used.workspaceWriteBytes).toBe(2);
    expect(backend.requests.map((request) => request.operation)).toEqual(["file.write", "file.write"]);
  });
});
