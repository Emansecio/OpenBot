import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_HOST, startServer, stopServer, type ServerHandle } from "../src/main.js";
import { createProviderRegistry } from "../src/providers/router.js";

let handle: ServerHandle | undefined; let dir: string | undefined;
afterEach(async () => { if (handle) await stopServer(handle); handle = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const post = (h: ServerHandle, path: string, body: unknown) => new Promise<{status:number; json:any}>((resolve, reject) => {
  const req = http.request({ host: GATEWAY_HOST, port: h.port, path, method: "POST", headers: { "content-type": "application/json" }, agent: false }, (res) => {
    const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }));
  }); req.on("error", reject); req.end(JSON.stringify(body));
});
async function waitForStoreClosed(h: ServerHandle, agentId: string, conversationId: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      h.store.getEntries(agentId, conversationId);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`store close timeout after ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
describe("gateway shutdown with a running turn", () => {
  it("mantém stores abertos após timeout até o drain tardio do turno", async () => {
    dir = mkdtempSync(join(tmpdir(), "openbot-late-drain-"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat() {
        await blocked;
      },
    });
    handle = await startServer(0, {
      registry,
      stateRoot: join(dir, "state"), runtimeRoot: join(dir, "runtime"), browserRoot: join(dir, "browser"),
      allowUnauthenticatedLocalGateway: true,
      storePath: join(dir, "store.db"), configPath: join(dir, "config.json"), keystoreDir: join(dir, "keys"),
      workspacesRoot: join(dir, "workspaces"),
    });
    expect((await post(handle, "/api/createAgent", { id: "openbot-default", name: "Late Drain Bot", provider: "xai", model: "grok-4.6" })).status).toBe(200);
    const active = handle.conversationStore.ensureDefault("openbot-default");
    expect((await post(handle, "/api/sendPrompt", { agentId: "openbot-default", conversationId: active.id, prompt: "aguarde" })).status).toBe(200);
    for (let i = 0; i < 100 && handle.runner.getStatus().runningTurns === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(handle.runner.getStatus().runningTurns).toBe(1);

    const closingHandle = handle;
    await expect(stopServer(closingHandle, { turnTimeoutMs: 10 })).rejects.toThrow(/timed out|timeout|encerra/i);
    handle = undefined;
    expect(closingHandle.server.listening).toBe(false);
    expect(() => closingHandle.store.getEntries("openbot-default", active.id)).not.toThrow();

    release();
    await closingHandle.runner.waitForDrain();
    await waitForStoreClosed(closingHandle, "openbot-default", active.id);
  });
});
