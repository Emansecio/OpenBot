import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import type { RpcHandler } from "../src/server/gateway.js";
import { ProviderOAuthManager } from "../src/providers/oauth.js";

const handles: ServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function handler(handle: ServerHandle, method: string): RpcHandler {
  const fn = handle.gateway.listHandlers().get(method);
  if (!fn) throw new Error(`missing RPC handler: ${method}`);
  return fn;
}

function context(handle: ServerHandle) {
  return {
    getStatus: () => handle.runner.getStatus(),
    publish: () => undefined,
    method: "test",
  } as never;
}

function budget() {
  return {
    maxWallMs: 10_000,
    maxProviderCalls: 1,
    maxInputTokens: 1_000,
    maxOutputTokens: 1_000,
    maxToolRounds: 1,
    maxToolCalls: 1,
    maxMcpCalls: 1,
    maxBrowserCommands: 1,
    maxResultBytes: 4_096,
    maxWorkspaceWriteBytes: 4_096,
    maxDepth: 1,
  };
}

describe("async task RPC integration", () => {
  it("executes a provider task with OAuth and no API key through the production runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-async-oauth-"));
    roots.push(root);
    const handle = await startServer(0, {
      configPath: join(root, "config.json"), stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime"),
      browserRoot: join(root, "browser"), keystoreDir: join(root, "keystore"), storePath: join(root, "store.db"),
      disableAgentHome: true, allowUnauthenticatedLocalGateway: true,
    });
    handles.push(handle);
    const ctx = context(handle);
    await handler(handle, "createAgent")({ id: "agent-a", name: "Agent A" }, ctx);
    const oauth = new ProviderOAuthManager({ keystore: handle.keystore, fetchImpl: async () => { throw new Error("unexpected network"); } });
    await handle.keystore.upsert("xai-oauth", JSON.stringify({ type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600_000 }));
    expect(await handle.keystore.reveal("xai")).toBeNull();
    const credentials: string[] = [];
    handle.registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        credentials.push((await oauth.resolveCredential("xai")).accessToken);
        emit({ type: "delta", delta: "Tarefa concluída" });
      },
    });
    const taskId = randomUUID();
    const body = {
      taskId, agentId: "agent-a", parentTurnId: "turn-oauth", clientNonce: "oauth-once",
      input: { version: 1, objective: "Responda brevemente", source: { kind: "parent_turn", agentId: "agent-a" } },
      grant: {
        grantId: randomUUID(), taskId, parentAgentId: "agent-a", parentTurnId: "turn-oauth", childRunId: randomUUID(),
        kind: "provider", constraints: { adapters: ["xai"], models: [handle.config.snapshot().globalModel], credentialRefs: [{ secretRef: "provider/xai" }], allowNoCredential: false },
        issuedAt: Date.now() - 100, expiresAt: Date.now() + 5000, version: 1, depth: 1,
      },
      budget: budget(),
    };
    await handler(handle, "dispatchAsyncTask")(body, ctx);
    await vi.waitFor(() => expect(handle.asyncTaskStore.getTask(taskId)).toMatchObject({ status: "completed" }));
    expect(credentials).toEqual(["fixture-access"]);
    expect(handle.asyncTaskStore.getTask(taskId)?.result).toMatchObject({ kind: "inline", text: "Tarefa concluída" });

    await oauth.disconnect("xai");
    const missingId = randomUUID();
    await handler(handle, "dispatchAsyncTask")({
      ...body, taskId: missingId, clientNonce: "oauth-missing",
      grant: { ...body.grant, grantId: randomUUID(), taskId: missingId, childRunId: randomUUID() },
    }, ctx);
    await vi.waitFor(() => expect(handle.asyncTaskStore.getTask(missingId)?.status).toBe("failed"));
    expect(credentials).toHaveLength(1);
  });

  it("registers the real handlers, scopes ownership, deduplicates, and fences deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-async-task-rpc-"));
    roots.push(root);
    const handle = await startServer(0, {
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
      browserRoot: join(root, "browser"),
      keystoreDir: join(root, "keystore"),
      storePath: join(root, "store.db"),
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(handle);
    const ctx = context(handle);
    await handler(handle, "createAgent")({ id: "agent-a", name: "Agent A" }, ctx);
    await handler(handle, "createAgent")({ id: "agent-b", name: "Agent B" }, ctx);
    await handle.asyncTaskRuntime.stop();

    const taskId = randomUUID();
    const childRunId = randomUUID();
    const now = Date.now();
    const configuredModel = handle.config.snapshot().globalModel;
    const configuredProvider = handle.config.snapshot().activeProvider;
    const body = {
      taskId,
      agentId: "agent-a",
      parentTurnId: "turn-a",
      clientNonce: "rpc-once",
      input: {
        version: 1,
        objective: "Executar uma tarefa RPC curta",
        source: { kind: "parent_turn", agentId: "agent-a", conversationId: "conversation-a", turnEntryId: "entry-a" },
      },
      grant: {
        grantId: randomUUID(),
        taskId,
        parentAgentId: "agent-a",
        parentTurnId: "turn-a",
        childRunId,
        kind: "provider",
        constraints: {
          adapters: [configuredProvider],
          models: [configuredModel],
          credentialRefs: [{ secretRef: `provider/${configuredProvider}` }],
          allowNoCredential: false,
        },
        issuedAt: now - 100,
        expiresAt: now + 5_000,
        version: 1,
        depth: 1,
      },
      budget: budget(),
    };

    const first = await handler(handle, "dispatchAsyncTask")(body, ctx) as { taskId: string; created: boolean };
    expect(first).toMatchObject({ taskId, created: true });
    const duplicate = await handler(handle, "dispatchAsyncTask")(body, ctx) as { taskId: string; created: boolean };
    expect(duplicate).toMatchObject({ taskId, created: false });
    for (let index = 0; index < 2; index += 1) {
      const extraTaskId = randomUUID();
      await handler(handle, "dispatchAsyncTask")({
        ...body,
        taskId: extraTaskId,
        clientNonce: `rpc-extra-${index}`,
        grant: { ...body.grant, grantId: randomUUID(), taskId: extraTaskId, childRunId: randomUUID() },
      }, ctx);
    }
    for (const method of ["getAsyncTasks", "getSubagents", "listAsyncTasks"] as const) {
      expect(await handler(handle, method)({ agentId: "agent-a", limit: 2 }, ctx)).toHaveLength(2);
      for (const invalidLimit of [0, 201, 1.5, "2", null, Number.NaN]) {
        await expect(Promise.resolve().then(() => handler(handle, method)({ agentId: "agent-a", limit: invalidLimit }, ctx))).rejects.toMatchObject({ status: 400 });
      }
    }
    await expect(Promise.resolve().then(() => handler(handle, "dispatchAsyncTask")({ ...body, taskId: randomUUID(), input: undefined }, ctx))).rejects.toMatchObject({ status: 400 });
    expect(await handler(handle, "listAsyncTasks")({ agentId: "agent-a" }, ctx)).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId, agentId: "agent-a", input: expect.objectContaining({ objective: "Executar uma tarefa RPC curta" }) })]),
    );
    const events = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=async-tasks,subagents&agentId=agent-a`, {
      headers: { accept: "text/event-stream" },
    });
    const reader = events.body!.getReader();
    const firstChunk = await reader.read();
    const initialEvent = new TextDecoder().decode(firstChunk.value);
    expect(initialEvent).toContain('"channel":"async-tasks"');
    // P2.2 canonical snapshot shape: one combined native snapshot carries both
    // channel lists under the tasks/subagents keys (channel field is primary).
    expect(initialEvent).toContain('"tasks"');
    expect(initialEvent).toContain('"subagents"');
    expect(initialEvent).toContain('"resyncRequired":true');
    expect(handle.gateway.publish("async-tasks", { agentId: "agent-b", epoch: "other", sequence: 1, taskId: "other" }).eligibleClients).toBe(0);
    expect(handle.gateway.publish("async-tasks", { agentId: "agent-a", epoch: "live", sequence: 1, taskId }).accepted).toBe(true);
    let liveText = "";
    for (let attempt = 0; attempt < 5 && !liveText.includes('"agentId":"agent-a"'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const liveChunk = await reader.read();
      liveText += new TextDecoder().decode(liveChunk.value);
      if (liveChunk.done) break;
    }
    expect(liveText).toContain('"agentId":"agent-a"');
    expect(liveText).not.toContain('"agentId":"agent-b"');
    await reader.cancel();

    const initialSnapshot = handle.asyncTaskStore.getProjectionSnapshot("agent-a", "async-tasks")!;
    const cursorZero = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=async-tasks&agentId=agent-a`, {
      headers: { accept: "text/event-stream", "last-event-id": `async-tasks:${initialSnapshot.epoch}:0` },
    });
    const cursorZeroReader = cursorZero.body!.getReader();
    const cursorZeroText = new TextDecoder().decode((await cursorZeroReader.read()).value);
    expect(cursorZeroText).toContain('"resyncRequired":false');
    await cursorZeroReader.cancel();
    handle.asyncTaskStore.projectUndelivered();
    const snapshot = handle.asyncTaskStore.getProjectionSnapshot("agent-a", "async-tasks")!;
    const reconnect = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=async-tasks&agentId=agent-a`, {
      headers: { accept: "text/event-stream", "last-event-id": `async-tasks:${snapshot.epoch}:0` },
    });
    const reconnectReader = reconnect.body!.getReader();
    const reconnectText = new TextDecoder().decode((await reconnectReader.read()).value);
    expect(reconnectText).toContain('"resyncRequired":true');
    expect(reconnectText).toContain('"reason":"cursor-stale-or-gap"');
    await reconnectReader.cancel();

    const ahead = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=async-tasks&agentId=agent-a`, {
      headers: { accept: "text/event-stream", "last-event-id": `async-tasks:${snapshot.epoch}:${snapshot.sequence + 1}` },
    });
    const aheadReader = ahead.body!.getReader();
    const aheadText = new TextDecoder().decode((await aheadReader.read()).value);
    expect(aheadText).toContain('"reason":"cursor-ahead"');
    await aheadReader.cancel();

    const subagentsSnapshot = handle.asyncTaskStore.getProjectionSnapshot("agent-a", "subagents")!;
    expect(subagentsSnapshot.epoch).not.toBe(snapshot.epoch);
    const multi = await fetch(`http://127.0.0.1:${handle.port}/api/events?channels=async-tasks,subagents&agentId=agent-a`, {
      headers: { accept: "text/event-stream", "last-event-id": `async-tasks:${snapshot.epoch}:${snapshot.sequence}` },
    });
    const multiReader = multi.body!.getReader();
    let multiText = "";
    for (let attempt = 0; attempt < 5 && !multiText.includes('"tasks"'); attempt += 1) {
      const chunk = await multiReader.read();
      multiText += new TextDecoder().decode(chunk.value);
      if (chunk.done) break;
    }
    // P2.2 combined snapshot: one native frame carries both `tasks` and
    // `subagents`; the primary (async-tasks) cursor applies to the frame.
    expect(multiText).toContain('"channel":"async-tasks"');
    expect(multiText).toContain('"tasks"');
    expect(multiText).toContain('"subagents"');
    expect(multiText).toContain('"resyncRequired":false');
    expect(multiText).toContain('"reason":"cursor-current"');
    await multiReader.cancel();

    await expect(Promise.resolve().then(() => handler(handle, "getAsyncTask")({ agentId: "agent-b", taskId }, ctx))).rejects.toMatchObject({ status: 404 });
    await handler(handle, "deleteAgents")({ ids: ["agent-a"] }, ctx);
    expect(handle.asyncTaskStore.getTask(taskId)).toBeNull();
    await expect(Promise.resolve().then(() => handler(handle, "listAsyncTasks")({ agentId: "agent-a" }, ctx))).rejects.toMatchObject({ status: 404 });
    await handler(handle, "createAgent")({ id: "agent-a", name: "Agent A" }, ctx);
    expect(await handler(handle, "listAsyncTasks")({ agentId: "agent-a" }, ctx)).toEqual([]);
  });

  it("executes a non-provider filesystem command through the shared production broker", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-async-task-executor-"));
    roots.push(root);
    const handle = await startServer(0, {
      configPath: join(root, "config.json"), stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime"),
      browserRoot: join(root, "browser"), keystoreDir: join(root, "keystore"), storePath: join(root, "store.db"),
      allowUnauthenticatedLocalGateway: true,
    });
    handles.push(handle);
    const ctx = context(handle);
    await handler(handle, "createAgent")({ id: "agent-a", name: "Agent A" }, ctx);
    const taskId = randomUUID();
    const childRunId = randomUUID();
    const now = Date.now();
    const home = handle.homes!.pathFor("agent-a");
    const body = {
      taskId, agentId: "agent-a", parentTurnId: "turn-filesystem", clientNonce: "filesystem-once",
      input: {
        version: 1,
        objective: '{"version":1,"kind":"filesystem","request":{"operation":"file.list","path":"."}}',
        source: { kind: "parent_turn", agentId: "agent-a" },
      },
      grant: {
        grantId: randomUUID(), taskId, parentAgentId: "agent-a", parentTurnId: "turn-filesystem", childRunId,
        kind: "filesystem", constraints: { operations: ["list"], roots: [home] },
        issuedAt: now - 100, expiresAt: now + 5_000, version: 1, depth: 1,
      },
      budget: budget(),
    };
    await handler(handle, "dispatchAsyncTask")(body, ctx);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && handle.asyncTaskStore.getTask(taskId)?.status !== "completed") await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handle.asyncTaskStore.getTask(taskId)).toMatchObject({ status: "completed" });
    expect(handle.asyncTaskStore.getTask(taskId)?.result).toMatchObject({ kind: "inline" });

    const deniedTaskId = randomUUID();
    const deniedChildRunId = randomUUID();
    const deniedBody = {
      ...body,
      taskId: deniedTaskId,
      parentTurnId: "turn-filesystem-search",
      clientNonce: "filesystem-search-denied",
      input: {
        ...body.input,
        objective: '{"version":1,"kind":"filesystem","request":{"operation":"command.run","command":"search.files","cwd":".","params":{"paths":[".."]}}}',
      },
      grant: {
        ...body.grant,
        grantId: randomUUID(), taskId: deniedTaskId, parentTurnId: "turn-filesystem-search", childRunId: deniedChildRunId,
        constraints: { operations: ["list"], roots: [join(home, "Projects")] },
      },
    };
    await handler(handle, "dispatchAsyncTask")(deniedBody, ctx);
    const deniedDeadline = Date.now() + 2_000;
    while (Date.now() < deniedDeadline && !["failed", "cancelled"].includes(handle.asyncTaskStore.getTask(deniedTaskId)?.status ?? "")) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handle.asyncTaskStore.getTask(deniedTaskId)).toMatchObject({ status: "failed", error: expect.objectContaining({ code: "capability_denied" }) });

    const browserTaskId = randomUUID();
    await expect(handler(handle, "dispatchAsyncTask")({
      ...body,
      taskId: browserTaskId,
      parentTurnId: "turn-browser-denied",
      clientNonce: "browser-denied",
      input: { ...body.input, objective: '{"version":1,"kind":"browser","origin":"https://example.com","request":{"operation":"browser.navigate","url":"https://example.com/"}}' },
      grant: {
        ...body.grant,
        grantId: randomUUID(), taskId: browserTaskId, parentTurnId: "turn-browser-denied", childRunId: randomUUID(),
        kind: "browser", constraints: { commandClasses: ["navigate"], origins: ["https://example.com"], partitionAgentId: "agent-a" },
      },
    }, ctx)).rejects.toMatchObject({ status: 403 });
  });

});
