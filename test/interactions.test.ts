import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localFileBackend } from "../src/keystore/backend.js";
import { createKeystore } from "../src/keystore/index.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";

interface RpcResponse {
  ok?: boolean;
  value?: Record<string, unknown>;
  failure?: string;
}

const handles: ServerHandle[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix = "openbot-interactions-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function boot(extra: Parameters<typeof startServer>[1] = {}): Promise<ServerHandle> {
  const directory = temporaryDirectory();
  const allowUnauthenticatedLocalGateway = extra.gatewayToken === undefined;
  const handle = await startServer(0, {
    disableAgentHome: true,
    stateRoot: join(directory, "state"),
    runtimeRoot: join(directory, "runtime"),
    browserRoot: join(directory, "browser"),
    ...(allowUnauthenticatedLocalGateway ? { allowUnauthenticatedLocalGateway: true } : {}),
    configPath: join(directory, "config.json"),
    storePath: join(directory, "store.db"),
    keystoreDir: join(directory, "keys"),
    ...extra,
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
  return { status: response.status, json: await response.json() as RpcResponse };
}

describe("interaction RPC handlers", () => {
  it("dismissWidget returns the dismissed widget for the requested agent", async () => {
    const handle = await boot();

    const result = await post(handle, "dismissWidget", {
      agentId: "agent-dismiss",
      entryId: "widget-1",
    });

    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      ok: true,
      value: { ok: true, agentId: "agent-dismiss", widgetId: "widget-1" },
    });
  });

  it("dismissWidget rejects a request without a widget identifier", async () => {
    const handle = await boot();

    const result = await post(handle, "dismissWidget", { agentId: "agent-dismiss" });

    expect(result.status).toBe(400);
    expect(result.json.ok).toBe(false);
  });

  it("resolveAutoReviewApproval persists an accepted decision", async () => {
    const handle = await boot();

    const result = await post(handle, "resolveAutoReviewApproval", {
      agentId: "agent-review",
      requestId: "review-1",
      decision: "approve",
    });

    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      ok: true,
      value: {
        ok: true,
        agentId: "agent-review",
        requestId: "review-1",
        decision: "approve",
      },
    });
    expect(handle.store.getInteractionDecision("agent-review", "review-1", "auto-review-approval"))
      .toMatchObject({
        agentId: "agent-review",
        requestId: "review-1",
        kind: "auto-review-approval",
        decision: "approve",
      });
  });

  it("resolveAutoReviewApproval rejects and does not persist an invalid decision", async () => {
    const handle = await boot();

    const result = await post(handle, "resolveAutoReviewApproval", {
      agentId: "agent-review",
      requestId: "review-invalid",
      decision: "later",
    });

    expect(result.status).toBe(400);
    expect(result.json.ok).toBe(false);
    expect(handle.store.getInteractionDecision("agent-review", "review-invalid", "auto-review-approval"))
      .toBeNull();
  });

  it("submitSecret persists the submitted secret in the configured keystore", async () => {
    const directory = temporaryDirectory("openbot-submit-secret-");
    const keystoreDirectory = join(directory, "keys");
    const key = randomBytes(32);
    const keystore = createKeystore({
      dir: keystoreDirectory,
      writeBackend: localFileBackend(key),
    });
    const handle = await boot({ keystore });

    const result = await post(handle, "submitSecret", {
      agentId: "agent-secret",
      widgetId: "secret-widget-1",
      secretName: "openai",
      secretValue: "secret-test-value",
    });

    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      ok: true,
      value: {
        ok: true,
        agentId: "agent-secret",
        widgetId: "secret-widget-1",
        secretName: "openai",
      },
    });
    const reopened = createKeystore({
      dir: keystoreDirectory,
      writeBackend: localFileBackend(key),
    });
    expect(await reopened.reveal("openai")).toBe("secret-test-value");
  });

  it("submitSecret rejects a missing value without updating the keystore", async () => {
    const handle = await boot();

    const result = await post(handle, "submitSecret", {
      agentId: "agent-secret",
      widgetId: "secret-widget-invalid",
      secretName: "openai",
    });

    expect(result.status).toBe(400);
    expect(result.json.ok).toBe(false);
    expect(await handle.keystore.reveal("openai")).toBeNull();
  });
});
