import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { EventEmitter as EventEmitterType } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PassThrough as PassThroughType } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));

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
      child.kill = () => true;
      child.stdin = {
        end: () => queueMicrotask(() => {
          child.stdout.end(JSON.stringify({ ok: true }));
          child.emit("close", 0);
        }),
      };
      return child;
    }),
  };
});

import { createWebauthnBridge } from "../src/server/webauthn-bridge.js";

const roots: string[] = [];
afterEach(async () => {
  spawnState.options.splice(0);
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
});
