import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { AgentLifecycleFence } from "../src/rpc/agent-lifecycle.js";
import type { RpcHandler } from "../src/server/gateway.js";

const handles: ServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rpc(handle: ServerHandle, method: string): RpcHandler {
  const handler = handle.gateway.listHandlers().get(method);
  if (!handler) throw new Error(`missing RPC handler: ${method}`);
  return handler;
}

function context(handle: ServerHandle) {
  return { getStatus: () => handle.runner.getStatus(), publish: () => undefined, method: "test" } as never;
}

function paths(root: string) {
  return {
    configPath: join(root, "config.json"),
    stateRoot: join(root, "state"),
    runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"),
    keystoreDir: join(root, "keystore"),
    storePath: join(root, "store.db"),
    allowUnauthenticatedLocalGateway: true,
  } as const;
}

describe("agent lifecycle fence", () => {
  it("closes admission before draining an already-running mutation", async () => {
    const fence = new AgentLifecycleFence();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = fence.run(["Agent-A"], async () => gate);
    let deletionSettled = false;
    const deleting = fence.beginDeletion(["agent-a"]).then(() => { deletionSettled = true; });

    await Promise.resolve();
    expect(deletionSettled).toBe(false);
    expect(() => fence.run(["AGENT-A"], () => "late")).toThrow(/sendo excluído/);

    release();
    await running;
    await deleting;
    fence.endDeletion(["agent-a"]);
    expect(fence.run(["agent-a"], () => "allowed")).toBe("allowed");
  });
});

describe("durable agent deletion reconciliation", () => {
  it("completes normal deletion only after scoped secrets and staging are purged", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-delete-commit-"));
    roots.push(root);
    const handle = await startServer(0, paths(root));
    handles.push(handle);
    await rpc(handle, "createAgent")({ id: "delete-victim", name: "Delete Victim" }, context(handle));
    await handle.keystore.upsert("xai", "delete-secret", "delete-victim");
    const staged = await handle.attachmentStaging.stageBytes("delete-victim", {
      filename: "delete.txt",
      bytes: Buffer.from("delete bytes"),
    });

    await expect(rpc(handle, "deleteAgents")({ ids: ["delete-victim"] }, context(handle)))
      .resolves.toEqual({ ok: true, ids: ["delete-victim"] });

    expect(handle.store.pendingAgentDeletions()).toEqual([]);
    await expect(handle.keystore.reveal("xai", "delete-victim")).resolves.toBeNull();
    expect(handle.attachmentStaging.get("delete-victim", staged.id)).toBeNull();
    expect(existsSync(staged.storedPath)).toBe(false);
  });

  it("purges transcript, staged bytes, and scoped secrets before allowing id reuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-delete-reconcile-"));
    roots.push(root);
    const options = paths(root);
    const first = await startServer(0, options);
    handles.push(first);
    await rpc(first, "createAgent")({ id: "crash-victim", name: "Crash Victim" }, context(first));
    const conversation = first.conversationStore.ensureDefault("crash-victim");
    first.store.append("crash-victim", [{
      kind: "message",
      id: "before-crash",
      role: "user",
      content: "must not be inherited",
      timestampMs: 1,
    }], conversation.id);
    await first.keystore.upsert("xai", "agent-secret", "crash-victim");
    const staged = await first.attachmentStaging.stageBytes("crash-victim", {
      filename: "secret.txt",
      bytes: Buffer.from("staged secret"),
    });

    first.store.beginAgentDeletion(["crash-victim"], 10);
    first.config.update({
      agents: first.config.snapshot().agents.filter((agent) => agent.id !== "crash-victim"),
    });
    handles.pop();
    await stopServer(first);

    const restarted = await startServer(0, options);
    handles.push(restarted);
    expect(restarted.store.pendingAgentDeletions()).toEqual([]);
    expect(restarted.store.getEntries("crash-victim")).toEqual([]);
    await expect(restarted.keystore.reveal("xai", "crash-victim")).resolves.toBeNull();
    expect(restarted.attachmentStaging.get("crash-victim", staged.id)).toBeNull();
    expect(existsSync(staged.storedPath)).toBe(false);

    await expect(rpc(restarted, "createAgent")(
      { id: "crash-victim", name: "Fresh Victim" },
      context(restarted),
    )).resolves.toMatchObject({ agent: { id: "crash-victim" } });
    expect(restarted.store.getEntries("crash-victim")).toEqual([]);
  });

  it("cancels an uncommitted journal when roster still owns the agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-delete-rollback-"));
    roots.push(root);
    const options = paths(root);
    const first = await startServer(0, options);
    handles.push(first);
    await rpc(first, "createAgent")({ id: "rollback-victim", name: "Rollback Victim" }, context(first));
    const conversation = first.conversationStore.ensureDefault("rollback-victim");
    first.store.append("rollback-victim", [{
      kind: "message", id: "preserved", role: "user", content: "preserve me", timestampMs: 1,
    }], conversation.id);
    first.store.beginAgentDeletion(["rollback-victim"], 20);
    handles.pop();
    await stopServer(first);

    const restarted = await startServer(0, options);
    handles.push(restarted);
    expect(restarted.store.pendingAgentDeletions()).toEqual([]);
    expect(restarted.store.getEntries("rollback-victim", conversation.id))
      .toContainEqual(expect.objectContaining({ id: "preserved", content: "preserve me" }));
  });
});
