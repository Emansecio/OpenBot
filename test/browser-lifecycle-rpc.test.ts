import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import type { BrowserAgentLifecycle } from "../src/rpc/index.js";

const handles: ServerHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(browserLifecycle: BrowserAgentLifecycle) {
  const dir = mkdtempSync(join(tmpdir(), "openbot-browser-lifecycle-rpc-"));
  dirs.push(dir);
  const handle = await startServer(0, {
    configPath: join(dir, "config.json"),
    stateRoot: join(dir, "state"),
    runtimeRoot: join(dir, "runtime"),
    browserRoot: join(dir, "browser"),
    allowUnauthenticatedLocalGateway: true,
    keystoreDir: join(dir, "keys"),
    storePath: join(dir, "store.db"),
    workspacesRoot: join(dir, "workspaces"),
    browserLifecycle,
  });
  handles.push(handle);
  return handle;
}

async function post(handle: ServerHandle, method: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as { ok: boolean; value?: unknown; failure?: string } };
}

describe("deleteAgents browser lifecycle", () => {
  it("tears down every browser owner before removing the home", async () => {
    const observations: Array<{ agentId: string; homeExists: boolean }> = [];
    let handle!: ServerHandle;
    const browserLifecycle: BrowserAgentLifecycle = {
      async teardownAgent(agentId) {
        observations.push({ agentId, homeExists: existsSync(handle.homes!.pathFor(agentId)) });
      },
    };
    handle = await boot(browserLifecycle);
    for (const id of ["browser-victim-a", "browser-victim-b"]) {
      const created = await post(handle, "createAgent", { id, name: id });
      expect(created.status).toBe(200);
    }
    const homes = ["browser-victim-a", "browser-victim-b"].map((id) => handle.homes!.pathFor(id));

    const deleted = await post(handle, "deleteAgents", { ids: ["browser-victim-a", "browser-victim-b"] });

    expect(deleted).toMatchObject({ status: 200, json: { ok: true, value: { ids: ["browser-victim-a", "browser-victim-b"] } } });
    expect(observations).toEqual([
      { agentId: "browser-victim-a", homeExists: true },
      { agentId: "browser-victim-b", homeExists: true },
    ]);
    expect(homes.map((home) => existsSync(home))).toEqual([false, false]);
    expect(handle.config.snapshot().agents).toEqual([]);
  });

  it("propaga a falha de teardown e não remove config, transcript ou home", async () => {
    const teardown = vi.fn(async () => {
      throw new Error("lease still active");
    });
    const handle = await boot({ teardownAgent: teardown });
    const created = await post(handle, "createAgent", { id: "protected-victim", name: "Protected victim" });
    expect(created.status).toBe(200);
    const home = handle.homes!.pathFor("protected-victim");
    handle.store.append("protected-victim", [{
      kind: "message",
      id: "protected-transcript",
      role: "user",
      content: "must survive failed deletion",
      timestampMs: 1,
    }]);

    const failed = await post(handle, "deleteAgents", { ids: ["protected-victim"] });

    expect(failed.status).toBe(503);
    expect(failed.json.failure).toContain("browser teardown failed for protected-victim: lease still active");
    expect(teardown).toHaveBeenCalledWith("protected-victim");
    expect(existsSync(home)).toBe(true);
    expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["protected-victim"]);
    expect(handle.store.getEntries("protected-victim")).toContainEqual(expect.objectContaining({
      id: "protected-transcript",
      content: "must survive failed deletion",
    }));
    expect((await post(handle, "listAgents", {})).json.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "protected-victim" }),
    ]));
  });
});
