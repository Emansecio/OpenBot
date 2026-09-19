import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { EventEmitter as EventEmitterType } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PassThrough as PassThroughType } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  output: JSON.stringify({ ok: true }) as string | undefined,
  exitCode: 0 as number | null,
  emitError: undefined as string | undefined,
  emitClose: true,
  killCalls: 0,
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    spawn: vi.fn((_path: string, _args: string[], options: Record<string, unknown>) => {
      spawnState.options.push(options);
      const child = new EventEmitter() as EventEmitterType & {
        stdin: { end(input: string): void };
        stdout: PassThroughType;
        stderr: PassThroughType;
        kill(): boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        spawnState.killCalls += 1;
        return true;
      };
      child.stdin = {
        end: () => queueMicrotask(() => {
          if (spawnState.output !== undefined) child.stdout.end(spawnState.output);
          if (spawnState.emitError !== undefined) child.emit("error", new Error(spawnState.emitError));
          if (spawnState.emitClose) child.emit("close", spawnState.exitCode);
        }),
      };
      return child;
    }),
  };
});

import { createWebauthnBridge } from "../src/server/webauthn-bridge.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  spawnState.options.splice(0);
  spawnState.output = JSON.stringify({ ok: true });
  spawnState.exitCode = 0;
  spawnState.emitError = undefined;
  spawnState.emitClose = true;
  spawnState.killCalls = 0;
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureBridge() {
  const root = await mkdtemp(join(tmpdir(), "openbot-webauthn-"));
  roots.push(root);
  const signer = join(root, "signer.exe");
  await writeFile(signer, "fixture");
  return createWebauthnBridge(signer);
}

const ceremony = {
  kind: "get",
  origin: "https://example.com",
  optionsJson: JSON.stringify({ challenge: "fixture" }),
};

describe("WebAuthn signer bridge", () => {
  it("does not pass gateway secrets to the native signer environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-webauthn-"));
    roots.push(root);
    const signer = join(root, "signer.exe");
    await writeFile(signer, "fixture");
    const allowedKeys = ["COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "WINDIR"];
    for (const key of allowedKeys) vi.stubEnv(key, `allowed-${key.toLowerCase()}`);
    vi.stubEnv("OPENBOT_GATEWAY_TOKEN", "must-not-reach-signer");
    vi.stubEnv("SAND_HOST_GATEWAY_TOKEN", "must-not-reach-signer-either");
    vi.stubEnv("DATABASE_URL", "must-not-reach-signer-either");

    const bridge = createWebauthnBridge(signer);
    await bridge("/webauthn/ceremony", {
      kind: "get",
      origin: "https://example.com",
      optionsJson: JSON.stringify({ challenge: "fixture" }),
    });

    expect(spawnState.options).toHaveLength(1);
    const expectedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => value !== undefined && allowedKeys.includes(key.toUpperCase())),
    );
    expect(spawnState.options[0]?.env).toEqual(expectedEnvironment);
    expect(spawnState.options[0]?.env).not.toHaveProperty("OPENBOT_GATEWAY_TOKEN");
    expect(spawnState.options[0]?.env).not.toHaveProperty("SAND_HOST_GATEWAY_TOKEN");
    expect(spawnState.options[0]?.env).not.toHaveProperty("DATABASE_URL");
  });

  it("rejects invalid signer JSON after close instead of leaving the request pending", async () => {
    const bridge = await fixtureBridge();
    spawnState.output = "not-json";

    await expect(bridge("/webauthn/ceremony", ceremony)).rejects.toMatchObject({
      status: 502,
      message: "WebAuthn signer returned invalid JSON",
    });
    expect(spawnState.killCalls).toBe(0);
  });

  it("settles a valid signer error payload exactly once", async () => {
    const bridge = await fixtureBridge();
    spawnState.output = JSON.stringify({ error: "user denied" });

    await expect(bridge("/webauthn/ceremony", ceremony)).resolves.toEqual({ error: "user denied" });
  });

  it("rejects and kills the signer when it never closes", async () => {
    vi.useFakeTimers();
    const bridge = await fixtureBridge();
    spawnState.output = undefined;
    spawnState.emitClose = false;

    const pending = bridge("/webauthn/ceremony", ceremony);
    const rejection = expect(pending).rejects.toMatchObject({ status: 504, message: "WebAuthn ceremony timed out" });
    await vi.waitFor(() => expect(spawnState.options).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(spawnState.killCalls).toBe(1);
  });

  it("keeps the first failure when signer error is followed by close", async () => {
    const bridge = await fixtureBridge();
    spawnState.emitError = "fixture signer failure";

    await expect(bridge("/webauthn/ceremony", ceremony)).rejects.toMatchObject({
      status: 503,
      message: "WebAuthn signer failed: fixture signer failure",
    });
  });
});
