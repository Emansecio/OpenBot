import http from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const projectRoot = new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:");
const scriptPath = join(projectRoot, "scripts", "recovery-center.mjs");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createInstall(): Promise<{ root: string; dataRoot: string; localDataRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), "openbot-recovery-center-"));
  temporaryRoots.push(base);
  const root = join(base, "install");
  const dataRoot = join(base, "roaming");
  const localDataRoot = join(base, "local");
  await mkdir(join(root, "versions", "1.0.0"), { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await mkdir(localDataRoot, { recursive: true });
  // @ts-expect-error executable local release helper has no declaration file.
  const { writeInstallState } = await import("../scripts/release-common.mjs");
  await writeInstallState(root, {
    installRoot: root,
    activeVersion: "1.0.0",
    previousVersion: "0.9.0",
    dataRoot,
    localDataRoot,
    lastBackup: null,
    lastFailure: { message: "Authorization: Bearer diagnostic-secret", at: "2026-08-17T00:00:00.000Z" },
  });
  return { root, dataRoot, localDataRoot };
}

async function runCli(args: string[]): Promise<Record<string, unknown>> {
  const result = await execFile(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("local Recovery Center", () => {
  it("reports managed status without exposing secrets", async () => {
    const install = await createInstall();
    const result = await runCli(["status", "--root", install.root, "--gateway-url", "http://127.0.0.1:9"]);

    expect(result).toMatchObject({
      ok: true,
      product: "OpenBot",
      installRoot: install.root,
      activeVersion: "1.0.0",
      previousVersion: "0.9.0",
      dataRoot: install.dataRoot,
      localDataRoot: install.localDataRoot,
      activeReleasePresent: true,
      processStatePresent: false,
      gateway: { running: false },
    });
    expect(JSON.stringify(result)).not.toContain("diagnostic-secret");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("backs up, verifies, requires confirmation, and restores with a pre-restore backup", async () => {
    const install = await createInstall();
    await writeFile(join(install.dataRoot, "openbot-config.json"), "original");
    const backup = await runCli(["backup", "--root", install.root, "--gateway-url", "http://127.0.0.1:9"]);
    const backupPath = String((backup.backup as { path: string }).path);
    await expect(runCli(["verify-backup", "--backup", backupPath])).resolves.toMatchObject({ ok: true, verified: true });

    await writeFile(join(install.dataRoot, "openbot-config.json"), "changed");
    await expect(runCli([
      "restore", "--root", install.root, "--backup", backupPath, "--gateway-url", "http://127.0.0.1:9",
    ])).rejects.toThrow(/--yes/);
    const restored = await runCli([
      "restore", "--root", install.root, "--backup", backupPath, "--gateway-url", "http://127.0.0.1:9", "--yes",
    ]);

    await expect(readFile(join(install.dataRoot, "openbot-config.json"), "utf8")).resolves.toBe("original");
    expect(restored).toMatchObject({ ok: true, restored: true });
    expect(String((restored.preRestoreBackup as { path: string }).path)).toContain("backups");
  });

  it("writes a bounded redacted diagnostics bundle", async () => {
    const install = await createInstall();
    const logs = join(install.root, "logs");
    const output = join(install.root, "diagnostics.json");
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "gateway-error.log"), `Authorization: Bearer log-secret\n${"x".repeat(90_000)}`);

    await runCli([
      "diagnostics", "--root", install.root, "--output", output, "--gateway-url", "http://127.0.0.1:9",
    ]);
    const contents = await readFile(output, "utf8");
    expect(contents).not.toContain("log-secret");
    expect(contents).toContain("[REDACTED]");
    expect(Buffer.byteLength(contents)).toBeLessThan(80_000);
  });

  it("refuses backup while a gateway is active", async () => {
    const install = await createInstall();
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // @ts-expect-error executable local recovery helper has no declaration file.
    const { runRecoveryCommand } = await import("../scripts/recovery-center.mjs");
    try {
      await expect(runRecoveryCommand("backup", {
        root: install.root,
        gatewayUrl: `http://127.0.0.1:${port}`,
        gatewayTimeoutMs: 100,
      })).rejects.toThrow(/still running/);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
