import { EventEmitter } from "node:events";
import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createGateway } from "../src/server/gateway.js";

interface TestSseClient {
  res: http.ServerResponse;
  channels: ReadonlySet<string> | null;
  agentId: string | null;
  blocked: boolean;
  pending: string[];
  pendingBytes: number;
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  destroyCalls = 0;
  readonly writes: string[] = [];
  private readonly results = [false, true, true];

  write(frame: string): boolean {
    this.writes.push(frame);
    return this.results.shift() ?? true;
  }

  destroy(): this {
    this.destroyed = true;
    this.destroyCalls += 1;
    return this;
  }
}

describe("Gateway SSE backpressure", () => {
  it("mantém o cliente e retoma frames pendentes em drain", () => {
    const gateway = createGateway();
    const response = new FakeResponse();
    const client: TestSseClient = {
      res: response as unknown as http.ServerResponse,
      channels: null,
      agentId: null,
      blocked: false,
      pending: [],
      pendingBytes: 0,
    };
    const harness = gateway as unknown as {
      sseClients: Set<TestSseClient>;
      flushSse(client: TestSseClient): void;
      writeSse(client: TestSseClient, frame: string, heartbeat?: boolean): void;
    };
    harness.sseClients.add(client);
    response.on("drain", () => harness.flushSse(client));

    gateway.publish("transcript", { sequence: 1 });
    gateway.publish("transcript", { sequence: 2 });

    expect(response.destroyCalls).toBe(0);
    expect(response.writes).toHaveLength(1);
    expect(client.pending).toHaveLength(1);

    harness.writeSse(client, ":ping\n\n", true);
    expect(response.destroyCalls).toBe(0);
    expect(response.writes).toHaveLength(1);
    expect(client.pending).toHaveLength(1);

    response.emit("drain");

    expect(response.destroyCalls).toBe(0);
    expect(response.writes).toHaveLength(2);
    expect(response.writes[0]).toContain('"sequence":1');
    expect(response.writes[1]).toContain('"sequence":2');
    expect(client.pending).toEqual([]);
    expect(client.pendingBytes).toBe(0);

    gateway.publish("transcript", { sequence: 3 });
    expect(response.writes[2]).toContain('"sequence":3');
  });

  it("troca backlog excedente por resync sem destruir o EventSource", () => {
    const gateway = createGateway();
    const response = new FakeResponse();
    const client: TestSseClient = {
      res: response as unknown as http.ServerResponse,
      channels: null,
      agentId: null,
      blocked: false,
      pending: [],
      pendingBytes: 0,
    };
    const harness = gateway as unknown as {
      sseClients: Set<TestSseClient>;
      flushSse(client: TestSseClient): void;
    };
    harness.sseClients.add(client);

    gateway.publish("transcript", { type: "updated", agentId: "a", content: "x".repeat(128 * 1024) });
    gateway.publish("transcript", { type: "updated", agentId: "a", content: "y".repeat(128 * 1024) });
    gateway.publish("transcript", { type: "updated", agentId: "a", content: "z".repeat(128 * 1024) });

    expect(response.destroyCalls).toBe(0);
    expect(harness.sseClients.has(client)).toBe(true);
    expect(client.pending).toHaveLength(1);
    expect(client.pending[0]).toContain('"type":"resync"');
    expect(client.pending[0]).toContain('"reason":"backpressure"');

    response.emit("drain");
    expect(response.destroyCalls).toBe(0);
  });

  it("não serializa publish sem cliente interessado", () => {
    const gateway = createGateway();
    let serialized = 0;
    gateway.publish("transcript", {
      toJSON() {
        serialized += 1;
        return { value: true };
      },
    });
    expect(serialized).toBe(0);
  });

  it("mantém o stream e publica resync compacto em frame oversized", () => {
    const gateway = createGateway();
    const response = new FakeResponse();
    const client: TestSseClient = {
      res: response as unknown as http.ServerResponse,
      channels: null,
      agentId: null,
      blocked: false,
      pending: [],
      pendingBytes: 0,
    };
    const harness = gateway as unknown as { sseClients: Set<TestSseClient> };
    harness.sseClients.add(client);

    gateway.publish("transcript", { type: "snapshot", agentId: "a", entries: ["x".repeat(300 * 1024)] });
    expect(response.destroyCalls).toBe(0);
    expect(response.writes).toHaveLength(1);
    expect(Buffer.byteLength(response.writes[0]!)).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.parse(response.writes[0]!.slice("data: ".length).trim())).toMatchObject({
      channel: "transcript",
      payload: { type: "resync", agentId: "a", resyncRequired: true },
    });
    expect(harness.sseClients.has(client)).toBe(true);
  });

  it("escopa transcript por agente e preserva replicaKey com dois-pontos no SSE id", () => {
    const gateway = createGateway();
    const a = new FakeResponse();
    const b = new FakeResponse();
    const client = (response: FakeResponse, agentId: string): TestSseClient => ({
      res: response as unknown as http.ServerResponse,
      channels: new Set(["transcript"]),
      agentId,
      blocked: false,
      pending: [],
      pendingBytes: 0,
    });
    const clientA = client(a, "a");
    const clientB = client(b, "b");
    const harness = gateway as unknown as { sseClients: Set<TestSseClient> };
    harness.sseClients.add(clientA);
    harness.sseClients.add(clientB);

    gateway.publish("transcript", {
      type: "delta",
      agentId: "a",
      entryId: "entry-1",
      fragment: "oi",
      ordered: { replicaKey: "transcript:a:entry:entry-1", epoch: "epoch-a", sequence: 7 },
    });

    expect(a.writes).toHaveLength(1);
    expect(b.writes).toHaveLength(0);
    expect(a.writes[0]).toContain("id: transcript:transcript%3Aa%3Aentry%3Aentry-1:epoch-a:7");
  });
});
