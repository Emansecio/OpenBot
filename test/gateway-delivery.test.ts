import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createGateway, SSE_MAX_FRAME_BYTES, type Gateway } from "../src/server/gateway.js";

const servers: http.Server[] = [];
const requests: http.ClientRequest[] = [];

afterEach(async () => {
  for (const request of requests.splice(0)) request.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  })));
});

async function listen(gateway: Gateway): Promise<number> {
  const server = http.createServer(gateway.createHandler());
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}

/** Opens an SSE stream and resolves once the response headers arrive. */
function openStream(port: number, query = ""): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: `/api/events${query}`, headers: { accept: "text/event-stream" } }, resolve);
    request.on("error", reject);
    requests.push(request);
  });
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

const until = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("SSE delivery receipts", () => {
  it("accepts frames buffered past the socket high-water mark instead of reporting them rejected", async () => {
    const gateway = createGateway();
    const port = await listen(gateway);
    const response = await openStream(port);
    response.pause(); // never read: every write piles up in Node's buffers
    // Each frame exceeds the socket high-water mark; three stay within the pending budget.
    const big = { agentId: "a", text: "x".repeat(Math.floor(SSE_MAX_FRAME_BYTES / 3)) };
    const receipts = [gateway.publish("agents", big), gateway.publish("agents", big), gateway.publish("agents", big)];
    for (const receipt of receipts) expect(receipt).toMatchObject({ accepted: true, eligibleClients: 1, acceptedClients: 1 });
  });

  it("reports rejection once a backed-up client is switched to a resync instruction", async () => {
    const gateway = createGateway();
    const port = await listen(gateway);
    const response = await openStream(port);
    response.pause();
    const big = { agentId: "a", text: "y".repeat(SSE_MAX_FRAME_BYTES - 1_000) };
    const receipts = Array.from({ length: 12 }, () => gateway.publish("agents", big));
    expect(receipts.some((receipt) => !receipt.accepted)).toBe(true);
  });

  it("releases the SSE slot when building the reconnect snapshot fails", async () => {
    const gateway = createGateway();
    gateway.setTranscriptSnapshotProvider(() => { throw new Error("database is locked"); });
    const port = await listen(gateway);
    const response = await openStream(port, "?agentId=a&channels=transcript");
    await new Promise((resolve) => response.on("close", resolve).resume());
    await until(() => gateway.publish("agents", { agentId: "a" }).eligibleClients === 0);
  });
});

describe("transcript reconnect snapshot", () => {
  it("keeps the newest entries that fit one frame and marks the rest for paging", async () => {
    const gateway = createGateway();
    const entries = Array.from({ length: 400 }, (_, index) => ({ kind: "message", id: `m${index}`, role: "user", content: "z".repeat(2_000), timestampMs: index }));
    gateway.setTranscriptSnapshotProvider((agentId) => ({ agentId, activeAgentId: agentId, entries }));
    const port = await listen(gateway);
    const response = await openStream(port, "?agentId=a&channels=transcript");
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => { text += chunk; });
    await until(() => text.includes("\"entries\""));
    await until(() => /\n\n/.test(text.slice(text.indexOf("\"entries\""))));
    const frame = text.split("\n\n").find((part) => part.includes("\"entries\""))!;
    expect(Buffer.byteLength(`${frame}\n\n`, "utf8")).toBeLessThanOrEqual(SSE_MAX_FRAME_BYTES);
    const payload = (JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as { payload: { entries: Array<{ id: string }>; truncated?: boolean; method?: string } }).payload;
    expect(payload).toMatchObject({ truncated: true, method: "openAgentTail" });
    expect(payload.entries.at(-1)?.id).toBe("m399");
    expect(payload.entries.length).toBeGreaterThan(50);
    expect(payload.entries.length).toBeLessThan(400);
    const ids = payload.entries.map((entry) => Number(entry.id.slice(1)));
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, index) => 400 - ids.length + index));
  });
});

describe("quiescence", () => {
  it("refuses local execution and task mutations once shutdown began, but keeps cancellation", async () => {
    let executed = 0;
    const gateway = createGateway({ localExecHandler: () => { executed += 1; return { ok: true }; } });
    for (const method of ["dispatchAsyncTask", "steerAsyncTask", "settleAsyncTask", "abortAsyncTask"]) {
      gateway.registerHandler(method, () => ({ method }));
    }
    const port = await listen(gateway);
    expect((await post(port, "/local-exec/execute", {})).status).toBe(200);
    gateway.beginQuiescence();

    expect(await post(port, "/local-exec/execute", {})).toEqual({ status: 503, json: { ok: false, failure: "gateway quiescing" } });
    expect(executed).toBe(1);
    for (const method of ["dispatchAsyncTask", "steerAsyncTask", "settleAsyncTask"]) {
      expect((await post(port, `/api/${method}`, {})).status).toBe(503);
    }
    expect(await post(port, "/api/abortAsyncTask", {})).toEqual({ status: 200, json: { ok: true, value: { method: "abortAsyncTask" } } });
  });
});
