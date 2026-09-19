import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { registerRpcHandlers } from "../src/rpc/index.js";
import { createMemoryTranscriptStore } from "../src/rpc/send.js";
import { Gateway } from "../src/server/gateway.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openbot-selection-"));
  const config = new ConfigStore({ configPath: join(root, "config.json") });
  const gateway = new Gateway();
  const store = createMemoryTranscriptStore();
  onTestFinished(() => {
    gateway.close();
    config.close();
    rmSync(root, { recursive: true, force: true });
  });
  config.update({ agents: [{ id: "a", name: "A", avatarId: "a" }, { id: "b", name: "B", avatarId: "b" }] });
  for (const agentId of ["a", "b"]) store.append(agentId, [{
    kind: "message", id: `${agentId}-message`, role: "user", content: `ONLY_${agentId}`, timestampMs: 1,
  }]);
  const published = vi.spyOn(gateway, "publish");
  const { runner } = registerRpcHandlers(gateway, { config, store });
  const call = async (method: string, body: unknown = {}) => {
    const handler = gateway.listHandlers().get(method);
    if (!handler) throw new Error(`Missing handler: ${method}`);
    return handler(body, { method, getStatus: () => runner.getStatus(), publish: gateway.publish.bind(gateway) });
  };
  const active = () => published.mock.calls.filter(([channel]) => channel === "agents").at(-1)?.[1];
  return { call, active, published, store };
}

describe("desktop transcript opening acknowledges roster selection", () => {
  it("publishes the opened bot before completion and reconciles deletion to the surviving bot", async () => {
    const { call, active, store } = fixture();
    expect(await call("openAgentTail", { id: "b" })).toMatchObject({ entries: [{ content: "ONLY_b" }] });
    expect(active()).toMatchObject({ activeAgentId: "b" });
    await call("deleteAgents", { ids: ["b"] });
    expect(active()).toMatchObject({ activeAgentId: "a", agents: [{ id: "a" }] });
    expect(store.getAgentTranscriptTail("a").entries).toMatchObject([{ content: "ONLY_a" }]);
    await expect(call("openAgentTail", { id: "b" })).rejects.toThrow("agente não encontrado");
    expect(active()).toMatchObject({ activeAgentId: "a" });
  });

  it("does not change selection for background reads or older pages, and keeps legacy open working", async () => {
    const { call, active, published } = fixture();
    await call("openAgentTail", { id: "b", limit: 1 });
    published.mockClear();
    await call("getAgentTranscriptTail", { id: "a", limit: 1 });
    await call("openAgentTail", { id: "a", limit: 1, beforeSeq: 2 });
    expect(active()).toBeUndefined();
    await call("openAgent", { id: "a" });
    expect(active()).toMatchObject({ activeAgentId: "a" });
  });

  it("never acknowledges a failed open", async () => {
    const { call, active, published, store } = fixture();
    await call("openAgentTail", { id: "b" });
    published.mockClear();
    await expect(call("openAgentTail", { id: "missing" })).rejects.toThrow("agente não encontrado");
    vi.spyOn(store, "openAgentTail").mockImplementationOnce(() => { throw new Error("read failed"); });
    await expect(call("openAgentTail", { id: "a" })).rejects.toThrow("read failed");
    expect(active()).toBeUndefined();
  });
});
