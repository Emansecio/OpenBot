import http from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TempRoots } from "./helpers/temp-roots.js";
// @ts-expect-error executable local recovery helper has no declaration file.
import { redactDiagnosticText, runRecoveryCommand as runRecovery } from "../scripts/recovery-center.mjs";
// @ts-expect-error executable local backup helper has no declaration file.
import { createDataBackup, restoreDataBackup } from "../scripts/data-backup.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(projectRoot, "scripts", "recovery-center.mjs");
const temp = new TempRoots();

afterEach(async () => {
  await temp.cleanup();
});

async function createInstall(): Promise<{ root: string; dataRoot: string; localDataRoot: string; args: string[] }> {
  const base = await temp.makeAsync("openbot-recovery-center-");
  const root = join(base, "checkout");
  const dataRoot = join(base, "roaming");
  const localDataRoot = join(base, "local");
  await mkdir(root, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await mkdir(localDataRoot, { recursive: true });
  return { root, dataRoot, localDataRoot, args: ["--root", root, "--data-root", dataRoot, "--local-data-root", localDataRoot] };
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
    const result = await runCli(["status", ...install.args, "--gateway-url", "http://127.0.0.1:9"]);

    expect(result).toMatchObject({
      ok: true,
      product: "OpenBot",
      root: install.root,
      dataRoot: install.dataRoot,
      localDataRoot: install.localDataRoot,
      buildPresent: false,
      dataRootPresent: true,
      processStatePresent: false,
      gateway: { running: false },
    });
    expect(redactDiagnosticText("Authorization: Bearer diagnostic-secret api_key=abc")).toBe("Authorization: Bearer [REDACTED] api_key=[REDACTED]");
  });

  it("backs up, verifies, requires confirmation, and restores with a pre-restore backup", async () => {
    const install = await createInstall();
    await writeFile(join(install.dataRoot, "openbot-config.json"), "original");
    const backup = await runCli(["backup", ...install.args, "--gateway-url", "http://127.0.0.1:9"]);
    const backupPath = String((backup.backup as { path: string }).path);
    await expect(runCli(["verify-backup", "--backup", backupPath])).resolves.toMatchObject({ ok: true, verified: true });

    await writeFile(join(install.dataRoot, "openbot-config.json"), "changed");
    await expect(runCli([
      "restore", ...install.args, "--backup", backupPath, "--gateway-url", "http://127.0.0.1:9",
    ])).rejects.toThrow(/--yes/);
    const restored = await runCli([
      "restore", ...install.args, "--backup", backupPath, "--gateway-url", "http://127.0.0.1:9", "--yes",
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
    // The bundle keeps only each log's tail, so the secret is placed there.
    await writeFile(join(logs, "gateway-error.log"), `Authorization: Bearer log-secret\n${"x".repeat(90_000)}\nAuthorization: Bearer log-secret-tail\n`);

    await runCli([
      "diagnostics", ...install.args, "--output", output, "--gateway-url", "http://127.0.0.1:9",
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
        dataRoot: install.dataRoot,
        localDataRoot: install.localDataRoot,
        gatewayUrl: `http://127.0.0.1:${port}`,
        gatewayTimeoutMs: 100,
      })).rejects.toThrow(/still running/);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("refuses backup while the recorded gateway supervisor is alive, even with the port closed", async () => {
    const install = await createInstall();
    await writeFile(join(install.root, "process.json"), JSON.stringify({ instanceId: "live", gateway: { pid: process.pid } }));
    await expect(runRecovery("backup", {
      root: install.root, dataRoot: install.dataRoot, localDataRoot: install.localDataRoot,
      gatewayUrl: "http://127.0.0.1:9", gatewayTimeoutMs: 50,
    })).rejects.toThrow(`still running (PID ${process.pid})`);
  });

  it.skipIf(process.platform !== "win32")("puts every replaced directory back when a restore swap fails midway", async () => {
    const install = await createInstall();
    await writeFile(join(install.dataRoot, "openbot-config.json"), "backed-up");
    await mkdir(join(install.localDataRoot, "workspaces"), { recursive: true });
    await writeFile(join(install.localDataRoot, "workspaces", "note.txt"), "backed-up");
    const backup = await createDataBackup({ dataRoot: install.dataRoot, localDataRoot: install.localDataRoot });
    await writeFile(join(install.dataRoot, "openbot-config.json"), "current");
    // An open handle inside workspaces makes Windows refuse to rename that directory.
    const handle = await open(join(install.localDataRoot, "workspaces", "note.txt"), "r");
    try {
      await expect(restoreDataBackup(backup.root, { dataRoot: install.dataRoot, localDataRoot: install.localDataRoot }))
        .rejects.toMatchObject({ code: expect.stringMatching(/^(EPERM|EBUSY|EACCES)$/u) });
    } finally {
      await handle.close();
    }
    await expect(readFile(join(install.dataRoot, "openbot-config.json"), "utf8")).resolves.toBe("current");
    const leftovers = (await readdir(dirname(install.dataRoot))).filter((name) => name.includes(".restore"));
    expect(leftovers).toEqual([]);
  });
});
