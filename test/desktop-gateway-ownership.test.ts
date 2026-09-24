import http from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TempRoots } from "./helpers/temp-roots.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = new TempRoots();
const execFileAsync = promisify(execFileCallback);
const currentProcessEvidence = {
  pid: process.pid,
  creationTime: "test-process",
  executablePath: process.execPath,
  commandLine: process.execPath,
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await temp.cleanup();
});

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temp.track(path);
  return path;
}


describe("desktop lifecycle hardening", () => {

  it("ignores dead owned process records and removes stale process state", async () => {
    const installRoot = await temporaryRoot("openbot-stale-process-");
    // @ts-expect-error executable local release helper has no declaration file.
    const { installLayout, quiesceInstall } = await import("../scripts/release-common.mjs");
    const statePath = installLayout(installRoot).processState;
    await writeFile(statePath, JSON.stringify({
      processes: {
        gateway: {
          pid: 2_000_000_000,
          creationTime: "stale",
          executablePath: join(installRoot, "runtime", "node.exe"),
          expectedRoot: installRoot,
        },
      },
    }));

    await expect(quiesceInstall(installRoot, {
      timeoutMs: 50,
      queryProcessEvidence: async () => null,
      isPortPresent: async () => false,
    })).resolves.toMatchObject({ pids: [] });
    expect(existsSync(statePath)).toBe(false);
  });

  it("fails closed when a gateway port is active but process state is missing", async () => {
    const installRoot = await temporaryRoot("openbot-quiesce-no-state-");
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, "keep.txt"), "preserve");
    // @ts-expect-error executable local helper has no declaration file.
    const { quiesceInstall } = await import("../scripts/release-common.mjs");

    await expect(quiesceInstall(installRoot, {
      timeoutMs: 50,
      isPortPresent: async () => true,
      queryProcessEvidence: async () => null,
    })).rejects.toThrow(/active|port|state/i);
    await expect(readFile(join(installRoot, "keep.txt"), "utf8")).resolves.toBe("preserve");
  });

  it("removes process state only for the launcher instance that wrote it", async () => {
    const installRoot = await temporaryRoot("openbot-process-owner-");
    // @ts-expect-error executable local release helper has no declaration file.
    const { installLayout, removeOwnedProcessState } = await import("../scripts/release-common.mjs");
    const statePath = installLayout(installRoot).processState;
    await writeFile(statePath, JSON.stringify({ instanceId: "owner-a" }));

    await removeOwnedProcessState(statePath, "owner-b");
    expect(existsSync(statePath)).toBe(true);
    await removeOwnedProcessState(statePath, "owner-a");
    expect(existsSync(statePath)).toBe(false);
  });

  it("does not remove a new process marker that wins a tombstone race", async () => {
    const installRoot = await temporaryRoot("openbot-process-race-");
    // @ts-expect-error executable local release helper has no declaration file.
    const { installLayout, removeOwnedProcessState } = await import("../scripts/release-common.mjs");
    const statePath = installLayout(installRoot).processState;
    await writeFile(statePath, JSON.stringify({ instanceId: "owner-old" }));
    await expect(removeOwnedProcessState(statePath, "owner-old", {
      afterRename: async ({ path }: { path: string }) => writeFile(path, JSON.stringify({ instanceId: "owner-new" })),
    })).resolves.toBe(false);
    await expect(readFile(statePath, "utf8")).resolves.toContain("owner-new");
  });

  it("never adopts a health PID whose executable/command line is not this release gateway", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // @ts-expect-error executable local release helper has no declaration file.
    const { readOwnedGatewayHealth } = await import("../scripts/launch.mjs");
    try {
      await expect(readOwnedGatewayHealth(
        `http://127.0.0.1:${port}`,
        process.execPath,
        "C:\\definitely-not-this-process\\dist\\main.js",
      )).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("requests graceful shutdown before any force fallback and does not force on success", async () => {
    const base = await temporaryRoot("openbot-shutdown-helper-");
    const dataRoot = join(base, "data");
    const processStatePath = join(base, "process.json");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "gateway.token"), "test-token\n");
    const record = { pid: 4811, creationTime: "created", executablePath: join(base, "runtime", "node.exe"), expectedRoot: base };
    await writeFile(processStatePath, JSON.stringify({ dataRoot, gateway: { url: "http://127.0.0.1:1340", dataRoot }, processes: { gateway: record } }));
    let alive = true;
    const calls: string[] = [];
    // @ts-expect-error executable helper has no declaration file.
    const { shutdownGateway } = await import("../scripts/shutdown-gateway.mjs");
    const result = await shutdownGateway({
      processStatePath,
      queryProcessEvidence: async () => alive ? record : null,
      queryGatewayPid: async () => record.pid,
      requestShutdown: async ({ token }: { token: string }) => {
        calls.push(`request:${token}`);
        alive = false;
      },
      isPortPresent: async () => false,
      forceKill: async () => { calls.push("force"); },
      timeoutMs: 100,
      removeState: true,
    });
    expect(result).toMatchObject({ ok: true, forced: false, teardownProven: true, gracefulAccepted: true });
    expect(calls).toEqual(["request:test-token"]);
    expect(existsSync(processStatePath)).toBe(false);
  });

  it("executes the shutdown CLI from an install path containing spaces", async () => {
    const base = await temporaryRoot("openbot shutdown spaced-");
    const dataRoot = join(base, "data");
    const processStatePath = join(base, "process.json");
    const fixturePath = join(base, "gateway fixture.mjs");
    const shutdownPath = join(root, "scripts", "shutdown-gateway.mjs");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "gateway.token"), "test-token\n");
    await writeFile(fixturePath, [
      'import http from "node:http";',
      'const server = http.createServer((request, response) => {',
      '  if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ pid: process.pid })); return; }',
      '  if (request.url === "/shutdown" && request.method === "POST") { response.writeHead(202); response.end(); setImmediate(() => server.close(() => process.exit(0))); return; }',
      '  response.writeHead(404); response.end();',
      '});',
      'server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n"));',
    ].join("\n"));

    const child = spawn(process.execPath, [fixturePath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let childExited = false;
    child.once("exit", () => { childExited = true; });
    try {
      const [line] = await once(child.stdout!, "data");
      const { port } = JSON.parse(String(line).trim());
      // @ts-expect-error executable helper has no declaration file.
      const { captureProcessEvidence } = await import("../scripts/release-common.mjs");
      const evidence = await captureProcessEvidence(child.pid!, { expectedRoot: base });
      await writeFile(processStatePath, JSON.stringify({
        instanceId: "spaced-cli",
        dataRoot,
        gateway: { url: `http://127.0.0.1:${port}`, dataRoot },
        processes: { gateway: evidence },
      }));

      const { stdout } = await execFileAsync(process.execPath, [
        shutdownPath,
        "--process-state", processStatePath,
        "--data-root", dataRoot,
        "--url", `http://127.0.0.1:${port}`,
        "--timeout", "2000",
        "--remove-state",
      ], { windowsHide: true, maxBuffer: 1024 * 1024 });
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, teardownProven: true, gracefulAccepted: true });
      if (!childExited) await once(child, "exit");
      expect(childExited).toBe(true);
    } finally {
      if (!childExited) child.kill();
    }
  });

  it("refuses shutdown when the live gateway port answers for another PID", async () => {
    const base = await temporaryRoot("openbot-shutdown-race-");
    const dataRoot = join(base, "data");
    const processStatePath = join(base, "process.json");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "gateway.token"), "test-token\n");
    const record = { pid: 4821, creationTime: "created", executablePath: join(base, "runtime", "node.exe"), expectedRoot: base };
    await writeFile(processStatePath, JSON.stringify({ dataRoot, gateway: { url: "http://127.0.0.1:1340", dataRoot }, processes: { gateway: record } }));
    let requested = false;
    let forced = false;
    // @ts-expect-error executable helper has no declaration file.
    const { shutdownGateway } = await import("../scripts/shutdown-gateway.mjs");
    await expect(shutdownGateway({
      processStatePath,
      queryProcessEvidence: async () => record,
      queryGatewayPid: async () => 900_001,
      isPortPresent: async () => true,
      requestShutdown: async () => { requested = true; },
      forceKill: async () => { forced = true; },
    })).resolves.toMatchObject({ ok: false, owned: false, teardownProven: false, reason: "gateway-pid-mismatch" });
    expect(requested).toBe(false);
    expect(forced).toBe(false);
    expect(existsSync(processStatePath)).toBe(true);
  });

  it("preserves a legacy marker without a gateway record while its port is active", async () => {
    const base = await temporaryRoot("openbot-legacy-port-");
    const statePath = join(base, "process.json");
    await writeFile(statePath, JSON.stringify({ instanceId: "legacy", gateway: { url: "http://127.0.0.1:1340" } }));
    // @ts-expect-error executable release helper has no declaration file.
    const { quiesceInstall } = await import("../scripts/release-common.mjs");
    await expect(quiesceInstall(base, {
      isPortPresent: async () => true,
      queryProcessEvidence: async () => null,
    })).rejects.toThrow(/gateway port|ownership|process state/iu);
    expect(existsSync(statePath)).toBe(true);
  });

  it("forces only after timeout and a fresh matching ownership proof", async () => {
    const base = await temporaryRoot("openbot-shutdown-timeout-");
    const dataRoot = join(base, "data");
    const processStatePath = join(base, "process.json");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "gateway.token"), "test-token\n");
    const record = { pid: 4812, creationTime: "created", executablePath: join(base, "runtime", "node.exe"), expectedRoot: base };
    await writeFile(processStatePath, JSON.stringify({ dataRoot, processes: { gateway: record } }));
    const calls: string[] = [];
    let probes = 0;
    let killed = false;
    // @ts-expect-error executable local helper has no declaration file.
    const { shutdownGateway } = await import("../scripts/shutdown-gateway.mjs");
    const result = await shutdownGateway({
      processStatePath,
      queryProcessEvidence: async () => { probes += 1; return killed ? null : record; },
      queryGatewayPid: async () => record.pid,
      requestShutdown: async () => { calls.push("request"); },
      isPortPresent: async () => !killed,
      forceKill: async () => { calls.push("force"); killed = true; },
      timeoutMs: 5,
    });
    expect(result).toMatchObject({ ok: true, forced: true, teardownProven: true });
    expect(calls).toEqual(["request", "force"]);
    expect(probes).toBeGreaterThan(1);
  });

  it("treats an active loopback TCP port as present even when health returns 404", async () => {
    const base = await temporaryRoot("openbot-shutdown-port-");
    const dataRoot = join(base, "data");
    const processStatePath = join(base, "process.json");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "gateway.token"), "test-token\n");
    const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const record = { pid: 4815, creationTime: "created", executablePath: join(base, "runtime", "node.exe"), expectedRoot: base };
    await writeFile(processStatePath, JSON.stringify({ dataRoot, processes: { gateway: record } }));
    let killed = false;
    // @ts-expect-error executable local helper has no declaration file.
    const { shutdownGateway } = await import("../scripts/shutdown-gateway.mjs");
    try {
      const result = await shutdownGateway({
        processStatePath,
        url: `http://127.0.0.1:${port}`,
        queryProcessEvidence: async () => killed ? null : record,
        queryGatewayPid: async () => record.pid,
        requestShutdown: async () => undefined,
        forceKill: async () => { killed = true; await new Promise<void>((resolveClose) => server.close(() => resolveClose())); },
        timeoutMs: 1,
      });
      expect(result).toMatchObject({ ok: true, forced: true });
    } finally {
      if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("rejects invalid timeout values before requesting or forcing", async () => {
    // @ts-expect-error executable local helper has no declaration file.
    const { normalizeTimeout, shutdownGateway } = await import("../scripts/shutdown-gateway.mjs");
    expect(() => normalizeTimeout(Number.NaN)).toThrow(/finite non-negative/);
    expect(() => normalizeTimeout(Number.POSITIVE_INFINITY)).toThrow(/finite non-negative/);
    expect(() => normalizeTimeout(-1)).toThrow(/finite non-negative/);
    await expect(shutdownGateway({ timeoutMs: Number.NaN })).rejects.toThrow(/finite non-negative/);
  });

  it("proves stale teardown when both the PID and loopback port are absent", async () => {
    const base = await temporaryRoot("openbot-shutdown-stale-");
    const statePath = join(base, "process.json");
    const record = { pid: 4819, creationTime: "created", executablePath: join(base, "runtime", "node.exe"), expectedRoot: base };
    await writeFile(statePath, JSON.stringify({ instanceId: "stale", processes: { gateway: record } }));
    // @ts-expect-error executable local helper has no declaration file.
    const { shutdownGateway } = await import("../scripts/shutdown-gateway.mjs");
    await expect(shutdownGateway({
      processStatePath: statePath,
      queryProcessEvidence: async () => null,
      isPortPresent: async () => false,
      removeState: true,
    })).resolves.toMatchObject({ ok: true, teardownProven: true, gracefulAccepted: false, reason: "stale" });
    expect(existsSync(statePath)).toBe(false);

    await writeFile(statePath, JSON.stringify({ instanceId: "active-port", processes: { gateway: record } }));
    await expect(shutdownGateway({
      processStatePath: statePath,
      queryProcessEvidence: async () => null,
      isPortPresent: async () => true,
      removeState: true,
    })).resolves.toMatchObject({ ok: false, teardownProven: false, reason: "process-absent" });
    expect(existsSync(statePath)).toBe(true);
  });

  it("does not call spontaneous process disappearance graceful shutdown", async () => {
    const base = await temporaryRoot("openbot-shutdown-spontaneous-");
    const dataRoot = join(base, "data");
    const processStatePath = join(base, "process.json");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "gateway.token"), "test-token\n");
    const record = { pid: 4820, creationTime: "created", executablePath: join(base, "runtime", "node.exe"), expectedRoot: base };
    await writeFile(processStatePath, JSON.stringify({ dataRoot, processes: { gateway: record } }));
    let probes = 0;
    // @ts-expect-error executable helper has no declaration file.
    const { shutdownGateway } = await import("../scripts/shutdown-gateway.mjs");
    await expect(shutdownGateway({
      processStatePath,
      queryProcessEvidence: async () => probes++ === 0 ? record : null,
      queryGatewayPid: async () => record.pid,
      requestShutdown: async () => { throw new Error("not accepted"); },
      isPortPresent: async () => false,
      removeState: true,
      timeoutMs: 10,
    })).resolves.toMatchObject({ ok: true, teardownProven: true, forced: false, gracefulAccepted: false, reason: "graceful-unavailable" });
    expect(existsSync(processStatePath)).toBe(false);
  });

  it("continues from a nonzero graceful taskkill to a fresh-proof force fallback", async () => {
    const base = await temporaryRoot("openbot-process-force-");
    const record = { pid: 4816, creationTime: "created", expectedExecutable: join(base, "runtime", "node.exe"), expectedRoot: base };
    let alive = true;
    const calls: string[] = [];
    // @ts-expect-error executable local helper has no declaration file.
    const { terminateOwnedProcess } = await import("../scripts/release-common.mjs");
    await expect(terminateOwnedProcess(record, {
      platform: "win32",
      timeoutMs: 1,
      queryProcessEvidence: async () => alive ? { ...record, executablePath: record.expectedExecutable } : null,
      isProcessRunning: async () => alive,
      runTaskkill: async (_args: string[], force: boolean) => {
        calls.push(force ? "force" : "graceful");
        if (force) alive = false;
        else throw new Error("graceful taskkill returned nonzero");
      },
    })).resolves.toMatchObject({ teardownProven: true, forced: true });
    expect(calls).toEqual(["graceful", "force"]);
  });

  it("leaves an adopted or unverifiable gateway untouched and never leaks token errors", async () => {
    const base = await temporaryRoot("openbot-shutdown-adopted-");
    const processStatePath = join(base, "process.json");
    const missingDataRoot = join(base, "missing-data");
    const record = { pid: 4813, creationTime: "created", executablePath: join(base, "runtime", "node.exe"), expectedRoot: base };
    await writeFile(processStatePath, JSON.stringify({ dataRoot: missingDataRoot, processes: { gateway: record } }));
    let requested = false;
    // @ts-expect-error executable local helper has no declaration file.
    const { shutdownGateway } = await import("../scripts/shutdown-gateway.mjs");
    await expect(shutdownGateway({
      processStatePath,
      queryProcessEvidence: async () => ({ ...record, executablePath: "C:\\other\\node.exe" }),
      requestShutdown: async () => { requested = true; },
      forceKill: async () => { throw new Error("must not force"); },
    })).resolves.toMatchObject({ owned: false, teardownProven: false });
    expect(requested).toBe(false);
    expect(existsSync(processStatePath)).toBe(true);
    let killed = false;
    await expect(shutdownGateway({
      processStatePath,
      queryProcessEvidence: async () => killed ? null : record,
      queryGatewayPid: async () => record.pid,
      requestShutdown: async () => undefined,
      isPortPresent: async () => !killed,
      forceKill: async () => { killed = true; },
      timeoutMs: 1,
    })).resolves.toMatchObject({ ok: true, forced: true, reason: "graceful-unavailable" });
  });

  it("records ownership without a token and rejects non-loopback shutdown URLs", async () => {
    const base = await temporaryRoot("openbot-shutdown-record-");
    const processStatePath = join(base, "process.json");
    // @ts-expect-error executable local helper has no declaration file.
    const { recordGatewayOwnership, shutdownGateway } = await import("../scripts/shutdown-gateway.mjs");
    await expect(recordGatewayOwnership({
      installRoot: base,
      processStatePath,
      pid: 4814,
      url: "http://127.0.0.1:1340",
      dataRoot: join(base, "data"),
      captureProcessEvidence: async () => ({
        pid: 4814,
        creationTime: "created",
        executablePath: join(base, "runtime", "node.exe"),
        expectedRoot: base,
      }),
    })).resolves.toMatchObject({ ok: true, pid: 4814 });
    const state = JSON.parse(await readFile(processStatePath, "utf8"));
    expect(JSON.stringify(state)).not.toContain("token");
    await expect(shutdownGateway({
      processStatePath,
      url: "https://attacker.example",
      queryProcessEvidence: async () => state.processes.gateway,
    })).rejects.toThrow("must be loopback");
  });

  it("tears down an owned gateway from in-memory evidence when marker persistence fails", async () => {
    const base = await temporaryRoot("openbot-shutdown-marker-fail-");
    const dataRoot = join(base, "data");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "gateway.token"), "test-token\n");
    const record = { pid: 4817, creationTime: "created", executablePath: join(base, "runtime", "node.exe"), expectedRoot: base };
    let alive = true;
    const calls: string[] = [];
    // @ts-expect-error executable local helper has no declaration file.
    const { recordGatewayOwnership } = await import("../scripts/shutdown-gateway.mjs");
    await expect(recordGatewayOwnership({
      installRoot: base,
      pid: record.pid,
      dataRoot,
      captureProcessEvidence: async () => record,
      writeState: async () => { throw new Error("marker failed"); },
      queryProcessEvidence: async () => alive ? record : null,
      queryGatewayPid: async () => record.pid,
      requestShutdown: async () => { calls.push("graceful"); },
      isPortPresent: async () => alive,
      forceKill: async () => { calls.push("force"); alive = false; },
      timeoutMs: 1,
    })).rejects.toThrow("ownership state could not be recorded");
    expect(calls).toEqual(["graceful", "force"]);
    expect(JSON.stringify(calls)).not.toContain("test-token");
  });

  it("tears down a still-live gateway when readiness fails instead of reporting success", async () => {
    const base = await temporaryRoot("openbot-readiness-fail-");
    const dataRoot = join(base, "data");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "gateway.token"), "test-token\n");
    const record = { pid: 4818, creationTime: "created", executablePath: join(base, "runtime", "node.exe"), expectedRoot: base };
    const state = { instanceId: "readiness", dataRoot, gateway: { url: "http://127.0.0.1:1340", dataRoot }, processes: { gateway: record } };
    let alive = true;
    // @ts-expect-error executable local helper has no declaration file.
    const { teardownLaunchGateway } = await import("../scripts/launch.mjs");
    await expect(teardownLaunchGateway({
      installRoot: base,
      processState: state,
      queryProcessEvidence: async () => alive ? record : null,
      queryGatewayPid: async () => record.pid,
      requestShutdown: async () => undefined,
      isPortPresent: async () => alive,
      forceKill: async () => { alive = false; },
      timeoutMs: 1,
    })).resolves.toMatchObject({ teardownProven: true, forced: true });
    expect(alive).toBe(false);
  });

  it("uses the freshly spawned child handle when ownership capture never succeeds", async () => {
    // @ts-expect-error executable local launch helper has no declaration file.
    const { captureGatewayEvidenceWithRetry, teardownLaunchGateway } = await import("../scripts/launch.mjs");
    let captures = 0;
    await expect(captureGatewayEvidenceWithRetry(4819, {
      attempts: 2,
      captureProcessEvidence: async () => {
        captures += 1;
        throw new Error("evidence unavailable");
      },
    })).rejects.toThrow("evidence unavailable");
    expect(captures).toBe(2);

    let killed = false;
    const child = {
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill() {
        killed = true;
        this.exitCode = 1;
        return true;
      },
      once() { return this; },
    };
    await expect(teardownLaunchGateway({ gatewayChild: child })).resolves.toMatchObject({
      childHandle: true,
      teardownProven: true,
    });
    expect(killed).toBe(true);
  });

  it("does not publish a gateway PID until start-gateway ownership recording succeeds", async () => {
    // @ts-expect-error executable start helper has no declaration file.
    const { startGateway } = await import("../scripts/start-gateway.mjs");
    let killed = false;
    let unrefed = false;
    const child = {
      pid: 4820,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill() { killed = true; this.exitCode = 1; return true; },
      once() { return this; },
      unref() { unrefed = true; },
    };
    await expect(startGateway({
      installRoot: await temporaryRoot("openbot-start-gateway-"),
      captureProcessEvidence: async () => currentProcessEvidence,
      spawn: () => child,
      recordGatewayOwnership: async () => { throw new Error("marker unavailable"); },
    })).rejects.toThrow("marker unavailable");
    expect(killed).toBe(true);
    expect(unrefed).toBe(false);
  });

  it("does not adopt a gateway when executable identity is unverifiable", async () => {
    const installRoot = await temporaryRoot("openbot-start-gateway-identity-");
    // @ts-expect-error executable start helper has no declaration file.
    const { startGateway } = await import("../scripts/start-gateway.mjs");
    let spawned = 0;
    const child = {
      pid: 9137,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill() { this.exitCode = 1; return true; },
      once() { return this; },
      unref() { return undefined; },
    };

    await expect(startGateway({
      installRoot,
      adoptExisting: true,
      readGatewayHealth: async () => ({ ok: true, pid: 9136 }),
      queryProcessEvidence: async () => ({
        pid: 9136,
        creationTime: "gateway",
        executablePath: null,
        commandLine: `${process.execPath} ${join(installRoot, "dist", "main.js")}`,
      }),
      captureProcessEvidence: async () => currentProcessEvidence,
      spawn: () => { spawned += 1; return child; },
      recordGatewayOwnership: async () => { throw new Error("marker unavailable"); },
    })).rejects.toThrow("marker unavailable");
    expect(spawned).toBe(1);
  });

  it("rejects health from a different PID and reports an exited backend promptly", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pid: 999_999 }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // @ts-expect-error executable local release helper has no declaration file.
    const { waitForGateway } = await import("../scripts/launch.mjs");
    try {
      await expect(waitForGateway(`http://127.0.0.1:${port}`, 123_456, { exitCode: 17 }, 500))
        .rejects.toThrow(/exited with code 17/);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

});
