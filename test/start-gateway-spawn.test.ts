import { execFile, spawn as spawnChild } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"));
const desktopCmdPath = join(root, "scripts", "openbot-desktop.cmd");
const temporaryRoots: string[] = [];
const currentProcessEvidence = {
  pid: process.pid,
  creationTime: "start-gateway-spawn-test",
  executablePath: process.execPath,
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

function spawnWithMissingCwd(file: string, args: string[], options: { cwd?: string }) {
  if (options.cwd != null) rmSync(options.cwd, { recursive: true, force: true });
  return spawnChild(file, args, options as never);
}

describe("start-gateway spawn failures", () => {
  it("fails the default startup before recording ownership and releases its lock", async () => {
    // @ts-expect-error executable helper has no declaration file.
    const { startGateway } = await import("../scripts/start-gateway.mjs");
    const installRoot = await temporaryRoot("openbot-start-gateway-spawn-default-");
    const recordGatewayOwnership = vi.fn(async () => {
      throw new Error("ownership must not be recorded");
    });

    await expect(startGateway({
      installRoot,
      captureProcessEvidence: async () => currentProcessEvidence,
      spawn: spawnWithMissingCwd,
      recordGatewayOwnership,
    })).rejects.toThrow(/failed to start|spawn|ENOENT/iu);

    expect(recordGatewayOwnership).not.toHaveBeenCalled();
    expect(existsSync(`${installRoot}.openbot-operation.lock`)).toBe(false);
  });

  it("surfaces an asynchronous spawn error while waiting for readiness", async () => {
    // @ts-expect-error executable helper has no declaration file.
    const { startGateway } = await import("../scripts/start-gateway.mjs");
    const installRoot = await temporaryRoot("openbot-start-gateway-spawn-ready-");
    const recordGatewayOwnership = vi.fn(async () => {
      throw new Error("ownership must not be recorded");
    });

    await expect(startGateway({
      installRoot,
      url: "http://127.0.0.1:9",
      waitForReady: true,
      timeoutMs: 1_000,
      captureProcessEvidence: async () => currentProcessEvidence,
      spawn: spawnWithMissingCwd,
      recordGatewayOwnership,
    })).rejects.toThrow(/failed to start|spawn|ENOENT/iu);

    expect(recordGatewayOwnership).not.toHaveBeenCalled();
    expect(existsSync(`${installRoot}.openbot-operation.lock`)).toBe(false);
  });

  it("keeps start-gateway stderr in a per-invocation launcher log", () => {
    const command = readFileSync(desktopCmdPath, "utf8");

    expect(command).toMatch(/set "GATEWAY_ERROR_LOG=%CD%\\logs\\start-gateway-%RANDOM%-%RANDOM%\.log"/u);
    expect(command).toContain('2^>"%GATEWAY_ERROR_LOG%"');
    expect(command).toContain('Veja "%GATEWAY_ERROR_LOG%".');
    expect(command).not.toMatch(/start-gateway\.mjs"[^\r\n]*2\^>nul/u);
    expect(command).not.toContain("gateway-error.log");
  });

  it.skipIf(process.platform !== "win32")("runs the actual CMD gateway block and preserves its failure diagnostic", async () => {
    const installRoot = await temporaryRoot("openbot-launcher-log-");
    await mkdir(join(installRoot, "scripts"));
    await mkdir(join(installRoot, "logs"));
    await writeFile(join(installRoot, "scripts", "start-gateway.mjs"), 'process.stderr.write("fixture gateway unavailable"); process.exitCode = 1;');
    const launcher = readFileSync(desktopCmdPath, "utf8");
    const block = launcher.slice(launcher.indexOf('set "GATEWAY_STARTED=0"'), launcher.indexOf(":gateway_ready"));
    const fixture = join(installRoot, "gateway-block.cmd");
    await writeFile(fixture, `@echo off\r\n${block}\r\nexit /b 0\r\n`);
    let failure: unknown;
    try {
      await promisify(execFile)(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", fixture], {
        cwd: installRoot, env: { ...process.env, OPENBOT_ROOT: installRoot }, windowsHide: true,
      });
    } catch (error) { failure = error; }
    const logs = await readdir(join(installRoot, "logs"));
    expect(logs).toHaveLength(1);
    const logPath = join(installRoot, "logs", logs[0]!);
    expect(failure).toMatchObject({ code: 1, stdout: expect.stringContaining(logPath) });
    expect(await readFile(logPath, "utf8")).toContain("fixture gateway unavailable");
  });
});
