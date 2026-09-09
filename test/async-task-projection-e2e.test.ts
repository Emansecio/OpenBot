import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import type { RpcHandler } from "../src/server/gateway.js";
import type { DispatchAsyncTaskInput, ProviderCapabilityGrant, SubagentBudget } from "../src/tasks/contracts.js";
import { AsyncTaskRuntime } from "../src/tasks/runtime.js";

const handles: ServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const budget: SubagentBudget = {
  maxWallMs: 10_000, maxProviderCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000,
  maxToolRounds: 1, maxToolCalls: 1, maxMcpCalls: 1, maxBrowserCommands: 1,
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

function input(agentId: string, parentTurnId: string): DispatchAsyncTaskInput {
  const taskId = randomUUID();
  const childRunId = randomUUID();
  const grant: ProviderCapabilityGrant = {
    grantId: randomUUID(), taskId, parentAgentId: agentId, parentTurnId, childRunId,
    kind: "provider",
    constraints: { adapters: ["openai"], models: ["test"], credentialRefs: [{ secretRef: "provider/test/key" }], allowNoCredential: false },
    issuedAt: Date.now() - 100, expiresAt: Date.now() + 5_000, version: 1, depth: 1,
  };
  return {
    taskId, agentId, parentTurnId, kind: "subagent", clientNonce: randomUUID(), createdAtMs: Date.now(),
    lineage: { parentAgentId: agentId, parentTurnId, parentTaskId: null, childRunId, depth: 1 }, grant, budget,
    input: { version: 1, objective: "projection", source: { kind: "parent_turn", agentId } },
  };
}

async function harness(): Promise<ServerHandle> {
  const root = mkdtempSync(join(tmpdir(), "openbot-async-task-projection-"));
  roots.push(root);
  const handle = await startServer(0, {
    configPath: join(root, "config.json"), stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"), keystoreDir: join(root, "keystore"), storePath: join(root, "store.db"),
    allowUnauthenticatedLocalGateway: true,
  });
  handles.push(handle);
  await handler(handle, "createAgent")({ id: "agent-a", name: "Agent A" }, context(handle));
  await handle.asyncTaskRuntime.stop();
  return handle;
}

async function openSse(handle: ServerHandle, channels: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=${channels}&agentId=agent-a`, {
    headers: { accept: "text/event-stream" },
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return reader;
}

async function executeAndFlush(handle: ServerHandle, task: DispatchAsyncTaskInput, oversized = false) {
  const taskRecord = handle.asyncTaskStore.dispatch(task).task;
  const runtime = new AsyncTaskRuntime({
    store: handle.asyncTaskStore, agentIds: () => ["agent-a"], pollIntervalMs: 1,
    execute: async () => ({ result: "ok" }),
    publishProjection: (envelope) => handle.gateway.publish(
      envelope.channel,
      oversized ? { ...envelope, payload: { ...envelope.payload, summary: "x".repeat(300 * 1024) } } : envelope,
    ).accepted,
  });
  runtime.start();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && handle.asyncTaskStore.getTask(taskRecord.taskId)?.status !== "completed") {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(handle.asyncTaskStore.getTask(taskRecord.taskId)).toMatchObject({ status: "completed" });
  await runtime.stop();
  return {
    source: handle.asyncTaskStore.listUndeliveredOutbox().filter((event) => event.taskId === taskRecord.taskId),
    projections: handle.asyncTaskStore.listUndeliveredProjections().filter((event) => event.taskId === taskRecord.taskId),
  };
}

describe("async task projection delivery E2E", () => {
  it("does not ACK SQLite source/projections with zero real SSE subscribers", async () => {
    const handle = await harness();
    const pending = await executeAndFlush(handle, input("agent-a", "projection-zero"));
    expect(pending.source).not.toHaveLength(0);
    expect(pending.projections.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pending.projections.map((projection) => projection.channel))).toEqual(new Set(["async-tasks", "subagents"]));
  });

  it("ACKs each channel through real SSE before ACKing the source", async () => {
    const handle = await harness();
    const asyncTasks = await openSse(handle, "async-tasks");
    const oneChannel = await executeAndFlush(handle, input("agent-a", "projection-one"));
    expect(oneChannel.projections.length).toBeGreaterThanOrEqual(1);
    expect(new Set(oneChannel.projections.map((projection) => projection.channel))).toEqual(new Set(["subagents"]));
    expect(oneChannel.source).not.toHaveLength(0);
    await asyncTasks.cancel();

    const both = await openSse(handle, "async-tasks,subagents");
    const twoChannels = await executeAndFlush(handle, input("agent-a", "projection-both"));
    expect(twoChannels.projections).toHaveLength(0);
    expect(twoChannels.source).toHaveLength(0);
    await both.cancel();
  });

  it("does not ACK a valid projection when the real Gateway rejects an oversized receipt", async () => {
    const handle = await harness();
    const both = await openSse(handle, "async-tasks,subagents");
    const pending = await executeAndFlush(handle, input("agent-a", "projection-oversize"), true);
    expect(pending.source).not.toHaveLength(0);
    expect(pending.projections.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pending.projections.map((projection) => projection.channel))).toEqual(new Set(["async-tasks", "subagents"]));
    await both.cancel();
  });
});
