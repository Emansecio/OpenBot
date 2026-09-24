import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultConfigPath } from "../src/config/store.js";
import { defaultWorkspacesRoot } from "../src/execution/home.js";
import { defaultRuntimeRoot } from "../src/execution/runtime/wsl/installer.js";
import { defaultKeystoreDir } from "../src/keystore/index.js";
import { defaultGatewayTokenPath } from "../src/server/auth.js";
import { defaultStoreDir } from "../src/store/index.js";
import { TempRoots } from "./helpers/temp-roots.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const electronMainPath = join(root, "client", "extracted", "dist", "electron-main", "main.cjs");
const desktopCmdPath = join(root, "scripts", "openbot-desktop.cmd");
const desktopVbsPath = join(root, "scripts", "openbot-desktop.vbs");
const gatewayHealthPath = join(root, "scripts", "gateway-health.mjs");
const temp = new TempRoots();
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
  it("emits opt-in monotonic startup telemetry without environment values", async () => {
    // @ts-expect-error executable helper has no declaration file.
    const { createStartupTrace } = await import("../scripts/launch.mjs");
    const lines: string[] = [];
    let now = 100;
    const trace = createStartupTrace({
      enabled: true,
      now: () => (now += 25),
      write: (line: string) => lines.push(line),
    });

    trace.mark("launcher-start");
    trace.mark("gateway-ready", { adopted: false });

    expect(lines).toHaveLength(2);
    const events = lines.map((line) => JSON.parse(line.replace(/^\[openbot\]\[startup\] /, "")));
    expect(events).toEqual([
      { event: "launcher-start", elapsedMs: 25 },
      { event: "gateway-ready", elapsedMs: 50, adopted: false },
    ]);
    expect(lines.join("\n")).not.toContain(process.env.OPENBOT_DATA_ROOT ?? "__unset__");

    const disabledLines: string[] = [];
    createStartupTrace({ enabled: false, write: (line: string) => disabledLines.push(line) }).mark("ignored");
    expect(disabledLines).toEqual([]);
  });

  it("observa saída e erro do Electron antes do bookkeeping assíncrono", async () => {
    // @ts-expect-error executable local launch helper has no declaration file.
    const { observeChildProcess } = await import("../scripts/launch.mjs");
    const events: string[] = [];
    let emitExit: ((code: number | null, signal: string | null) => void) | undefined;
    const child = {
      exitCode: null as number | null,
      signalCode: null as string | null,
      once(event: string, callback: (...args: any[]) => void) {
        events.push(event);
        if (event === "exit") emitExit = callback;
        return this;
      },
    };

    const outcome = observeChildProcess(child);
    expect(events).toEqual(["error", "exit"]);
    emitExit?.(0, null);
    await expect(outcome).resolves.toEqual({ code: 0, signal: null });
  });

  it("converte erro precoce do Electron em resultado tratado", async () => {
    // @ts-expect-error executable local launch helper has no declaration file.
    const { observeChildProcess } = await import("../scripts/launch.mjs");
    const failure = new Error("electron spawn failed");
    const child = {
      exitCode: null as number | null,
      signalCode: null as string | null,
      once(event: string, callback: (error: Error) => void) {
        if (event === "error") queueMicrotask(() => callback(failure));
        return this;
      },
    };

    await expect(observeChildProcess(child)).resolves.toEqual({ error: failure });
  });

  it("reconhece um processo que já encerrou antes da observação", async () => {
    // @ts-expect-error executable local launch helper has no declaration file.
    const { observeChildProcess } = await import("../scripts/launch.mjs");
    const child = {
      exitCode: 23,
      signalCode: null as string | null,
      once() { return this; },
    };

    await expect(observeChildProcess(child)).resolves.toEqual({ code: 23, signal: null });
  });

  it("keeps the performance probe isolated and removes only roots it owns", () => {
    const probe = readFileSync(join(root, "scripts", "perf-probe.mjs"), "utf8");
    expect(probe).toContain('process.env.NODE_ENV = "test"');
    expect(probe).toMatch(/const ownsDataRoot = !process\.env\.OPENBOT_DATA_ROOT;\r?\nconst dataRoot = process\.env\.OPENBOT_DATA_ROOT \|\| join\(tmpdir\(\), "openbot-perf-" \+ Date\.now\(\)\)/u);
    expect(probe.match(/\brm\(/gu)).toHaveLength(1);
    expect(probe).toMatch(/\} finally \{[\s\S]*if \(ownsDataRoot\) await rm\(dataRoot, \{ recursive: true, force: true \}\);\r?\n\}/u);
    expect(probe).not.toContain("process.exit(0)");
  });

  it("does not create repository logs as a start-gateway import side effect", async () => {
    const logsPath = join(root, "logs");
    const logsExistedBefore = existsSync(logsPath);
    const entriesBefore = logsExistedBefore ? (await readdir(logsPath, { recursive: true })).sort() : [];
    const source = readFileSync(join(root, "scripts", "start-gateway.mjs"), "utf8");
    expect(source).not.toContain("mkdirSync(logs");
    expect(source).toContain('const logs = join(installRoot, "logs")');
    expect(source).toContain("await mkdir(logs");
    // @ts-expect-error executable helper has no declaration file.
    await import("../scripts/start-gateway.mjs");
    expect(existsSync(logsPath)).toBe(logsExistedBefore);
    expect(logsExistedBefore ? (await readdir(logsPath, { recursive: true })).sort() : []).toEqual(entriesBefore);
  });

  it("uses explicit roaming and local data roots consistently", () => {
    vi.stubEnv("OPENBOT_DATA_ROOT", "C:\\OpenBot-Test\\roaming-custom");
    vi.stubEnv("OPENBOT_LOCAL_DATA_ROOT", "C:\\OpenBot-Test\\local-custom");

    expect(defaultConfigPath()).toBe("C:\\OpenBot-Test\\roaming-custom\\openbot-config.json");
    expect(defaultStoreDir()).toBe("C:\\OpenBot-Test\\roaming-custom");
    expect(defaultKeystoreDir()).toBe("C:\\OpenBot-Test\\roaming-custom");
    expect(defaultGatewayTokenPath()).toBe("C:\\OpenBot-Test\\roaming-custom\\gateway.token");
    expect(defaultWorkspacesRoot()).toBe("C:\\OpenBot-Test\\local-custom\\workspaces");
    expect(defaultRuntimeRoot()).toBe("C:\\OpenBot-Test\\local-custom\\runtime");
  });

  it("requests the Electron lock for local portable launches and marks secondary exits", () => {
    const main = readFileSync(electronMainPath, "utf8");
    expect(main).toMatch(/var isPrimaryInstance = process\.env\.OPENBOT_LOCAL_GATEWAY === "1" \|\| import_electron50\.app\.isPackaged \? import_electron50\.app\.requestSingleInstanceLock\(\) : true;\r?\nif \(!isPrimaryInstance\) import_electron50\.app\.exit\(23\);/u);
    expect(main).toContain('app.on("second-instance"');
  });

  it("keeps shortcut launch hidden while surfacing failures and recovering an existing gateway", () => {
    const command = readFileSync(desktopCmdPath, "utf8");
    const hidden = readFileSync(desktopVbsPath, "utf8");
    const health = readFileSync(gatewayHealthPath, "utf8");
    const shutdown = readFileSync(join(root, "scripts", "shutdown-gateway.mjs"), "utf8");

    expect(hidden).toContain("fileSystem.GetTempName");
    expect(hidden).toContain("DateDiff");
    expect(hidden).toMatch(/exitCode = shell\.Run\(command, 0, True\)\r?\nIf exitCode <> 0 Then MsgBox "OpenBot nao conseguiu iniciar\."[\s\S]*\r?\nIf exitCode = 0 Then/u);
    expect(command).toContain('set "GATEWAY_ADOPTED=1"');
    expect(command).not.toContain('if "%GATEWAY_ADOPTED%"=="1" goto cleanup_gateway');
    expect(command).toMatch(/if "%GATEWAY_STARTED%"=="1" goto cleanup_gateway\r?\nexit \/b %ELECTRON_EXIT%/);
    expect(command).toContain('gateway-health.mjs" pid');
    expect(command).toMatch(/if "%ELECTRON_EXIT%"=="23" \([\s\S]{0,160}del \/q "%ELECTRON_STDIO_LOG%"/);
    expect(command).toContain('shutdown-gateway.mjs" --root "%OPENBOT_ROOT%"');
    expect(command).not.toMatch(/taskkill[\s\S]*\/f/i);
    expect(command).toContain('--pid "%GATEWAY_PID%"');
    expect(command).toContain('if not "%SHUTDOWN_EXIT%"=="0" if "%ELECTRON_EXIT%"=="0" exit /b %SHUTDOWN_EXIT%');
    expect(command).toMatch(/if "%ELECTRON_EXIT%"=="23"[\s\S]{0,220}if "%GATEWAY_STARTED%"=="1"[\s\S]{0,100}goto cleanup_gateway/);
    expect(shutdown).toContain("pid: args.pid");
    expect(health).toContain('mode !== "pid"');
    expect(health).toContain("process.stdout.write(String(health.pid))");
  });

  it("never terminates a gateway adopted from another desktop instance", () => {
    const launcher = readFileSync(join(root, "scripts", "launch.mjs"), "utf8");

    expect(launcher).toContain("timeoutMs = 45_000");
    expect(launcher).toMatch(/if \(ownsGateway && gatewayPid != null\) \{[\s\S]{0,320}teardownLaunchGateway\(/);
    expect(launcher).not.toMatch(/else if \(gatewayPid != null[\s\S]{0,300}terminateProcess\(gatewayPid\)/);
    expect(launcher.indexOf("captureGatewayEvidenceWithRetry(gatewayPid")).toBeLessThan(launcher.indexOf("await waitForGatewayReady(childEnv.SAND_HOST_GATEWAY_URL"));
    expect(launcher).toContain("processState: gatewayOwnership");
    expect(launcher).toContain('if (!shutdown.teardownProven) throw new Error("OpenBot gateway teardown was not proven")');
  });

  it("serializes installation operations and rejects a recycled lock owner", async () => {
    const installRoot = await temporaryRoot("openbot-lock-");
    // @ts-expect-error executable local helper has no declaration file.
    const { acquireInstallLock, installLayout } = await import("../scripts/release-common.mjs");
    const identity = { pid: process.pid, creationTime: "same", executablePath: process.execPath, commandLine: "test" };
    const first = await acquireInstallLock(installRoot, {
      timeoutMs: 50,
      captureProcessEvidence: async () => identity,
      queryProcessEvidence: async () => identity,
    });
    await expect(acquireInstallLock(installRoot, {
      timeoutMs: 20,
      captureProcessEvidence: async () => identity,
      queryProcessEvidence: async () => identity,
    })).rejects.toThrow(/busy/u);
    await first.release();

    const lockPath = installLayout(installRoot).operationLock;
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      ownerId: "recycled",
      pid: 424242,
      createdAt: Date.now(),
      creationTime: "old-start",
      executablePath: "C:\\old\\node.exe",
    }));
    const recovered = await acquireInstallLock(installRoot, {
      timeoutMs: 20,
      captureProcessEvidence: async () => identity,
      queryProcessEvidence: async () => ({ pid: 424242, creationTime: "new-start", executablePath: "C:\\new\\node.exe" }),
    });
    await recovered.release();
    expect(existsSync(lockPath)).toBe(false);
    await writeFile(lockPath, "foreign marker");
    await expect(acquireInstallLock(installRoot, {
      timeoutMs: 0,
      captureProcessEvidence: async () => identity,
    })).rejects.toThrow(/lock.*directory/u);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("foreign marker");
    await rm(lockPath, { force: true });
    const target = join(installRoot, "foreign-lock-target");
    await mkdir(target, { recursive: true });
    await symlink(target, lockPath, process.platform === "win32" ? "junction" : "dir");
    await expect(acquireInstallLock(installRoot, {
      timeoutMs: 0,
      captureProcessEvidence: async () => identity,
    })).rejects.toThrow(/reparse|symbolic-link/u);
    expect(existsSync(target)).toBe(true);
    await rm(lockPath, { recursive: true, force: true });
  });

  it("allows only one concurrent startup to create and record the gateway", async () => {
    const installRoot = await temporaryRoot("openbot-start-race-");
    // @ts-expect-error executable start helper has no declaration file.
    const { startGateway } = await import("../scripts/start-gateway.mjs");
    let gatewayPid: number | null = null;
    let spawnCount = 0;
    let recordCount = 0;
    const child = (pid: number) => ({
      pid,
      exitCode: null as number | null,
      signalCode: null as string | null,
      once() { return this; },
      unref() { return undefined; },
      kill() { this.exitCode = 1; return true; },
    });
    const common = {
      installRoot,
      adoptExisting: true,
      readGatewayHealth: async () => gatewayPid == null ? null : { ok: true, pid: gatewayPid },
      queryProcessEvidence: async (pid: number) => ({
        pid,
        creationTime: "gateway",
        executablePath: process.execPath,
        commandLine: `${process.execPath} ${join(installRoot, "dist", "main.js")}`,
      }),
      captureProcessEvidence: async (pid: number) => ({
        pid,
        creationTime: "gateway",
        executablePath: process.execPath,
        expectedRoot: installRoot,
        commandLine: `${process.execPath} ${join(installRoot, "dist", "main.js")}`,
      }),
      recordGatewayOwnership: async ({ pid }: { pid: number }) => {
        recordCount += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        gatewayPid = pid;
      },
      spawn: () => {
        spawnCount += 1;
        return child(50_000 + spawnCount);
      },
    };
    const results = await Promise.all([startGateway(common), startGateway(common)]);
    expect(spawnCount).toBe(1);
    expect(recordCount).toBe(1);
    expect(results.filter((result: { adopted?: boolean }) => result.adopted === true)).toHaveLength(1);
  });

  it.each(["valid", "wrong-pid", "wrong-executable", "wrong-script", "missing-process", "unhealthy"])(
    "validates ready gateway identity before publishing ownership (%s)", async (scenario) => {
      // @ts-expect-error executable start helper has no declaration file.
      const { startGateway } = await import("../scripts/start-gateway.mjs");
      const installRoot = await temporaryRoot("openbot-start-identity-");
      const order: string[] = [];
      const child = {
        pid: 4820,
        exitCode: null as number | null,
        signalCode: null,
        kill: vi.fn(function () { child.exitCode = 1; return true; }),
        unref: vi.fn(),
      };
      const server = http.createServer((_request, response) => {
        order.push("health");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, pid: scenario === "unhealthy" ? 4821 : child.pid }));
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address() as { port: number };
      const query = vi.fn(async () => {
        order.push("identity");
        return scenario === "missing-process" ? null : {
          pid: scenario === "wrong-pid" ? 4821 : child.pid,
          creationTime: "fixture-creation",
          executablePath: scenario === "wrong-executable" ? join(installRoot, "other.exe") : process.execPath,
          commandLine: join(installRoot, "dist", scenario === "wrong-script" ? "other.js" : "main.js"),
        };
      });
      const writeState = vi.fn(async () => { order.push("record"); });
      try {
        const result = startGateway({
          installRoot, lock: {}, spawn: () => child, waitForReady: true,
          timeoutMs: 100, url: `http://127.0.0.1:${address.port}`,
          queryProcessEvidence: query, writeState,
        });
        if (scenario === "valid") {
          await expect(result).resolves.toMatchObject({ pid: child.pid, adopted: false });
          expect(order).toEqual(["health", "identity", "record"]);
          expect(writeState).toHaveBeenCalledWith(join(installRoot, "process.json"), expect.objectContaining({
            processes: { gateway: expect.objectContaining({ pid: child.pid, creationTime: "fixture-creation", executablePath: process.execPath }) },
          }));
          expect(child.unref).toHaveBeenCalledOnce();
          expect(child.kill).not.toHaveBeenCalled();
        } else {
          await expect(result).rejects.toThrow(scenario === "unhealthy" ? /ready/u : /identity/u);
          expect(writeState).not.toHaveBeenCalled();
          expect(child.unref).not.toHaveBeenCalled();
          expect(child.kill).toHaveBeenCalledOnce();
        }
        expect(query).toHaveBeenCalledTimes(scenario === "unhealthy" ? 0 : 1);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  );

  it("recovers when a concurrent lock owner disappears between lstat and realpath", async () => {
    const installRoot = await temporaryRoot("openbot-lock-toctou-");
    // @ts-expect-error executable local helper has no declaration file.
    const { acquireInstallLock, installLayout } = await import("../scripts/release-common.mjs");
    const identity = { pid: process.pid, creationTime: "toctou", executablePath: process.execPath, commandLine: "test" };
    const first = await acquireInstallLock(installRoot, {
      timeoutMs: 100,
      captureProcessEvidence: async () => identity,
      queryProcessEvidence: async () => identity,
    });
    let released = false;
    const lockPath = installLayout(installRoot).operationLock;
    const second = await acquireInstallLock(installRoot, {
      timeoutMs: 100,
      captureProcessEvidence: async () => identity,
      queryProcessEvidence: async () => identity,
      beforeRealpath: async (candidate: string) => {
        if (!released && resolve(candidate).toLowerCase() === resolve(lockPath).toLowerCase()) {
          released = true;
          await first.release();
        }
      },
    });
    await second.release();
    expect(released).toBe(true);
  });

  it("fails update and rollback busy without mutating the existing state", async () => {
    const installRoot = await temporaryRoot("openbot-maintenance-busy-");
    const statePath = join(installRoot, "state.json");
    const state = JSON.stringify({ schemaVersion: 1, product: "OpenBot", installRoot, activeVersion: "1.0.0" });
    await writeFile(statePath, state);
    // @ts-expect-error executable local helper has no declaration file.
    const { acquireInstallLock } = await import("../scripts/release-common.mjs");
    // @ts-expect-error executable update helper has no declaration file.
    const { updateRelease, rollbackRelease } = await import("../scripts/update.mjs");
    const lock = await acquireInstallLock(installRoot, {
      captureProcessEvidence: async () => currentProcessEvidence,
    });
    const lockEvidence = {
      captureProcessEvidence: async () => currentProcessEvidence,
      queryProcessEvidence: async () => currentProcessEvidence,
    };
    await Promise.all([
      expect(updateRelease({ installRoot, lockTimeoutMs: 0, ...lockEvidence })).rejects.toThrow(/busy/u),
      expect(rollbackRelease({ installRoot, lockTimeoutMs: 0, ...lockEvidence })).rejects.toThrow(/busy/u),
    ]);
    await lock.release();
    await expect(readFile(statePath, "utf8")).resolves.toBe(state);
  });

  it("rotates oversized logs with bounded retention", async () => {
    const directory = await temporaryRoot("openbot-log-rotation-");
    const log = join(directory, "gateway.log");
    await writeFile(log, "x".repeat(128));
    // @ts-expect-error executable local release helper has no declaration file.
    const { rotateLogFile } = await import("../scripts/release-common.mjs");

    await rotateLogFile(log, { maxBytes: 64, backups: 2 });

    await expect(readFile(`${log}.1`, "utf8")).resolves.toBe("x".repeat(128));
    expect(existsSync(log)).toBe(false);
  });

});
