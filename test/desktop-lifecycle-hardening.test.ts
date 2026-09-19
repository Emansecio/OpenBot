import http from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultConfigPath } from "../src/config/store.js";
import { defaultWorkspacesRoot } from "../src/execution/home.js";
import { defaultRuntimeRoot } from "../src/execution/runtime/wsl/installer.js";
import { defaultKeystoreDir } from "../src/keystore/index.js";
import { defaultGatewayTokenPath } from "../src/server/auth.js";
import { defaultStoreDir } from "../src/store/index.js";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"));
const electronMainPath = join(root, "client", "extracted", "dist", "electron-main", "main.cjs");
const desktopCmdPath = join(root, "scripts", "openbot-desktop.cmd");
const desktopVbsPath = join(root, "scripts", "openbot-desktop.vbs");
const gatewayHealthPath = join(root, "scripts", "gateway-health.mjs");
const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFileCallback);
const currentProcessEvidence = {
  pid: process.pid,
  creationTime: "test-process",
  executablePath: process.execPath,
  commandLine: process.execPath,
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
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

  it("serializes only supported deferred uninstall arguments without losing spaced paths", async () => {
    // @ts-expect-error executable local uninstall helper has no declaration file.
    const { buildDeferredUninstallArguments } = await import("../scripts/uninstall.mjs");
    const installRoot = "C:\\OpenBot Test\\install";
    const dataRoot = "C:\\OpenBot Test\\user data";
    const shortcutRoot = "C:\\OpenBot Test\\shortcut data";

    expect(buildDeferredUninstallArguments([
      "--purge-data",
      "--yes",
      "--data-root", dataRoot,
      "--shortcut-root", shortcutRoot,
    ], installRoot)).toEqual([
      "--root", installRoot,
      "--purge-data",
      "--yes",
      "--data-root", dataRoot,
      "--shortcut-root", shortcutRoot,
    ]);
    expect(() => buildDeferredUninstallArguments(["--unknown"], installRoot)).toThrow(/Unsupported uninstall argument/);
  });

  it("does not trust persisted shortcut paths during uninstall", async () => {
    const base = await temporaryRoot("openbot-uninstall-shortcut-boundary-");
    const installRoot = join(base, "install");
    const dataRoot = join(base, "data");
    const shortcutRoot = join(base, "shortcuts");
    const externalShortcut = join(base, "keep-external.lnk");
    await mkdir(installRoot, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(externalShortcut, "foreign shortcut");
    await writeFile(join(installRoot, "state.json"), JSON.stringify({
      schemaVersion: 1,
      product: "OpenBot",
      installRoot,
      activeVersion: "1.0.0",
      dataRoot,
      shortcutRoot,
      shortcuts: { desktop: externalShortcut, startMenu: externalShortcut },
    }));
    // @ts-expect-error executable local uninstall helper has no declaration file.
    const { uninstallRelease } = await import("../scripts/uninstall.mjs");

    await uninstallRelease({
      installRoot,
      shortcutRoot,
      quiesceTimeoutMs: 50,
      deferredCleanupDelayMs: 0,
      captureProcessEvidence: async () => currentProcessEvidence,
      queryProcessEvidence: async () => null,
      isPortPresent: async () => false,
    });

    await expect(readFile(externalShortcut, "utf8")).resolves.toBe("foreign shortcut");
  });

  it("does not trust unverified shortcut paths during uninstall", async () => {
    const base = await temporaryRoot("openbot-uninstall-shortcut-atomicity-");
    const installRoot = join(base, "install");
    const dataRoot = join(base, "data");
    const shortcutRoot = join(base, "shortcuts");
    const desktopShortcut = join(shortcutRoot, "Desktop", "OpenBot.lnk");
    const invalidStartShortcut = join(shortcutRoot, "Start Menu", "OpenBot.lnk");
    await mkdir(installRoot, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await mkdir(join(shortcutRoot, "Desktop"), { recursive: true });
    await mkdir(invalidStartShortcut, { recursive: true });
    await writeFile(desktopShortcut, "desktop shortcut");
    await writeFile(join(installRoot, "state.json"), JSON.stringify({
      schemaVersion: 1,
      product: "OpenBot",
      installRoot,
      activeVersion: "1.0.0",
      dataRoot,
      shortcutRoot,
    }));
    // @ts-expect-error executable local uninstall helper has no declaration file.
    const { uninstallRelease } = await import("../scripts/uninstall.mjs");

    await expect(uninstallRelease({
      installRoot,
      shortcutRoot,
      quiesceTimeoutMs: 50,
      deferredCleanupDelayMs: 0,
      captureProcessEvidence: async () => currentProcessEvidence,
      queryProcessEvidence: async () => null,
      isPortPresent: async () => false,
    })).resolves.toMatchObject({ ok: true });
    expect(existsSync(installRoot)).toBe(false);
    await expect(readFile(desktopShortcut, "utf8")).resolves.toBe("desktop shortcut");
    await expect(readdir(invalidStartShortcut)).resolves.toEqual([]);
  });

  it("restores the install and shortcuts when deferred uninstall cleanup cannot start", async () => {
    const base = await temporaryRoot("openbot-uninstall-deferred-rollback-");
    const installRoot = join(base, "install");
    const dataRoot = join(base, "data");
    const shortcutRoot = join(base, "shortcuts");
    const desktopShortcut = join(shortcutRoot, "Desktop", "OpenBot.lnk");
    const startMenuShortcut = join(shortcutRoot, "Start Menu", "OpenBot.lnk");
    await mkdir(installRoot, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await mkdir(join(shortcutRoot, "Desktop"), { recursive: true });
    await mkdir(join(shortcutRoot, "Start Menu"), { recursive: true });
    await writeFile(desktopShortcut, "desktop shortcut");
    await writeFile(startMenuShortcut, "start shortcut");
    await writeFile(join(installRoot, "state.json"), JSON.stringify({
      schemaVersion: 1,
      product: "OpenBot",
      installRoot,
      activeVersion: "1.0.0",
      dataRoot,
      shortcutRoot,
    }));
    const child = {
      spawned: false,
      exitCode: null,
      once(event: string, callback: (error?: Error) => void) {
        if (event === "error") callback(new Error("powershell missing"));
        return this;
      },
    };
    // @ts-expect-error executable local uninstall helper has no declaration file.
    const { uninstallRelease } = await import("../scripts/uninstall.mjs");

    await expect(uninstallRelease({
      installRoot,
      shortcutRoot,
      quiesceTimeoutMs: 50,
      deferredCleanupDelayMs: 0,
      captureProcessEvidence: async () => currentProcessEvidence,
      queryProcessEvidence: async () => null,
      isPortPresent: async () => false,
      spawn: () => child,
    })).rejects.toThrow(/deferred cleanup/i);
    await expect(readFile(join(installRoot, "state.json"), "utf8")).resolves.toContain('"activeVersion":"1.0.0"');
    await expect(readFile(desktopShortcut, "utf8")).resolves.toBe("desktop shortcut");
    await expect(readFile(startMenuShortcut, "utf8")).resolves.toBe("start shortcut");
  });

  it("does not trust a persisted custom shortcut root without an explicit match", async () => {
    const base = await temporaryRoot("openbot-uninstall-shortcut-root-boundary-");
    const installRoot = join(base, "install");
    const dataRoot = join(base, "data");
    const externalRoot = join(base, "external-shortcuts");
    const desktopShortcut = join(externalRoot, "Desktop", "OpenBot.lnk");
    const startMenuShortcut = join(externalRoot, "Start Menu", "OpenBot.lnk");
    await mkdir(installRoot, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await mkdir(join(externalRoot, "Desktop"), { recursive: true });
    await mkdir(join(externalRoot, "Start Menu"), { recursive: true });
    await writeFile(desktopShortcut, "foreign desktop shortcut");
    await writeFile(startMenuShortcut, "foreign start shortcut");
    await writeFile(join(installRoot, "state.json"), JSON.stringify({
      schemaVersion: 1,
      product: "OpenBot",
      installRoot,
      activeVersion: "1.0.0",
      dataRoot,
      shortcutRoot: externalRoot,
    }));
    // @ts-expect-error executable local uninstall helper has no declaration file.
    const { uninstallRelease } = await import("../scripts/uninstall.mjs");

    await expect(uninstallRelease({
      installRoot,
      quiesceTimeoutMs: 50,
      deferredCleanupDelayMs: 0,
      captureProcessEvidence: async () => currentProcessEvidence,
      queryProcessEvidence: async () => null,
    }))
      .rejects.toThrow(/shortcut root/i);

    await expect(readFile(desktopShortcut, "utf8")).resolves.toBe("foreign desktop shortcut");
    await expect(readFile(startMenuShortcut, "utf8")).resolves.toBe("foreign start shortcut");
  });

  it("runs uninstall synchronously from TEMP and propagates the real exit code", async () => {
    // @ts-expect-error executable local release helper has no declaration file.
    const { lifecycleWrapperContents } = await import("../scripts/release-common.mjs");
    const wrapper = lifecycleWrapperContents("uninstall");
    expect(wrapper).toContain('pushd "%TEMP%"');
    expect(wrapper).toContain('"%ComSpec%" /d /v:on /c call "%OPENBOT_WRAPPER_TEMP%\\lifecycle-wrapper.cmd"');
    expect(wrapper).toContain('set "OPENBOT_EXIT=!ERRORLEVEL!"');
    expect(wrapper).toContain('exit /b !OPENBOT_EXIT!');
    expect(wrapper).not.toMatch(/Start-Process|start "" \/b/iu);
    expect(wrapper).toMatch(/rmdir \/S \/Q "%OPENBOT_WRAPPER_TEMP%"[\s\S]{0,160}if exist "%OPENBOT_WRAPPER_TEMP%"[\s\S]{0,100}set "OPENBOT_EXIT=1"/u);
    expect(wrapper).toMatch(/pushd "%TEMP%"[\s\S]{0,100}\|\| goto :openbot_outer_fail/u);
    expect(wrapper).toMatch(/rmdir \/S \/Q "%OPENBOT_TEMP%"[\s\S]{0,260}rmdir \/S \/Q "%OPENBOT_WRAPPER_TEMP%"/u);
    const outerCleanup = wrapper.slice(wrapper.lastIndexOf(":openbot_outer_fail"));
    expect(outerCleanup).not.toMatch(/if exist "%OPENBOT_TEMP%"[\s\S]{0,80}exit \/b 1/u);
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

  it("routes missing-state wrapper exits through verified cleanup and keeps apostrophe paths out of PowerShell literals", async () => {
    if (process.platform !== "win32") return;
    // @ts-expect-error executable local release helper has no declaration file.
    const { lifecycleWrapperContents, maintenanceWrapperContents, recoveryWrapperContents } = await import("../scripts/release-common.mjs");
    const installRoot = await temporaryRoot("openbot-wrapper-missing-state-");
    const wrapperRoot = join(installRoot, "install root '");
    await mkdir(wrapperRoot, { recursive: true });
    const wrappers = [
      ["Repair-OpenBot.cmd", lifecycleWrapperContents("repair")],
      ["Uninstall-OpenBot.cmd", lifecycleWrapperContents("uninstall")],
      ["Update-OpenBot.cmd", maintenanceWrapperContents("update")],
      ["Recovery-OpenBot.cmd", recoveryWrapperContents()],
    ] as const;

    await Promise.all(wrappers.map(async ([name, wrapper]) => {
      const tempRoot = join(installRoot, `temp root ${name} '`);
      await mkdir(tempRoot, { recursive: true });
      expect(wrapper).not.toMatch(/LiteralPath '%OPENBOT_ROOT%/u);
      expect(wrapper).not.toMatch(/\$p=\\?['"]%OPENBOT_TEMP%/u);
      expect(wrapper).toContain("$env:OPENBOT_ROOT");
      const wrapperPath = join(wrapperRoot, name);
      await writeFile(wrapperPath, wrapper);
      let failure: any;
      try {
        await execFileAsync("cmd.exe", ["/d", "/c", wrapperPath], {
          cwd: wrapperRoot,
          env: { ...process.env, TEMP: tempRoot, TMP: tempRoot },
          windowsHide: true,
        });
      } catch (error) {
        failure = error;
      }
      expect.soft({ name, status: failure?.code ?? failure?.status }).toEqual({ name, status: 2 });
      expect.soft({ name, tempEntries: await readdir(tempRoot) }).toEqual({ name, tempEntries: [] });
    }));
  });

  it("cleans missing-state and repair-package early exits with apostrophe TEMP roots", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "openbot lifecycle missing '"));
    const tempRoot = join(root, "temp runtime '");
    try {
      await mkdir(tempRoot, { recursive: true });
      // @ts-expect-error executable local release helper has no declaration file.
      const { lifecycleWrapperContents } = await import("../scripts/release-common.mjs");
      const uninstall = join(root, "Uninstall-OpenBot.cmd");
      await writeFile(uninstall, lifecycleWrapperContents("uninstall"));
      let missingStateError: any;
      try {
        await execFileAsync("cmd.exe", ["/d", "/c", uninstall], { cwd: root, env: { ...process.env, TEMP: tempRoot, TMP: tempRoot }, windowsHide: true });
      } catch (error) {
        missingStateError = error;
      }
      expect(missingStateError?.code ?? missingStateError?.status).toBe(2);
      await expect(readdir(tempRoot)).resolves.toEqual([]);

      await mkdir(join(root, "versions", "1.0.0", "runtime"), { recursive: true });
      await mkdir(join(root, "versions", "1.0.0", "scripts"), { recursive: true });
      await writeFile(join(root, "state.json"), JSON.stringify({ activeVersion: "1.0.0" }));
      await writeFile(join(root, "versions", "1.0.0", "runtime", "node.exe"), "not-an-executable");
      await writeFile(join(root, "versions", "1.0.0", "scripts", "release-common.mjs"), "export {};\n");
      await writeFile(join(root, "versions", "1.0.0", "scripts", "install.mjs"), "export {};\n");
      const repair = join(root, "Repair-OpenBot.cmd");
      await writeFile(repair, lifecycleWrapperContents("repair"));
      let missingPackageError: any;
      try {
        await execFileAsync("cmd.exe", ["/d", "/c", repair], { cwd: root, env: { ...process.env, TEMP: tempRoot, TMP: tempRoot }, windowsHide: true });
      } catch (error) {
        missingPackageError = error;
      }
      expect(missingPackageError?.code ?? missingPackageError?.status).toBe(2);
      await expect(readdir(tempRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("does not report uninstall success when deferred cleanup cannot spawn", async () => {
    // @ts-expect-error executable uninstall helper has no declaration file.
    const { scheduleWindowsDeferredRemoval } = await import("../scripts/uninstall.mjs");
    const child = {
      once(event: string, callback: (error?: Error) => void) {
        if (event === "error") callback(new Error("powershell missing"));
        return this;
      },
      unref() { return this; },
    };
    await expect(scheduleWindowsDeferredRemoval("C:\\OpenBot.removing", {
      spawn: () => child,
      powershellPath: "missing-powershell.exe",
    })).rejects.toThrow("deferred uninstall cleanup could not be started");
  });

  it("proves deferred cleanup absence strictly instead of treating access errors as missing", async () => {
    // @ts-expect-error executable uninstall helper has no declaration file.
    const { assertRemovalTargetAbsent } = await import("../scripts/uninstall.mjs");
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(assertRemovalTargetAbsent("C:\\OpenBot.removing", {
      lstat: async () => { throw missing; },
    })).resolves.toBe(true);
    await expect(assertRemovalTargetAbsent("C:\\OpenBot.removing", {
      lstat: async () => { throw denied; },
    })).rejects.toThrow(/absence could not be verified.*EACCES/u);
    await expect(assertRemovalTargetAbsent("C:\\OpenBot.removing", {
      lstat: async () => ({ isDirectory: () => true }),
    })).rejects.toThrow(/left residue/u);
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

  it("refuses destructive purge without a matching OpenBot ownership marker", async () => {
    const base = await temporaryRoot("openbot-data-owner-");
    const installRoot = join(base, "install");
    const dataRoot = join(base, "foreign-data");
    await mkdir(installRoot, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "keep.txt"), "foreign");
    // @ts-expect-error executable local release helper has no declaration file.
    const { assertOwnedDataRoot, writeDataRootMarker } = await import("../scripts/release-common.mjs");

    await expect(assertOwnedDataRoot(installRoot, dataRoot)).rejects.toThrow(/ownership marker/);
    await writeDataRootMarker(installRoot, dataRoot);
    await expect(assertOwnedDataRoot(installRoot, dataRoot)).resolves.toBe(resolve(dataRoot));
    const otherInstall = join(base, "other-install");
    await mkdir(otherInstall, { recursive: true });
    await expect(writeDataRootMarker(otherInstall, dataRoot)).rejects.toThrow(/another OpenBot installation/);
  });

  it("requires valid install state instead of falling back to real profile roots", async () => {
    const base = await temporaryRoot("openbot-launch-state-");
    const releaseRoot = join(base, "install", "versions", "1.0.0");
    const installRoot = join(base, "install");
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(join(installRoot, "state.json"), "{broken");
    // @ts-expect-error executable local release helper has no declaration file.
    const { readLaunchInstallState } = await import("../scripts/launch.mjs");

    await expect(readLaunchInstallState(releaseRoot, installRoot)).rejects.toThrow();
    await rm(join(installRoot, "state.json"), { force: true });
    await expect(readLaunchInstallState(releaseRoot, installRoot)).rejects.toThrow(/state is missing/);
    await expect(readLaunchInstallState(releaseRoot, releaseRoot)).resolves.toBeNull();
  });

  it("rejects an active release version that escapes install versions", async () => {
    const base = await temporaryRoot("openbot-launch-version-boundary-");
    const installRoot = join(base, "install");
    const externalRelease = join(base, "outside");
    await mkdir(externalRelease, { recursive: true });
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, "state.json"), JSON.stringify({
      schemaVersion: 1,
      product: "OpenBot",
      installRoot,
      activeVersion: "..\\..\\outside",
    }));
    // @ts-expect-error executable local release helper has no declaration file.
    const { readLaunchInstallState } = await import("../scripts/launch.mjs");

    await expect(readLaunchInstallState(externalRelease, installRoot)).rejects.toThrow(/version|invalid|active/u);
  });

  it("refuses backup while any OpenBot gateway still owns the fixed port", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // @ts-expect-error executable local update helper has no declaration file.
    const { assertGatewayStopped } = await import("../scripts/update.mjs");
    try {
      await expect(assertGatewayStopped(`http://127.0.0.1:${port}`, 100)).rejects.toThrow(/still running/);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

});
