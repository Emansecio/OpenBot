import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import type { BrowserAgentLifecycle } from "../src/rpc/index.js";

const handles: ServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function boot(browserLifecycle?: BrowserAgentLifecycle): Promise<ServerHandle> {
  const root = mkdtempSync(join(tmpdir(), "openbot-a2a-rpc-"));
  roots.push(root);
  const handle = await startServer(0, {
    configPath: join(root, "config.json"), stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"), keystoreDir: join(root, "keystore"), storePath: join(root, "store.db"),
    allowUnauthenticatedLocalGateway: true,
    browserLifecycle,
  });
  handles.push(handle);
  return handle;
}

async function post(handle: ServerHandle, method: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function expectFailure(response: { status: number; json: any }, status: number): void {
  expect(response.status).toBe(status);
  expect(response.json).toEqual({ ok: false, failure: expect.any(String) });
}

const sendBody = (overrides: Record<string, unknown> = {}) => ({
  senderAgentId: "agent-a", recipientAgentId: "agent-b",
  nonce: "rpc-nonce-1", parentTaskId: null, parentTurnId: "rpc-turn-1", priority: "normal", hopCount: 0,
  payload: { version: 1, kind: "text", text: "hello" }, ...overrides,
});

describe("P2.1 A2A RPC ownership and lifecycle", () => {
  it("accepts an agent-scoped message and deduplicates the same nonce", async () => {
    const handle = await boot();
    expect((await post(handle, "createAgent", { id: "agent-a", name: "A" })).status).toBe(200);
    expect((await post(handle, "createAgent", { id: "agent-b", name: "B" })).status).toBe(200);
    const first = await post(handle, "sendAgentMessage", sendBody());
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, value: { created: true, message: { status: "queued" } } });
    expect(first.json.value.message.senderIncarnation).toEqual(expect.any(String));
    expect(first.json.value.message.recipientIncarnation).toEqual(expect.any(String));
    const duplicate = await post(handle, "sendAgentMessage", sendBody());
    expect(duplicate.status).toBe(200);
    expect(duplicate.json.value).toMatchObject({ created: false, duplicate: true });
  });

  it("rejects self-send, unknown/deleted recipient and foreign control/read", async () => {
    const handle = await boot();
    await post(handle, "createAgent", { id: "agent-a", name: "A" });
    await post(handle, "createAgent", { id: "agent-b", name: "B" });
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ recipientAgentId: "agent-a" })), 409);
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ recipientAgentId: "missing" })), 404);
    const created = await post(handle, "sendAgentMessage", sendBody());
    expect(created.status).toBe(200);
    const messageId = created.json.value?.message?.messageId;
    expect(typeof messageId).toBe("string");
    if (typeof messageId !== "string") return;
    const otherInbox = await post(handle, "listAgentMessages", { agentId: "agent-a" });
    expect(otherInbox.status).toBe(200);
    expect(otherInbox.json.value).toEqual([]);
    const foreignGet = await post(handle, "getAgentMessage", { agentId: "agent-a", messageId });
    expectFailure(foreignGet, 404);
    const recipientInbox = await post(handle, "listAgentMessages", { agentId: "agent-b" });
    expect(recipientInbox.status).toBe(200);
    expect(recipientInbox.json.value).toEqual([expect.objectContaining({ messageId })]);
    expect((await post(handle, "getAgentMessage", { agentId: "agent-b", messageId })).status).toBe(200);
    expectFailure(await post(handle, "ackAgentMessage", { agentId: "agent-a", messageId, ownerId: "foreign", expectedVersion: 1 }), 404);
    expect((await post(handle, "deleteAgents", { ids: ["agent-b"] })).status).toBe(200);
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ nonce: "deleted-recipient" })), 404);
  });

  it("rejects sends during deletion and never delivers an old incarnation after delete/recreate", async () => {
    let releaseDeletion!: () => void;
    let deletionStarted!: () => void;
    const started = new Promise<void>((resolve) => { deletionStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseDeletion = resolve; });
    const handle = await boot({
      async teardownAgent(agentId) {
        if (agentId === "agent-b") {
          deletionStarted();
          await release;
        }
      },
    });
    await post(handle, "createAgent", { id: "agent-a", name: "A" });
    await post(handle, "createAgent", { id: "agent-b", name: "B" });
    const beforeDelete = await post(handle, "sendAgentMessage", sendBody());
    expect(beforeDelete.status).toBe(200);
    if (beforeDelete.status !== 200) return;
    const oldIncarnation = beforeDelete.json.value.message.recipientIncarnation;
    const deletion = post(handle, "deleteAgents", { ids: ["agent-b"] });
    await started;
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ nonce: "during-delete" })), 409);
    releaseDeletion();
    expect((await deletion).status).toBe(200);
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ nonce: "after-delete" })), 404);
    await post(handle, "createAgent", { id: "agent-b", name: "B recreated" });
    const recreated = await post(handle, "sendAgentMessage", sendBody({ nonce: "recreated" }));
    expect(recreated.status).toBe(200);
    expect(recreated.json.value.message.recipientIncarnation).not.toBe(oldIncarnation);
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ nonce: "old-inc", recipientIncarnation: oldIncarnation })), 400);
    const recreatedInbox = await post(handle, "listAgentMessages", { agentId: "agent-b" });
    expect(recreatedInbox.status).toBe(200);
    expect(recreatedInbox.json.value).toEqual([
      expect.objectContaining({ nonce: "recreated", recipientIncarnation: recreated.json.value.message.recipientIncarnation }),
    ]);
  });

  it("rejects malformed payloads, oversized text and nonce conflicts before persistence", async () => {
    const handle = await boot();
    await post(handle, "createAgent", { id: "agent-a", name: "A" });
    await post(handle, "createAgent", { id: "agent-b", name: "B" });
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ payload: { version: 1, kind: "json", value: { token: "secret" } } })), 400);
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ senderIncarnation: "forged" })), 400);
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ recipientIncarnation: "forged" })), 400);
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ messageId: "forged" })), 400);
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ payload: { version: 1, kind: "text", text: "x".repeat(33 * 1024) } })), 409);
    expect((await post(handle, "listAgentMessages", { agentId: "agent-b" })).json.value).toEqual([]);
    const first = await post(handle, "sendAgentMessage", sendBody({ nonce: "conflict" }));
    expect(first.status).toBe(200);
    if (first.status !== 200) return;
    expectFailure(await post(handle, "sendAgentMessage", sendBody({ nonce: "conflict", payload: { version: 1, kind: "text", text: "different" } })), 409);
    expect((await post(handle, "listAgentMessages", { agentId: "agent-b" })).json.value).toEqual([
      expect.objectContaining({ messageId: first.json.value.message.messageId, nonce: "conflict" }),
    ]);
  });
});
