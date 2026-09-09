import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { A2ARuntime } from "../src/a2a/runtime.js";
import { A2AStore } from "../src/a2a/store.js";
import type { A2AEnvelope } from "../src/a2a/contracts.js";
import { createGateway, SSE_MAX_FRAME_BYTES, type GatewayOptions } from "../src/server/gateway.js";

const servers: http.Server[] = [];
const stores = new Set<A2AStore>();
const roots: string[] = [];
const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
const runtimes = new Set<A2ARuntime>();
const sseReaderBuffers = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, Buffer>();
afterEach(async () => {
  await Promise.all([...runtimes].map((runtime) => runtime.stop()));
  runtimes.clear();
  await Promise.all([...readers].map(async (reader) => { try { await reader.cancel(); } catch { /* test cleanup */ } }));
  readers.clear();
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type SendInput = Omit<A2AEnvelope, "senderIncarnation" | "recipientIncarnation">;

async function bootGateway(): Promise<{ gateway: ReturnType<typeof createGateway>; port: number; store: A2AStore }> {
  const root = mkdtempSync(join(tmpdir(), "openbot-a2a-gateway-"));
  roots.push(root);
  const store = new A2AStore({ path: join(root, "store.db"), now: () => 1_000, sensitiveValues: () => [] });
  stores.add(store);
  store.syncActiveAgents(["agent-a", "agent-b"]);
  store.ensureAgentIncarnation("agent-a");
  store.ensureAgentIncarnation("agent-b");
  const options: GatewayOptions = {
    sseChannels: new Set(["a2a"]),
    // This typed option is the P2.1 contract; its data source is the real SQLite store.
    a2aSnapshot: (agentId: string) => store.getSnapshot(agentId),
  };
  const gateway = createGateway(options);
  const server = http.createServer(gateway.createHandler());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("gateway did not bind");
  return { gateway, port: address.port, store };
}

async function openSse(port: number, agentId?: string, lastEventId?: string): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const query = agentId === undefined ? "channels=a2a" : `channels=a2a&agentId=${encodeURIComponent(agentId)}`;
  const response = await fetch(`http://127.0.0.1:${port}/api/events?${query}`, {
    headers: { accept: "text/event-stream", ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }) },
  });
  if (response.body === null) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  readers.add(reader);
  return { response, reader };
}

function storeMessage(overrides: Partial<SendInput> = {}): SendInput {
  return {
    version: 1, messageId: "m1", senderAgentId: "agent-b", recipientAgentId: "agent-a",
    nonce: "nonce-m1", parentTaskId: null, parentTurnId: "turn-1", priority: "normal", hopCount: 0,
    payload: { version: 1, kind: "text", text: "hello" }, createdAtMs: 1_000, availableAtMs: 1_000, expiresAtMs: null,
    ...overrides,
  };
}

async function readSseFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let buffered = sseReaderBuffers.get(reader) ?? Buffer.alloc(0);
  while (true) {
    const delimiter = buffered.indexOf("\n\n");
    if (delimiter >= 0) {
      const frame = buffered.subarray(0, delimiter + 2);
      sseReaderBuffers.set(reader, buffered.subarray(delimiter + 2));
      return frame.toString("utf8");
    }
    const { done, value } = await reader.read();
    if (done) throw new Error("SSE stream ended before a complete frame");
    buffered = Buffer.concat([buffered, Buffer.from(value)]);
  }
}

async function readSseFrameContaining(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  while (true) {
    const frame = await readSseFrame(reader);
    if (frame.includes(needle)) return frame;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("P2.1 A2A SSE gateway projection", () => {
  it("requires an agent scope for a2a and isolates recipient streams", async () => {
    const { gateway, port } = await bootGateway();
    const missing = await openSse(port);
    expect(missing.response.status).toBe(400);
    if (missing.response.status !== 400) return;
    const a = await openSse(port, "agent-a");
    const b = await openSse(port, "agent-b");
    await a.reader.read();
    await b.reader.read();
    const receiptA = gateway.publish("a2a", { agentId: "agent-a", epoch: "epoch-1", sequence: 4, messageId: "a-only" });
    const receiptB = gateway.publish("a2a", { agentId: "agent-b", epoch: "epoch-1", sequence: 4, messageId: "b-only" });
    expect(receiptA).toMatchObject({ accepted: true, eligibleClients: 1, acceptedClients: 1, rejectedClients: 0 });
    expect(receiptB).toMatchObject({ accepted: true, eligibleClients: 1, acceptedClients: 1, rejectedClients: 0 });
    const aFrame = new TextDecoder().decode((await a.reader.read()).value);
    const bFrame = new TextDecoder().decode((await b.reader.read()).value);
    expect(aFrame).toContain("a-only");
    expect(aFrame).not.toContain("b-only");
    expect(bFrame).toContain("b-only");
    expect(bFrame).not.toContain("a-only");
  });

  it("emits stable epoch/sequence IDs and resyncs from the real SQLite snapshot for stale cursors", async () => {
    const { gateway, port, store } = await bootGateway();
    store.send(storeMessage());
    const snapshot = store.getSnapshot("agent-a");
    const connected = await openSse(port, "agent-a");
    const initial = new TextDecoder().decode((await connected.reader.read()).value);
    expect(initial).toContain('"type":"snapshot"');
    expect(initial).toContain(`"epoch":"${snapshot.epoch}"`);
    expect(initial).toContain(`"sequence":${snapshot.sequence}`);
    expect(initial).toContain('"messageId":"m1"');
    gateway.publish("a2a", { agentId: "agent-a", epoch: snapshot.epoch, sequence: snapshot.sequence + 1, messageId: "m4" });
    const live = new TextDecoder().decode((await connected.reader.read()).value);
    expect(live).toContain(`id: a2a:${snapshot.epoch}:${snapshot.sequence + 1}`);

    const stale = await openSse(port, "agent-a", "a2a:epoch-old:99");
    const frame = new TextDecoder().decode((await stale.reader.read()).value);
    expect(frame).toContain('"type":"snapshot"');
    expect(frame).toContain('"resyncRequired":true');
    expect(frame).toContain('"messageId":"m1"');

    const current = await openSse(port, "agent-a", `a2a:${snapshot.epoch}:${snapshot.sequence}`);
    const currentFrame = new TextDecoder().decode((await current.reader.read()).value);
    expect(currentFrame).toContain('"resyncRequired":false');
    expect(currentFrame).toContain('"reason":"cursor-current"');
  });

  it("uses bounded resync frames and never treats SSE receipt as a durable consumer ACK", async () => {
    const { gateway, port, store } = await bootGateway();
    store.send(storeMessage());
    const stream = await openSse(port, "agent-a");
    await readSseFrameContaining(stream.reader, '"type":"snapshot"');
    const receipt = gateway.publish("a2a", {
      agentId: "agent-a",
      epoch: "epoch-1",
      sequence: 5,
      messageId: "m1",
      payload: "x".repeat(300 * 1024),
    });
    expect(receipt).toEqual({ accepted: false, eligibleClients: 1, acceptedClients: 0, rejectedClients: 1 });
    const frame = await readSseFrameContaining(stream.reader, '"reason":"frame-too-large"');
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(SSE_MAX_FRAME_BYTES);
    expect(frame).toContain('"resyncRequired":true');
    expect(frame).toContain('"method":"listAgentMessages"');

    expect(store.getMessageForRecipient("agent-a", "m1")).toMatchObject({
      status: "queued",
      ackNonce: null,
    });
  });

  it("publishes the durable projection through the gateway without ACKing before successful consume", async () => {
    const { gateway, port, store } = await bootGateway();
    store.send(storeMessage());
    const stream = await openSse(port, "agent-a");
    await readSseFrameContaining(stream.reader, '"type":"snapshot"');
    let consumptionAllowed = false;
    const runtime = new A2ARuntime({
      store,
      agentIds: () => ["agent-a"],
      isUserLaneBusy: () => false,
      isUserLanePending: () => !consumptionAllowed,
      pollIntervalMs: 10,
      publishProjection: (envelope) => gateway.publish("a2a", {
        agentId: envelope.agentId,
        epoch: envelope.epoch,
        sequence: envelope.sequence,
        messageId: envelope.messageId,
        transitionVersion: envelope.transitionVersion,
        eventKind: envelope.eventKind,
        message: envelope.payload,
      }).accepted,
      consume: async ({ message }) => ({ ackNonce: `ack-${message.messageId}` }),
    });
    runtimes.add(runtime);
    runtime.start();

    const queuedFrame = await readSseFrameContaining(stream.reader, '"eventKind":"queued"');
    expect(queuedFrame).toContain('"messageId":"m1"');
    expect(store.getMessageForRecipient("agent-a", "m1")).toMatchObject({ status: "queued", ackNonce: null });

    consumptionAllowed = true;
    runtime.wake();
    await waitFor(() => store.getMessageForRecipient("agent-a", "m1")?.status === "acked");
    expect(store.getMessageForRecipient("agent-a", "m1")).toMatchObject({ status: "acked", ackNonce: "ack-m1" });
  });
});
