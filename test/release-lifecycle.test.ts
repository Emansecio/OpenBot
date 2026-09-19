import http from "node:http";
import net from "node:net";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { promisify } from "node:util";

// Every default shortcut lookup, including fixture subprocesses and generated
// wrappers, stays outside the real Desktop and Start Menu for this entire file.
const fallbackShortcutRoot = await mkdtemp(join(tmpdir(), "openbot-release-default-shortcuts-"));
const previousShortcutRoot = process.env.OPENBOT_SHORTCUT_ROOT;
process.env.OPENBOT_SHORTCUT_ROOT = fallbackShortcutRoot;
afterAll(async () => {
  if (previousShortcutRoot === undefined) delete process.env.OPENBOT_SHORTCUT_ROOT;
  else process.env.OPENBOT_SHORTCUT_ROOT = previousShortcutRoot;
  await rm(fallbackShortcutRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const repoRoot = join(import.meta.dirname, "..");
const isolatedGatewayUrl = `http://127.0.0.1:${40_000 + (process.pid % 20_000)}`;
const execFileAsync = promisify(execFileCallback);

async function run(script: string, args: string[] = [], cwd = repoRoot): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runFailure(script: string, args: string[] = [], cwd = repoRoot): Promise<string> {
  try {
    await execFileAsync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
  throw new Error(`Expected ${script} to fail`);
}

async function shortcutDetails(path: string): Promise<{ target: string; arguments: string; windowStyle: number; iconLocation: string; appId: string }> {
  const quoted = path.replaceAll("'", "''");
  const script = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${quoted}'); `
    + `$folder=(New-Object -ComObject Shell.Application).Namespace([IO.Path]::GetDirectoryName('${quoted}')); $item=$folder.ParseName([IO.Path]::GetFileName('${quoted}')); `
    + "[pscustomobject]@{target=$s.TargetPath;arguments=$s.Arguments;windowStyle=$s.WindowStyle;iconLocation=$s.IconLocation;appId=$item.ExtendedProperty('System.AppUserModel.ID')}|ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

async function createFixture(root: string, version: string): Promise<string> {
  const clientDist = join(root, "client", "extracted", "dist");
  const native = join(root, "node_modules", "better-sqlite3", "build", "Release");
  const electronDist = join(root, "node_modules", "electron", "dist");
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(clientDist, "electron-main"), { recursive: true });
  await mkdir(join(clientDist, "electron-preload"), { recursive: true });
  await mkdir(join(clientDist, "renderer", "assets"), { recursive: true });
  await mkdir(native, { recursive: true });
  await mkdir(electronDist, { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "native", "dpapi", "win32-x64"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openbot", version, type: "module" }));
  await writeFile(join(root, "client", "extracted", "package.json"), JSON.stringify({ name: "openbot-client", version: "0.16.0" }));
  await writeFile(join(root, "dist", "main.js"), "export default {};\n");
  await writeFile(join(clientDist, "electron-main", "main.cjs"), "module.exports = {};\n");
  await writeFile(join(clientDist, "electron-preload", "preload.cjs"), "module.exports = {};\n");
  await writeFile(join(clientDist, "renderer", "index.html"), "<!doctype html><title>OpenBot</title>\n");
  await writeFile(
    join(clientDist, "renderer", "assets", "openbot-local-settings.js"),
    'const about = ["Version 0.16.0", "Versão 0.1.0"];\n',
  );
  await writeFile(join(native, "better_sqlite3.node"), "fixture-native-runtime\n");
  await cp(join(repoRoot, "node_modules", "rcedit", "bin", "rcedit-x64.exe"), join(electronDist, "electron.exe"));
  await cp(join(repoRoot, "assets", "openbot.png"), join(root, "assets", "openbot.png"));
  await cp(join(repoRoot, "assets", "openbot.ico"), join(root, "assets", "openbot.ico"));
  await cp(join(repoRoot, "native", "dpapi", "win32-x64", "openbot-dpapi.node"), join(root, "native", "dpapi", "win32-x64", "openbot-dpapi.node"));
  for (const scriptName of ["launch.mjs", "shutdown-gateway.mjs", "release-common.mjs", "install.mjs", "update.mjs", "uninstall.mjs", "recovery-center.mjs", "openbot-browser-host.cjs", "openbot-electron.cjs", "execution-diagnostics.mjs", "shortcut-appid.mjs"]) {
    await cp(join(repoRoot, "scripts", scriptName), join(root, "scripts", scriptName));
  }
  return root;
}

async function packageFixture(sourceRoot: string, outputRoot: string, version: string, options: { failPublicationAt?: string } = {}): Promise<any> {
  const { buildRelease } = await import("../scripts/release.mjs");
  return buildRelease({
    sourceRoot,
    outputRoot,
    version,
    platform: "win32",
    arch: "x64",
    nodeExecutable: process.execPath,
    electronDist: join(sourceRoot, "node_modules", "electron", "dist"),
    distRoot: join(sourceRoot, "dist"),
    clientDist: join(sourceRoot, "client", "extracted", "dist"),
    nodeModules: join(sourceRoot, "node_modules"),
    skipZip: true,
    failPublicationAt: options.failPublicationAt,
  });
}

async function isolateMaintenancePort(installRoot: string): Promise<void> {
  await writeFile(join(installRoot, "process.json"), JSON.stringify({ gateway: { url: isolatedGatewayUrl } }));
}

function installedReleaseRoot(installRoot: string, slot: "active" | "previous" = "active"): string {
  const state = JSON.parse(readFileSync(join(installRoot, "state.json"), "utf8"));
  const releaseId = state[`${slot}ReleaseId`] ?? state[`${slot}Version`];
  return join(installRoot, "versions", releaseId);
}

async function portIsListening(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (present: boolean) => {
      socket.destroy();
      resolvePort(present);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function captureReleaseInventory(root: string, installRoot: string, ports: number[]) {
  const processStatePath = join(installRoot, "process.json");
  const processes: Array<{ name: string; pid: number; alive: boolean }> = [];
  try {
    const state = JSON.parse(await readFile(processStatePath, "utf8"));
    for (const [name, value] of Object.entries(state.processes ?? {})) {
      const pid = Number((value as { pid?: number }).pid);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          processes.push({ name, pid, alive: true });
        } catch {
          processes.push({ name, pid, alive: false });
        }
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  });
  const residualRoots = entries
    .filter((entry) => entry.name === "logs"
      || entry.name.includes(".staging")
      || entry.name.includes(".removing-")
      || entry.name.endsWith(".openbot-operation.lock"))
    .map((entry) => join(root, entry.name));
  if (existsSync(installRoot)) residualRoots.push(installRoot);
  const locks = residualRoots.filter((path) => path.endsWith(".openbot-operation.lock"));
  const logs = residualRoots.filter((path) => path.endsWith("logs") || path.includes("logs\\"));
  const listeningPorts = [];
  for (const port of ports) {
    if (await portIsListening(port)) listeningPorts.push(port);
  }
  return { processes, ports: listeningPorts, locks, logs, residualRoots };
}

async function stopFixtureChild(child: ReturnType<typeof spawn> | null): Promise<void> {
  if (child == null || child.exitCode != null) return;
  await new Promise<void>((resolveExit) => {
    let settled = false;
    const timer = setTimeout(() => finish(), 5_000);
    timer.unref?.();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit();
    };
    child.once("exit", finish);
    child.once("error", finish);
    child.kill();
  });
}

function lifecycleTestChild(pid: number) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child = {
    pid,
    exitCode: null as number | null,
    signalCode: null as string | null,
    spawnError: null as Error | null,
    once(event: string, callback: (...args: unknown[]) => void) {
      const callbacks = listeners.get(event) ?? [];
      callbacks.push(callback);
      listeners.set(event, callbacks);
      return child;
    },
    emit(event: string, ...args: unknown[]) {
      const callbacks = listeners.get(event) ?? [];
      listeners.delete(event);
      for (const callback of callbacks) callback(...args);
      return callbacks.length > 0;
    },
    kill() {
      child.exitCode ??= 1;
      child.emit("exit", child.exitCode, null);
      return true;
    },
  };
  return child;
}

describe.concurrent("Windows local release lifecycle", () => {
  it("keeps the launcher stable while the shortcut icon tracks the immutable release", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-shortcut-repair-"));
    const shortcutRoot = join(root, "shortcuts");
    try {
      // @ts-expect-error executable local release helpers have no declaration files.
      const { writeReleaseShortcuts } = await import("../scripts/install.mjs");
      const shortcuts = {
        desktop: join(shortcutRoot, "Desktop", "OpenBot.lnk"),
        startMenu: join(shortcutRoot, "Start Menu", "OpenBot.lnk"),
      };
      await writeReleaseShortcuts(root, shortcuts, { env: process.env, releaseId: "0.1.1-build-a" });
      const desktop = await shortcutDetails(shortcuts.desktop);
      expect(resolve(desktop.target)).toBe(resolve(join(root, "OpenBot.vbs")));
      expect(desktop.arguments).toBe("");
      expect(desktop.appId).toBe("OpenBot.Desktop");
      expect(resolve(desktop.iconLocation.split(",")[0]!)).toBe(resolve(join(root, "versions", "0.1.1-build-a", "assets", "openbot.ico")));
      expect(desktop.arguments).not.toContain(join(root, "versions"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never acquires skipped shortcuts and preserves foreign links through maintenance and uninstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-shortcut-ownership-"));
    try {
      // @ts-expect-error Native release helpers have no declarations.
      const { installRelease, repairRelease } = await import("../scripts/install.mjs");
      // @ts-expect-error Native release helpers have no declarations.
      const { updateRelease, rollbackRelease } = await import("../scripts/update.mjs");
      // @ts-expect-error Native release helpers have no declarations.
      const { uninstallRelease } = await import("../scripts/uninstall.mjs");
      // @ts-expect-error Native release helpers have no declarations.
      const { createShortcut, shortcutPaths } = await import("../scripts/release-common.mjs");
      const source = await createFixture(join(root, "source"), "1.0.0");
      const first = await packageFixture(source, join(root, "release-v1"), "1.0.0");
      await createFixture(source, "2.0.0");
      const second = await packageFixture(source, join(root, "release-v2"), "2.0.0");
      const installRoot = join(root, "install");
      const shortcutRoot = join(root, "shortcuts");
      const paths = shortcutPaths(shortcutRoot);
      const foreignRoot = join(root, "other install");
      await mkdir(foreignRoot);
      await writeFile(join(foreignRoot, "OpenBot.vbs"), "WScript.Quit 0\r\n");
      for (const path of Object.values(paths)) await createShortcut(join(foreignRoot, "OpenBot.vbs"), path, { allowFallback: false });
      const foreignDesktop = await readFile(paths.desktop);
      const foreignMenu = await readFile(paths.startMenu);
      const options = { installRoot, shortcutRoot, dataRoot: join(root, "data"), localDataRoot: join(root, "local"), gatewayUrl: isolatedGatewayUrl };
      await installRelease({ ...options, packagePath: first.root, skipShortcuts: true });
      expect(JSON.parse(await readFile(join(installRoot, "state.json"), "utf8")).shortcuts).toEqual({});
      const skippedLegacy = JSON.parse(await readFile(join(installRoot, "state.json"), "utf8"));
      delete skippedLegacy.shortcutOwnershipVersion;
      skippedLegacy.shortcuts = paths;
      await writeFile(join(installRoot, "state.json"), JSON.stringify(skippedLegacy));
      await repairRelease({ ...options, packagePath: first.root });
      await updateRelease({ ...options, packagePath: second.root });
      await rollbackRelease(options);
      expect(JSON.parse(await readFile(join(installRoot, "state.json"), "utf8")).shortcuts).toEqual({});
      await expect(readFile(paths.desktop)).resolves.toEqual(foreignDesktop);
      await expect(readFile(paths.startMenu)).resolves.toEqual(foreignMenu);
      // Simulate old versions which incorrectly claimed default links despite
      // --skip-shortcuts. Uninstall must independently verify each actual link.
      const legacy = JSON.parse(await readFile(join(installRoot, "state.json"), "utf8"));
      delete legacy.shortcutOwnershipVersion;
      legacy.shortcuts = paths;
      await writeFile(join(installRoot, "state.json"), JSON.stringify(legacy));
      await uninstallRelease(options);
      await expect(readFile(paths.desktop)).resolves.toEqual(foreignDesktop);
      await expect(readFile(paths.startMenu)).resolves.toEqual(foreignMenu);

      // Newly created links are owned, but ownership does not survive another
      // install reassigning one of those same paths to its own launcher.
      await installRelease({ ...options, packagePath: first.root });
      await createShortcut(join(foreignRoot, "OpenBot.vbs"), paths.desktop, { allowFallback: false });
      const reassigned = await readFile(paths.desktop);
      await uninstallRelease(options);
      await expect(readFile(paths.desktop)).resolves.toEqual(reassigned);
      await expect(stat(paths.startMenu)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 120_000);

  it("keeps only production dependency roots when a lockfile is available", async () => {
    const { productionPackagePaths } = await import("../scripts/release.mjs");
    expect(productionPackagePaths({ packages: {
      "": {},
      "node_modules/runtime": {},
      "node_modules/dev-only": { dev: true },
      "node_modules/optional-runtime": { optional: true },
    } })).toEqual(["runtime", "optional-runtime"]);
  });
  it("quiesces a managed repair before replacing a release, while allowing an unrelated first install", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-managed-repair-quiesce-"));
    const source = join(root, "source");
    const release = join(root, "release");
    const firstInstall = join(root, "first-install");
    const managedInstall = join(root, "managed-install");
    const firstData = join(root, "first-data");
    const firstLocal = join(root, "first-local");
    const managedData = join(root, "managed-data");
    const managedLocal = join(root, "managed-local");
    const server = http.createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const gatewayUrl = `http://127.0.0.1:${port}`;
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, release, "1.0.0");
      // @ts-expect-error local release script is executable JavaScript without declarations.
      const { installRelease, repairRelease } = await import("../scripts/install.mjs");
      await expect(installRelease({
        packagePath: packaged.root,
        installRoot: firstInstall,
        dataRoot: firstData,
        localDataRoot: firstLocal,
        gatewayUrl,
        skipShortcuts: true,
      })).resolves.toMatchObject({ ok: true });
      await expect(installRelease({
        packagePath: packaged.root,
        installRoot: managedInstall,
        dataRoot: managedData,
        localDataRoot: managedLocal,
        gatewayUrl,
        skipShortcuts: true,
      })).resolves.toMatchObject({ ok: true });
      const before = await readFile(join(managedInstall, "state.json"), "utf8");
      await expect(repairRelease({
        packagePath: packaged.root,
        installRoot: managedInstall,
        dataRoot: managedData,
        localDataRoot: managedLocal,
        gatewayUrl,
        skipShortcuts: true,
      })).rejects.toThrow(/active|port|gateway/i);
      await expect(readFile(join(managedInstall, "state.json"), "utf8")).resolves.toBe(before);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the update path before replacing a managed install", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-managed-new-target-quiesce-"));
    const source = join(root, "source");
    const releaseV1 = join(root, "release-v1");
    const releaseV2 = join(root, "release-v2");
    const installRoot = join(root, "install");
    const dataRoot = join(root, "data");
    const localRoot = join(root, "local");
    const customUrl = "http://127.0.0.1:19437";
    try {
      await createFixture(source, "1.0.0");
      const v1 = await packageFixture(source, releaseV1, "1.0.0");
      expect(v1.manifest).toMatchObject({
        productVersion: "1.0.0",
        releaseId: `1.0.0-${v1.manifest.buildId.slice(0, 16)}`,
      });
      expect(v1.manifest.buildId).toMatch(/^[a-f0-9]{64}$/);
      expect(v1.manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      await expect(readFile(join(v1.root, "app", "client", "extracted", "dist", "renderer", "assets", "openbot-local-settings.js"), "utf8"))
        .resolves.toContain(`Versão 1.0.0 · build ${v1.manifest.buildId.slice(0, 16)}`);
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "openbot", version: "2.0.0", type: "module" }));
      const v2 = await packageFixture(source, releaseV2, "2.0.0");
      // @ts-expect-error executable local release helper has no declaration file.
      const { installRelease } = await import("../scripts/install.mjs");
      // @ts-expect-error executable local helper has no declaration file.
      const { installLayout } = await import("../scripts/release-common.mjs");
      await installRelease({ packagePath: v1.root, installRoot, dataRoot, localDataRoot: localRoot, skipShortcuts: true });
      const beforeState = await readFile(join(installRoot, "state.json"), "utf8");
      await writeFile(installLayout(installRoot).processState, JSON.stringify({
        gateway: { url: customUrl },
        processes: {
          gateway: {
            pid: 999_991,
            creationTime: "managed-gateway",
            executablePath: process.execPath,
            expectedRoot: installRoot,
          },
        },
      }));
      await expect(installRelease({
        packagePath: v2.root,
        installRoot,
        dataRoot,
        localDataRoot: localRoot,
        skipShortcuts: true,
        isPortPresent: async (url: string) => url === customUrl,
        queryProcessEvidence: async () => null,
      })).rejects.toThrow(/use update|backed up/i);
      await expect(readFile(join(installRoot, "state.json"), "utf8")).resolves.toBe(beforeState);
      await expect(readFile(join(installRoot, "versions", v2.manifest.releaseId, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never silently replaces a managed install through the install command", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-managed-url-install-"));
    const source = join(root, "source");
    const releaseV1 = join(root, "release-v1");
    const releaseV2 = join(root, "release-v2");
    const installRoot = join(root, "install");
    const dataRoot = join(root, "data");
    const localRoot = join(root, "local");
    const customUrl = "http://127.0.0.1:19438";
    const assertedUrls: string[] = [];
    try {
      await createFixture(source, "1.0.0");
      const v1 = await packageFixture(source, releaseV1, "1.0.0");
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "openbot", version: "2.0.0", type: "module" }));
      const v2 = await packageFixture(source, releaseV2, "2.0.0");
      // @ts-expect-error executable local release helper has no declaration file.
      const { installRelease } = await import("../scripts/install.mjs");
      // @ts-expect-error executable local helper has no declaration file.
      const { installLayout } = await import("../scripts/release-common.mjs");
      await installRelease({ packagePath: v1.root, installRoot, dataRoot, localDataRoot: localRoot, skipShortcuts: true });
      await writeFile(installLayout(installRoot).processState, JSON.stringify({
        gateway: { url: customUrl },
        processes: { gateway: { pid: 999_992, creationTime: "managed-gateway", executablePath: process.execPath, expectedRoot: installRoot } },
      }));
      await expect(installRelease({
        packagePath: v2.root,
        installRoot,
        dataRoot,
        localDataRoot: localRoot,
        skipShortcuts: true,
        isPortPresent: async () => false,
        queryProcessEvidence: async () => null,
        assertGatewayStopped: async (url: string) => { assertedUrls.push(url); },
      })).rejects.toThrow(/use update|backed up/i);
      expect(assertedUrls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the process-state gateway URL for update and rollback shutdown verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-managed-url-update-"));
    const source = join(root, "source");
    const releaseV1 = join(root, "release-v1");
    const releaseV2 = join(root, "release-v2");
    const installRoot = join(root, "install");
    const dataRoot = join(root, "data");
    const localRoot = join(root, "local");
    const customUrl = "http://127.0.0.1:19439";
    const assertedUrls: string[] = [];
    try {
      await createFixture(source, "1.0.0");
      const v1 = await packageFixture(source, releaseV1, "1.0.0");
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "openbot", version: "2.0.0", type: "module" }));
      const v2 = await packageFixture(source, releaseV2, "2.0.0");
      // @ts-expect-error executable local release helper has no declaration file.
      const { installRelease } = await import("../scripts/install.mjs");
      // @ts-expect-error executable local maintenance helper has no declaration file.
      const { updateRelease, rollbackRelease } = await import("../scripts/update.mjs");
      // @ts-expect-error executable local helper has no declaration file.
      const { installLayout } = await import("../scripts/release-common.mjs");
      await installRelease({ packagePath: v1.root, installRoot, dataRoot, localDataRoot: localRoot, skipShortcuts: true });
      await writeFile(installLayout(installRoot).processState, JSON.stringify({
        gateway: { url: customUrl },
        processes: { gateway: { pid: 999_993, creationTime: "managed-gateway", executablePath: process.execPath, expectedRoot: installRoot } },
      }));
      await expect(updateRelease({
        packagePath: v2.root,
        installRoot,
        backupRoot: join(root, "backups"),
        assertGatewayStopped: async (url: string) => { assertedUrls.push(url); },
      })).resolves.toMatchObject({ ok: true, version: "2.0.0" });
      expect(assertedUrls).toEqual([customUrl]);
      const statePath = join(installRoot, "state.json");
      const validState = JSON.parse(await readFile(statePath, "utf8"));
      const escapedVersion = relative(join(installRoot, "versions"), v1.root);
      await writeFile(statePath, JSON.stringify({
        ...validState,
        previousVersion: escapedVersion,
        lastBackup: { ...validState.lastBackup, fromVersion: escapedVersion },
      }));
      let escapedRollbackReachedQuiesce = false;
      await expect(rollbackRelease({
        installRoot,
        assertGatewayStopped: async () => { escapedRollbackReachedQuiesce = true; },
      })).rejects.toThrow(/Invalid release version/u);
      expect(escapedRollbackReachedQuiesce).toBe(false);
      await writeFile(statePath, JSON.stringify(validState));
      await writeFile(installLayout(installRoot).processState, JSON.stringify({
        gateway: { url: customUrl },
        processes: { gateway: { pid: 999_994, creationTime: "managed-gateway", executablePath: process.execPath, expectedRoot: installRoot } },
      }));
      await expect(rollbackRelease({
        installRoot,
        assertGatewayStopped: async (url: string) => { assertedUrls.push(url); },
      })).resolves.toMatchObject({ ok: true, version: "1.0.0" });
      expect(assertedUrls).toEqual([customUrl, customUrl]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the startup marker when readiness fails and a spawned gateway refuses teardown", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-launch-stubborn-"));
    const source = join(root, "source");
    const release = join(root, "release");
    const installRoot = join(root, "install");
    const dataRoot = join(root, "data");
    const localRoot = join(root, "local");
    const child = (pid: number) => ({
      pid,
      exitCode: null as number | null,
      signalCode: null as string | null,
      spawnError: null,
      kill() { return true; },
      once() { return this; },
    });
    let shutdownCalls = 0;
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, release, "1.0.0");
      // @ts-expect-error executable local release helpers have no declaration files.
      const { installRelease } = await import("../scripts/install.mjs");
      await installRelease({ packagePath: packaged.root, installRoot, dataRoot, localDataRoot: localRoot, skipShortcuts: true });
      const activeRoot = installedReleaseRoot(installRoot);
      // @ts-expect-error executable local launch helper has no declaration file.
      const { launchRelease } = await import("../scripts/launch.mjs");
      const gateway = child(61_001);
      const evidence = async (pid: number, options: { expectedExecutable?: string; expectedRoot?: string } = {}) => ({
        pid,
        creationTime: "launch-test",
        executablePath: options.expectedExecutable ?? process.execPath,
        expectedRoot: options.expectedRoot ?? activeRoot,
        commandLine: `${options.expectedExecutable ?? process.execPath} ${join(activeRoot, "app", "dist", "main.js")}`,
      });
      await expect(launchRelease({
        root: activeRoot,
        installRoot,
        dataRoot,
        localDataRoot: localRoot,
        spawnGateway: () => gateway,
        captureProcessEvidence: evidence,
        waitForGateway: async () => { throw new Error("readiness failed"); },
        childTimeoutMs: 5,
        shutdownGateway: async () => {
          shutdownCalls += 1;
          return { teardownProven: false };
        },
      })).rejects.toThrow(/teardown|readiness|cleanup/i);
      expect(shutdownCalls).toBe(1);
      expect(existsSync(join(installRoot, "process.json"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { event: "exit" as const, label: "saída", electronPid: 62_101 },
    { event: "error" as const, label: "erro", electronPid: 62_102 },
  ])("observa $label do Electron durante o bookkeeping e limpa o gateway próprio", async ({ event, electronPid }) => {
    const root = await mkdtemp(join(tmpdir(), `openbot-launch-early-${event}-`));
    const source = join(root, "source");
    const release = join(root, "release");
    const installRoot = join(root, "install");
    const dataRoot = join(root, "data");
    const localRoot = join(root, "local");
    const gateway = lifecycleTestChild(62_100);
    const electron = lifecycleTestChild(electronPid);
    let gatewayTeardownCalls = 0;
    let electronTeardownCalls = 0;
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, release, "1.0.0");
      // @ts-expect-error executable local release helper has no declaration file.
      const { installRelease } = await import("../scripts/install.mjs");
      await installRelease({ packagePath: packaged.root, installRoot, dataRoot, localDataRoot: localRoot, skipShortcuts: true });
      const activeRoot = installedReleaseRoot(installRoot);
      // @ts-expect-error executable local launch helper has no declaration file.
      const { launchRelease } = await import("../scripts/launch.mjs");
      const evidence = async (pid: number, options: { expectedExecutable?: string; expectedRoot?: string } = {}) => {
        const result = {
          pid,
          creationTime: "launch-test",
          executablePath: options.expectedExecutable ?? process.execPath,
          expectedRoot: options.expectedRoot ?? activeRoot,
          commandLine: `${options.expectedExecutable ?? process.execPath} ${join(activeRoot, "app", "dist", "main.js")}`,
        };
        if (pid === electron.pid) {
          // The real child can finish while process evidence and the state
          // marker are still being recorded. Keep the event ahead of the
          // capture promise's resolution so the old late-listener ordering
          // would wait forever.
          queueMicrotask(() => {
            if (event === "exit") {
              electron.exitCode = 0;
              electron.emit("exit", 0, null);
            } else {
              electron.emit("error", new Error("electron launch failed"));
            }
          });
          await new Promise<void>((resolveCapture) => setImmediate(resolveCapture));
        }
        return result;
      };
      const launch = launchRelease({
        root: activeRoot,
        installRoot,
        dataRoot,
        localDataRoot: localRoot,
        spawnGateway: () => gateway,
        spawnElectron: () => electron,
        captureProcessEvidence: evidence,
        waitForGateway: async () => ({ ok: true, pid: gateway.pid }),
        terminateOwnedProcess: async () => {
          electronTeardownCalls += 1;
          return { teardownProven: true };
        },
        shutdownGateway: async () => {
          gatewayTeardownCalls += 1;
          return { teardownProven: true };
        },
      });
      if (event === "exit") {
        await expect(launch).resolves.toMatchObject({ ok: true, exitCode: 0 });
        expect(electronTeardownCalls).toBe(0);
      } else {
        await expect(launch).rejects.toThrow("electron launch failed");
        expect(electronTeardownCalls).toBe(1);
      }
      expect(gatewayTeardownCalls).toBe(1);
      await expect(readFile(join(installRoot, "process.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("attempts gateway cleanup even when Electron teardown fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-launch-cleanup-"));
    const source = join(root, "source");
    const release = join(root, "release");
    const installRoot = join(root, "install");
    const dataRoot = join(root, "data");
    const localRoot = join(root, "local");
    const child = (pid: number) => ({
      pid,
      exitCode: null as number | null,
      signalCode: null as string | null,
      spawnError: null,
      kill() { this.exitCode = 1; return true; },
      once(event: string, callback: (code?: number, signal?: string) => void) {
        if (event === "exit") callback(0);
        return this;
      },
    });
    let electronTeardownCalls = 0;
    let gatewayTeardownCalls = 0;
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, release, "1.0.0");
      // @ts-expect-error executable local release helper has no declaration file.
      const { installRelease } = await import("../scripts/install.mjs");
      await installRelease({ packagePath: packaged.root, installRoot, dataRoot, localDataRoot: localRoot, skipShortcuts: true });
      const activeRoot = installedReleaseRoot(installRoot);
      // @ts-expect-error executable local launch helper has no declaration file.
      const { launchRelease } = await import("../scripts/launch.mjs");
      const evidence = async (pid: number, options: { expectedExecutable?: string; expectedRoot?: string } = {}) => ({
        pid,
        creationTime: "launch-test",
        executablePath: options.expectedExecutable ?? process.execPath,
        expectedRoot: options.expectedRoot ?? activeRoot,
        commandLine: `${options.expectedExecutable ?? process.execPath} ${join(activeRoot, "app", "dist", "main.js")}`,
      });
      await expect(launchRelease({
        root: activeRoot,
        installRoot,
        dataRoot,
        localDataRoot: localRoot,
        spawnGateway: () => child(62_001),
        spawnElectron: () => child(62_002),
        captureProcessEvidence: evidence,
        waitForGateway: async () => ({ ok: true, pid: 62_001 }),
        terminateOwnedProcess: async () => {
          electronTeardownCalls += 1;
          throw new Error("electron teardown failed");
        },
        shutdownGateway: async () => {
          gatewayTeardownCalls += 1;
          return { teardownProven: true };
        },
      })).rejects.toThrow(/electron teardown failed|cleanup/i);
      expect(electronTeardownCalls).toBe(1);
      expect(gatewayTeardownCalls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes launch, update, rollback, and uninstall teardown through the authenticated gateway helper", async () => {
    const launch = await readFile(join(repoRoot, "scripts", "launch.mjs"), "utf8");
    const common = await readFile(join(repoRoot, "scripts", "release-common.mjs"), "utf8");
    const update = await readFile(join(repoRoot, "scripts", "update.mjs"), "utf8");
    const uninstall = await readFile(join(repoRoot, "scripts", "uninstall.mjs"), "utf8");
    expect(launch).toContain('shutdown-gateway.mjs');
    expect(common).toContain('shutdown-gateway.mjs');
    expect(update).toContain('quiesceInstall(root');
    expect(uninstall).toContain('quiesceInstall(root');
  });

  it("captures independent launch ownership evidence concurrently", async () => {
    const launch = await readFile(join(repoRoot, "scripts", "launch.mjs"), "utf8");
    expect(launch).toContain("const [gatewayEvidence, launcherEvidence] = await Promise.all([");
    expect(launch).toContain("const [launcherEvidence, gatewayEvidence, electronEvidence] = await Promise.all([");
  });

  it("packages the launch module dependency used by the installed shortcut", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-release-launch-dependency-"));
    try {
      const source = await createFixture(join(root, "source"), "1.0.0");
      const packaged = await packageFixture(source, join(root, "release"), "1.0.0");
      // @ts-expect-error executable local release helper has no declaration file.
      const { preflightRelease, releaseRequiredFiles, treeDigest } = await import("../scripts/release-common.mjs");

      expect(packaged.manifest.requiredFiles).toContain("scripts/shutdown-gateway.mjs");
      expect(packaged.manifest.requiredFiles).toContain("app/scripts/execution-diagnostics.mjs");
      expect(await readFile(join(packaged.root, "app", "scripts", "execution-diagnostics.mjs"), "utf8"))
        .toBe(await readFile(join(repoRoot, "scripts", "execution-diagnostics.mjs"), "utf8"));
      expect(releaseRequiredFiles()).toContain("scripts/shutdown-gateway.mjs");
      await expect(readFile(join(packaged.root, "scripts", "shutdown-gateway.mjs"), "utf8"))
        .resolves.toContain("shutdownGateway");

      await rm(join(packaged.root, "scripts", "shutdown-gateway.mjs"), { force: true });
      const manifestPath = join(packaged.root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.contentSha256 = await treeDigest(packaged.root, { exclude: ["manifest.json"] });
      manifest.sha256 = manifest.contentSha256;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const preflight = await preflightRelease(packaged.root);
      expect(preflight.ok).toBe(false);
      expect(preflight.missing).toContain("scripts/shutdown-gateway.mjs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recreates a missing shortcut when the same release is installed again", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-release-shortcut-reconcile-"));
    const source = join(root, "source");
    const installRoot = join(root, "install");
    const shortcutRoot = join(root, "shortcuts");
    const dataRoot = join(root, "data");
    const localDataRoot = join(root, "local");
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, join(root, "release"), "1.0.0");
      const args = [
        "--package", packaged.root,
        "--root", installRoot,
        "--shortcut-root", shortcutRoot,
        "--data-root", dataRoot,
        "--local-data-root", localDataRoot,
      ];
      await run("scripts/install.mjs", args);
      const desktopShortcut = join(shortcutRoot, "Desktop", "OpenBot.lnk");
      await rm(desktopShortcut, { force: true });

      expect(await run("scripts/install.mjs", args)).toMatchObject({ ok: true, alreadyInstalled: true });
      expect((await shortcutDetails(desktopShortcut)).target).toContain("OpenBot.vbs");

      await writeFile(desktopShortcut, "not a Windows shortcut");
      expect(await run("scripts/install.mjs", args)).toMatchObject({ ok: true, alreadyInstalled: true });
      // A path recorded in state is not permission to overwrite an unrelated
      // file which has replaced the originally created shortcut.
      await expect(readFile(desktopShortcut, "utf8")).resolves.toBe("not a Windows shortcut");

      const startMenuShortcut = join(shortcutRoot, "Start Menu", "OpenBot.lnk");
      await writeFile(desktopShortcut, "preserve original desktop shortcut");
      await rm(startMenuShortcut, { force: true });
      await mkdir(startMenuShortcut);
      expect(await run("scripts/install.mjs", args)).toMatchObject({ ok: true, alreadyInstalled: true });
      expect((await stat(startMenuShortcut)).isDirectory()).toBe(true);
      await expect(readFile(desktopShortcut, "utf8")).resolves.toBe("preserve original desktop shortcut");
      expect(await run("scripts/install.mjs", [...args, "--skip-shortcuts"])).toMatchObject({ ok: true, alreadyInstalled: true });
      await expect(readFile(desktopShortcut, "utf8")).resolves.toBe("preserve original desktop shortcut");

      const differentShortcutRoot = join(root, "different-shortcuts");
      expect(await runFailure("scripts/install.mjs", [
        "--package", packaged.root,
        "--root", installRoot,
        "--shortcut-root", differentShortcutRoot,
        "--data-root", dataRoot,
        "--local-data-root", localDataRoot,
      ])).toMatch(/shortcut root/i);
      expect(existsSync(join(differentShortcutRoot, "Desktop", "OpenBot.lnk"))).toBe(false);
      expect(JSON.parse(await readFile(join(installRoot, "state.json"), "utf8")).shortcutRoot).toBe(resolve(shortcutRoot));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("rejeita distRoot custom stale quando sourceRoot/src existe", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-release-custom-dist-stale-"));
    const source = join(root, "source");
    const customDist = join(root, "custom-dist");
    try {
      await mkdir(join(source, "src"), { recursive: true });
      await mkdir(customDist, { recursive: true });
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "openbot", version: "1.0.0" }));
      await writeFile(join(source, "src", "main.ts"), "export {};\n");
      await writeFile(join(customDist, "main.js"), "export {};\n");
      await utimes(join(source, "src", "main.ts"), new Date(), new Date());
      await utimes(join(customDist, "main.js"), new Date(1_000), new Date(1_000));
      const { buildRelease } = await import("../scripts/release.mjs");
      await expect(buildRelease({
        sourceRoot: source,
        distRoot: customDist,
        outputRoot: join(root, "release"),
        platform: "win32",
        arch: "x64",
        skipZip: true,
      })).rejects.toThrow("Backend artifacts are invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the default source root from the release script itself", async () => {
    const { stdout: resolvedRootOutput } = await execFileAsync(process.execPath, ["scripts/release.mjs", "--print-source-root"], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    const resolvedRoot = resolvedRootOutput.trim();
    expect(resolve(resolvedRoot)).toBe(resolve(repoRoot));
    const { stdout: help } = await execFileAsync(process.execPath, ["scripts/release.mjs", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(help).toContain("--source-root");
  });

  it("RED: preflight não pode aceitar addon PE x64 declarado como arm64", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-dpapi-arch-red-"));
    const source = join(root, "source");
    const output = join(root, "release");
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, output, "1.0.0");
      const manifestPath = join(packaged.root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const x64Addon = join(repoRoot, "native", "dpapi", "win32-x64", "openbot-dpapi.node");
      const arm64Relative = "app/native/dpapi/win32-arm64/openbot-dpapi.node";
      await mkdir(join(packaged.root, "app/native/dpapi/win32-arm64"), { recursive: true });
      await cp(x64Addon, join(packaged.root, arm64Relative));
      manifest.arch = "arm64";
      manifest.runtime.dpapi = arm64Relative;
      manifest.requiredFiles = manifest.requiredFiles.map((file: string) => file === "app/native/dpapi/win32-x64/openbot-dpapi.node" ? arm64Relative : file);
      // @ts-expect-error local release script is executable JavaScript without declarations.
      const { treeDigest, preflightRelease } = await import("../scripts/release-common.mjs");
      manifest.contentSha256 = await treeDigest(packaged.root, { exclude: ["manifest.json"] });
      manifest.sha256 = manifest.contentSha256;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await preflightRelease(packaged.root);
      expect(result.ok).toBe(false);
      expect(result.missing.join("\n")).toMatch(/architecture|machine|arm64/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("RED: buildRelease deve rejeitar arm64 enquanto só x64 tem addon produzido", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-dpapi-build-arch-red-"));
    const source = join(root, "source");
    try {
      await createFixture(source, "1.0.0");
      const { buildRelease } = await import("../scripts/release.mjs");
      await expect(buildRelease({ sourceRoot: source, outputRoot: join(root, "release"), platform: "win32", arch: "arm64", nodeExecutable: process.execPath, electronDist: join(source, "node_modules", "electron", "dist"), distRoot: join(source, "dist"), clientDist: join(source, "client", "extracted", "dist"), nodeModules: join(source, "node_modules"), skipZip: true })).rejects.toThrow(/unsupported|x64|architecture/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["arm64", "ia32"])("RED: preflight não pode aceitar manifest %s sem runtime.dpapi", async (arch) => {
    const root = await mkdtemp(join(tmpdir(), `openbot-release-${arch}-manifest-red-`));
    const source = join(root, "source");
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, join(root, "release"), "1.0.0");
      const manifestPath = join(packaged.root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.arch = arch;
      delete manifest.runtime.dpapi;
      // @ts-expect-error local release script is executable JavaScript without declarations.
      const { treeDigest, preflightRelease } = await import("../scripts/release-common.mjs");
      manifest.contentSha256 = await treeDigest(packaged.root, { exclude: ["manifest.json"] });
      manifest.sha256 = manifest.contentSha256;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await preflightRelease(packaged.root);
      expect(result.ok).toBe(false);
      expect(result.missing.join("\n")).toMatch(/unsupported|architecture|x64/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("RED: preflight não pode seguir runtime.dpapi para fora da raiz", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-release-dpapi-traversal-red-"));
    const source = join(root, "source");
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, join(root, "release"), "1.0.0");
      const outsideAddon = join(packaged.root, "..", "outside.node");
      await cp(join(repoRoot, "native", "dpapi", "win32-x64", "openbot-dpapi.node"), outsideAddon);
      const manifestPath = join(packaged.root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.runtime.dpapi = "../outside.node";
      manifest.requiredFiles.push("../outside.node");
      // @ts-expect-error local release script is executable JavaScript without declarations.
      const { treeDigest, preflightRelease } = await import("../scripts/release-common.mjs");
      manifest.contentSha256 = await treeDigest(packaged.root, { exclude: ["manifest.json"] });
      manifest.sha256 = manifest.contentSha256;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await preflightRelease(packaged.root);
      expect(result.ok).toBe(false);
      expect(result.missing.join("\n")).toMatch(/dpapi|root|path|canonical|relative/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("RED: manifest x64 sem runtime.dpapi nem addon canônico não pode passar", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-release-dpapi-missing-red-"));
    const source = join(root, "source");
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, join(root, "release"), "1.0.0");
      const manifestPath = join(packaged.root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.runtime = {};
      await rm(join(packaged.root, "app", "native"), { recursive: true, force: true });
      // @ts-expect-error local release script is executable JavaScript without declarations.
      const { treeDigest, preflightRelease } = await import("../scripts/release-common.mjs");
      manifest.contentSha256 = await treeDigest(packaged.root, { exclude: ["manifest.json"] });
      manifest.sha256 = manifest.contentSha256;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await preflightRelease(packaged.root);
      expect(result.ok).toBe(false);
      expect(result.missing.join("\n")).toMatch(/runtime\.dpapi|native|dpapi/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps materially different builds of the same product version distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-same-version-builds-"));
    const source = join(root, "source");
    const installRoot = join(root, "install");
    const dataRoot = join(root, "data");
    const localDataRoot = join(root, "local");
    try {
      await createFixture(source, "1.0.0");
      const first = await packageFixture(source, join(root, "release-first"), "1.0.0");
      await writeFile(join(source, "dist", "main.js"), "export default { build: 2 };\n");
      const second = await packageFixture(source, join(root, "release-second"), "1.0.0");
      expect(second.manifest.buildId).not.toBe(first.manifest.buildId);
      expect(second.manifest.releaseId).not.toBe(first.manifest.releaseId);
      expect(second.root).not.toBe(first.root);

      // @ts-expect-error executable local release helpers have no declaration files.
      const { installRelease } = await import("../scripts/install.mjs");
      // @ts-expect-error executable local release helpers have no declaration files.
      const { updateRelease } = await import("../scripts/update.mjs");
      await installRelease({ packagePath: first.root, installRoot, dataRoot, localDataRoot, skipShortcuts: true });
      const updated = await updateRelease({ packagePath: second.root, installRoot, backupRoot: join(root, "backups"), gatewayUrl: isolatedGatewayUrl });
      expect(updated.backup.path).toContain("backups");
      const state = JSON.parse(await readFile(join(installRoot, "state.json"), "utf8"));
      expect(state).toMatchObject({
        activeVersion: "1.0.0",
        activeReleaseId: second.manifest.releaseId,
        previousVersion: "1.0.0",
        previousReleaseId: first.manifest.releaseId,
      });
      await expect(readFile(join(installRoot, "versions", first.manifest.releaseId, "manifest.json"), "utf8")).resolves.toContain(first.manifest.buildId);
      await expect(readFile(join(installRoot, "versions", second.manifest.releaseId, "manifest.json"), "utf8")).resolves.toContain(second.manifest.buildId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("packages, installs, preflights, repairs, stages, rolls back failed updates, and uninstalls hermetically", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-release-lifecycle-"));
    const source = join(root, "source");
    const releaseOverride = join(root, "release-override");
    const releaseV1 = join(root, "release-v1");
    const releaseV2 = join(root, "release-v2");
    const installRoot = join(root, "install");
    const shortcutRoot = join(root, "shortcuts");
    const dataRoot = join(root, "data", "custom-roaming-root");
    const localDataRoot = join(root, "data", "custom-local-root");
    try {
      await createFixture(source, "1.0.0");
      const overridden = await packageFixture(source, releaseOverride, "9.9.9");
      expect(overridden.manifest.version).toBe("9.9.9");
      expect(JSON.parse(await readFile(join(overridden.root, "app", "package.json"), "utf8")).version).toBe("9.9.9");
      expect(JSON.parse(await readFile(join(overridden.root, "app", "client", "extracted", "package.json"), "utf8")).version).toBe("0.16.0");
      await expect(readFile(join(overridden.root, "app", "scripts", "openbot-browser-host.cjs"), "utf8")).resolves.toContain("OPENBOT_BROWSER_COMMAND_PIPE");
      await expect(readFile(join(overridden.root, "app", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "utf8")).resolves.toContain("fixture-native-runtime");
      await expect(readFile(join(overridden.root, "Uninstall-OpenBot.cmd"), "utf8")).resolves.toContain("OpenBot-lifecycle");
      await expect(readFile(join(overridden.root, "Repair-OpenBot.cmd"), "utf8")).resolves.toContain("--repair");
      await expect(readFile(join(overridden.root, "Update-OpenBot.cmd"), "utf8")).resolves.toContain("--package");
      await expect(readFile(join(overridden.root, "Rollback-OpenBot.cmd"), "utf8")).resolves.toContain("--rollback");

      const v1 = await packageFixture(source, releaseV1, "1.0.0");
      expect(v1.manifest.signed).toBe(false);
      expect(v1.manifest.security).toBe("unsigned-local");
      expect(v1.manifest.packageJsonVersion).toBe("1.0.0");
      expect(v1.manifest.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(v1.manifest.requiredFiles).toEqual(expect.arrayContaining([
        "assets/openbot.ico",
        "assets/openbot.png",
        "app/scripts/openbot-browser-host.cjs",
        "app/scripts/openbot-electron.cjs",
        "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        "OpenBot.cmd",
        "OpenBot.vbs",
        "Uninstall-OpenBot.cmd",
        "Repair-OpenBot.cmd",
        "Update-OpenBot.cmd",
        "Rollback-OpenBot.cmd",
      ]));
      await expect(readFile(join(v1.root, "assets", "openbot.ico"))).resolves.toEqual(await readFile(join(source, "assets", "openbot.ico")));
      await expect(readFile(join(v1.root, "assets", "openbot.png"))).resolves.toEqual(await readFile(join(source, "assets", "openbot.png")));
      await expect(readFile(join(v1.root, "runtime", "electron", "electron.exe"))).resolves.not.toEqual(await readFile(process.execPath));

      const publishRoot = join(root, "release-publish");
      const publishedDirectory = join(publishRoot, `OpenBot-${v1.manifest.releaseId}-win32-x64`);
      const publishedSidecar = join(publishRoot, `OpenBot-${v1.manifest.releaseId}-win32-x64.manifest.json`);
      await mkdir(publishedDirectory, { recursive: true });
      await writeFile(join(publishedDirectory, "publication-sentinel.txt"), "previous directory\n");
      await writeFile(publishedSidecar, JSON.stringify({ publicationSentinel: "previous sidecar" }));
      const { buildRelease } = await import("../scripts/release.mjs");
      await expect(buildRelease({
        sourceRoot: source,
        outputRoot: publishRoot,
        version: "1.0.0",
        platform: "win32",
        arch: "x64",
        nodeExecutable: process.execPath,
        electronDist: join(source, "node_modules", "electron", "dist"),
        distRoot: join(source, "dist"),
        clientDist: join(source, "client", "extracted", "dist"),
        nodeModules: join(source, "node_modules"),
        skipZip: true,
        failPublicationAt: "after-directory",
      })).rejects.toThrow("Simulated release publication failure");
      await expect(readFile(join(publishedDirectory, "publication-sentinel.txt"), "utf8")).resolves.toBe("previous directory\n");
      expect(JSON.parse(await readFile(publishedSidecar, "utf8")).publicationSentinel).toBe("previous sidecar");

      const identityTamper = join(root, "identity-tamper");
      await cp(v1.root, identityTamper, { recursive: true });
      const tamperedPackage = JSON.parse(await readFile(join(identityTamper, "app", "package.json"), "utf8"));
      tamperedPackage.version = "9.9.8";
      await writeFile(join(identityTamper, "app", "package.json"), JSON.stringify(tamperedPackage));
      expect(await runFailure("scripts/launch.mjs", ["--preflight", "--root", identityTamper])).toContain("Release identity mismatch");

      const entrypointTamper = join(root, "entrypoint-tamper");
      await cp(v1.root, entrypointTamper, { recursive: true });
      await rm(join(entrypointTamper, "OpenBot.cmd"), { force: true });
      expect(await runFailure("scripts/launch.mjs", ["--preflight", "--root", entrypointTamper])).toContain("OpenBot.cmd");

      const installed = await run("scripts/install.mjs", [
        "--package", v1.root,
        "--root", installRoot,
        "--shortcut-root", shortcutRoot,
        "--data-root", dataRoot,
        "--local-data-root", localDataRoot,
      ]);
      expect(installed.version).toBe("1.0.0");
      expect(existsSync(`${installRoot}.openbot-operation.lock`)).toBe(false);
      const installedState = JSON.parse(readFileSync(join(installRoot, "state.json"), "utf8"));
      expect(installedState).toMatchObject({
        activeVersion: "1.0.0",
        activeBuildId: v1.manifest.buildId,
        activeReleaseId: v1.manifest.releaseId,
        activeContentSha256: v1.manifest.contentSha256,
        dataRoot,
        localDataRoot,
      });
      const desktopShortcut = await shortcutDetails(join(shortcutRoot, "Desktop", "OpenBot.lnk"));
      expect(resolve(desktopShortcut.target)).toBe(resolve(join(installRoot, "OpenBot.vbs")));
      expect(desktopShortcut.arguments).toBe("");
      expect(desktopShortcut.appId).toBe("OpenBot.Desktop");
      expect(desktopShortcut.windowStyle).toBe(7);
      expect(resolve(desktopShortcut.iconLocation.split(",")[0]!)).toBe(resolve(join(installRoot, "versions", v1.manifest.releaseId, "assets", "openbot.ico")));
      expect((await shortcutDetails(join(shortcutRoot, "Start Menu", "OpenBot.lnk"))).target).toContain("OpenBot.vbs");
      await expect(readFile(join(installRoot, "OpenBot.ico"))).resolves.toEqual(await readFile(join(source, "assets", "openbot.ico")));
      const uninstallWrapper = await readFile(join(installRoot, "Uninstall-OpenBot.cmd"), "utf8");
      expect(uninstallWrapper).toContain('pushd "%TEMP%"');
      expect(uninstallWrapper).toContain('set "OPENBOT_EXIT=!ERRORLEVEL!"');
      expect(uninstallWrapper).toContain(Buffer.from(resolve(shortcutRoot), "utf8").toString("base64"));
      expect(uninstallWrapper).not.toContain(resolve(shortcutRoot));
      expect(uninstallWrapper).not.toMatch(/Start-Process|start "" \/b/iu);
      expect(await readFile(join(installRoot, "Repair-OpenBot.cmd"), "utf8")).toContain("--repair");
      expect(await readFile(join(installRoot, "Update-OpenBot.cmd"), "utf8")).toContain("--package");
      expect(await readFile(join(installRoot, "Rollback-OpenBot.cmd"), "utf8")).toContain("--rollback");
      expect(await readFile(join(installRoot, "Recovery-OpenBot.cmd"), "utf8")).toContain("recovery-center.mjs");
      const { stdout: recoveryOutput } = await execFileAsync("cmd.exe", ["/d", "/c", join(installRoot, "Recovery-OpenBot.cmd")], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      const recoveryStatus = JSON.parse(recoveryOutput);
      expect(recoveryStatus).toMatchObject({ ok: true, product: "OpenBot", activeVersion: "1.0.0" });
      await isolateMaintenancePort(installRoot);
      expect(await runFailure("scripts/install.mjs", [
        "--repair",
        "--package", v1.root,
        "--root", installRoot,
        "--data-root", join(installRoot, "data-inside"),
      ])).toContain("Data root must be outside");
      await isolateMaintenancePort(installRoot);
      expect(await runFailure("scripts/install.mjs", ["--repair", "--fail-shortcut", "--package", v1.root, "--root", installRoot, "--shortcut-root", shortcutRoot])).toContain("Simulated shortcut creation failure");
      expect(JSON.parse(await readFile(join(installRoot, "state.json"), "utf8")).activeVersion).toBe("1.0.0");
      const v1InstalledRoot = installedReleaseRoot(installRoot);
      expect(readFileSync(join(installRoot, "OpenBot.cmd"), "utf8")).toContain(`versions\\${v1.manifest.releaseId}\\OpenBot.cmd`);
      await expect(readFile(join(installRoot, "OpenBot.vbs"), "utf8")).resolves.toContain("OpenBot.cmd");
      await isolateMaintenancePort(installRoot);
      expect(await runFailure("scripts/update.mjs", ["--package", v1.root, "--root", installRoot])).toContain("already active");

      const preflight = await run("scripts/launch.mjs", ["--preflight", "--root", v1InstalledRoot]);
      expect(preflight.ok).toBe(true);
      expect(preflight.manifest.version).toBe("1.0.0");

      const installedMain = join(v1InstalledRoot, "app", "dist", "main.js");
      await writeFile(installedMain, "tampered\n");
      await isolateMaintenancePort(installRoot);
      await run("scripts/install.mjs", [
        "--repair",
        "--package", v1.root,
        "--root", installRoot,
        "--shortcut-root", shortcutRoot,
        "--data-root", dataRoot,
      ]);
      expect(await readFile(installedMain, "utf8")).toContain("export default");

      await mkdir(join(dataRoot), { recursive: true });
      await mkdir(join(localDataRoot, "workspaces", "bot-a", "Documents"), { recursive: true });
      await writeFile(join(dataRoot, "openbot-config.json"), "config-v1");
      await writeFile(join(dataRoot, "store.db"), "conversation-v1");
      await writeFile(join(dataRoot, "sand-secrets.json"), "encrypted-v1");
      await writeFile(join(dataRoot, ".master.key"), "master-v1");
      await writeFile(join(localDataRoot, "workspaces", "bot-a", "Documents", "note.txt"), "workspace-v1");

      await writeFile(join(source, "package.json"), JSON.stringify({ name: "openbot", version: "2.0.0", type: "module" }));
      const v2 = await packageFixture(source, releaseV2, "2.0.0");
      const staged = await run("scripts/update.mjs", ["--stage", "--package", v2.root, "--root", installRoot]);
      expect(staged.version).toBe("2.0.0");
      expect(JSON.parse(await readFile(join(installRoot, "state.json"), "utf8")).stagedVersion).toBe("2.0.0");
      await writeFile(join(installRoot, "process.json"), JSON.stringify({ gateway: { url: isolatedGatewayUrl }, launcherPid: 0 }));

      const failure = await runFailure("scripts/update.mjs", ["--root", installRoot, "--fail-after-commit"]);
      expect(failure).toContain("rolled back to 1.0.0");
      await expect(readFile(join(installRoot, "process.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(staged.staging, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const rolledBack = JSON.parse(await readFile(join(installRoot, "state.json"), "utf8"));
      expect(rolledBack.activeVersion).toBe("1.0.0");
      expect(await readFile(join(v1InstalledRoot, "manifest.json"), "utf8")).toContain('"version": "1.0.0"');

      await isolateMaintenancePort(installRoot);
      const updated = await run("scripts/update.mjs", ["--package", v2.root, "--root", installRoot]);
      expect(updated.version).toBe("2.0.0");
      expect(updated.backup.path).toContain("backups");
      expect(JSON.parse(await readFile(join(installRoot, "state.json"), "utf8")).activeVersion).toBe("2.0.0");
      await expect(readFile(join(v1InstalledRoot, "manifest.json"), "utf8")).resolves.toContain('"version": "1.0.0"');
      await writeFile(join(dataRoot, "openbot-config.json"), "config-v2");
      await writeFile(join(localDataRoot, "workspaces", "bot-a", "Documents", "note.txt"), "workspace-v2");

      await isolateMaintenancePort(installRoot);
      const rolledBackManually = await run("scripts/update.mjs", ["--rollback", "--root", installRoot]);
      expect(rolledBackManually).toMatchObject({ ok: true, version: "1.0.0", previousVersion: "2.0.0" });
      expect(JSON.parse(await readFile(join(installRoot, "state.json"), "utf8")).activeVersion).toBe("1.0.0");
      await expect(readFile(join(dataRoot, "openbot-config.json"), "utf8")).resolves.toBe("config-v1");
      await expect(readFile(join(localDataRoot, "workspaces", "bot-a", "Documents", "note.txt"), "utf8")).resolves.toBe("workspace-v1");

      await writeFile(join(dataRoot, "keep.txt"), "preserve me\n");
      await isolateMaintenancePort(installRoot);
      const removed = await run("scripts/uninstall.mjs", ["--root", installRoot, "--shortcut-root", shortcutRoot]);
      expect(removed.dataPreserved).toBe(true);
      await expect(readFile(installRoot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(dataRoot, "keep.txt"), "utf8")).resolves.toContain("preserve me");
      await expect(readFile(join(shortcutRoot, "Desktop", "OpenBot.lnk"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(shortcutRoot, "Start Menu", "OpenBot.lnk"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(existsSync(`${installRoot}.openbot-operation.lock`)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("mantém repair/update/uninstall em roots com apóstrofo e não deixa lock sibling", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "openbot-release-apostrophe-'"));
    const source = join(root, "source 'tree");
    const releaseV1 = join(root, "release 'v1");
    const releaseV2 = join(root, "release 'v2");
    const installRoot = join(root, "installed 'OpenBot");
    const dataRoot = join(root, "roaming 'data");
    const localDataRoot = join(root, "local 'data");
    const tempRoot = join(root, "temp 'runtime");
    const wrapperEnv = { ...process.env, TEMP: tempRoot, TMP: tempRoot };
    const invokeWrapper = async (name: string, args: string[] = []) => {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      return execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", `& ${quote(join(installRoot, name))} ${args.map(quote).join(" ")}; exit $LASTEXITCODE`], {
      cwd: root,
      env: wrapperEnv,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      });
    };
    try {
      await createFixture(source, "1.0.0");
      const v1 = await packageFixture(source, releaseV1, "1.0.0");
      await run("scripts/install.mjs", ["--package", v1.root, "--root", installRoot, "--data-root", dataRoot, "--local-data-root", localDataRoot, "--skip-shortcuts"]);
      const v1InstalledRoot = installedReleaseRoot(installRoot);
      await writeFile(join(v1InstalledRoot, "app", "dist", "main.js"), "tampered\n");
      await mkdir(tempRoot, { recursive: true });
      await isolateMaintenancePort(installRoot);
      await invokeWrapper("Repair-OpenBot.cmd", [v1.root]);
      await expect(readFile(join(v1InstalledRoot, "app", "dist", "main.js"), "utf8")).resolves.toContain("export default");

      await writeFile(join(dataRoot, "keep.txt"), "keep\n");
      await createFixture(source, "2.0.0");
      const v2 = await packageFixture(source, releaseV2, "2.0.0");
      await isolateMaintenancePort(installRoot);
      await invokeWrapper("Update-OpenBot.cmd", [v2.root]);
      expect(JSON.parse(readFileSync(join(installRoot, "state.json"), "utf8")).activeVersion).toBe("2.0.0");
      await isolateMaintenancePort(installRoot);
      await invokeWrapper("Uninstall-OpenBot.cmd");
      let installMissing = false;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        installMissing = await stat(installRoot).then(() => false, () => true);
        if (installMissing) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect(installMissing).toBe(true);
      await expect(readFile(join(dataRoot, "keep.txt"), "utf8")).resolves.toContain("keep");
      expect(existsSync(`${installRoot}.openbot-operation.lock`)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(process.platform !== "win32")("repairs from the install root and propagates child failure without temporary residue", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-repair-wrapper-cwd-"));
    const source = join(root, "source");
    const releaseRoot = join(root, "release");
    const installRoot = join(root, "install");
    const dataRoot = join(root, "data");
    const localDataRoot = join(root, "local");
    const tempRoot = join(root, "temp");
    const wrapperEnv = { ...process.env, TEMP: tempRoot, TMP: tempRoot };
    const invokeRepair = (packagePath: string) => execFileAsync("cmd.exe", ["/d", "/c", join(installRoot, "Repair-OpenBot.cmd"), packagePath], {
      cwd: installRoot,
      env: wrapperEnv,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    try {
      await createFixture(source, "1.0.0");
      const release = await packageFixture(source, releaseRoot, "1.0.0");
      await run("scripts/install.mjs", [
        "--package", release.root,
        "--root", installRoot,
        "--data-root", dataRoot,
        "--local-data-root", localDataRoot,
        "--skip-shortcuts",
      ]);
      await mkdir(tempRoot, { recursive: true });

      const installedMain = join(installedReleaseRoot(installRoot), "app", "dist", "main.js");
      await writeFile(installedMain, "tampered\n");
      await isolateMaintenancePort(installRoot);
      await invokeRepair(release.root);
      await expect(readFile(installedMain, "utf8")).resolves.toContain("export default");
      await expect(readdir(tempRoot)).resolves.toEqual([]);

      let childStatus: number | null = null;
      try {
        await invokeRepair(join(root, "missing-release"));
      } catch (error) {
        childStatus = (error as { code?: number; status?: number }).code
          ?? (error as { status?: number }).status
          ?? null;
      }
      expect(childStatus).toBe(1);
      await expect(readdir(tempRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("forwards validated purge arguments through the deferred Windows uninstall wrapper", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "openbot wrapper args "));
    const source = join(root, "source tree");
    const releaseRoot = join(root, "release output");
    const installRoot = join(root, "installed OpenBot");
    const shortcutRoot = join(root, "shortcut data");
    const dataRoot = join(root, "roaming data");
    const localDataRoot = join(root, "local data");
    try {
      await createFixture(source, "1.0.0");
      const release = await packageFixture(source, releaseRoot, "1.0.0");
      await run("scripts/install.mjs", [
        "--package", release.root,
        "--root", installRoot,
        "--shortcut-root", shortcutRoot,
        "--data-root", dataRoot,
        "--local-data-root", localDataRoot,
      ]);
      await writeFile(join(dataRoot, "purge-me.txt"), "owned data\n");
      await writeFile(join(installRoot, "process.json"), JSON.stringify({ gateway: { url: isolatedGatewayUrl } }));
      const wrapper = join(installRoot, "Uninstall-OpenBot.cmd");
      const invokeWrapper = (args: string[]) => execFileAsync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-Command",
        `& '${wrapper.replaceAll("'", "''")}' ${args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}; exit $LASTEXITCODE`,
      ], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });

      await expect(invokeWrapper(["--unknown"])).rejects.toThrow(/Unsupported uninstall argument/u);
      await expect(stat(installRoot)).resolves.toBeDefined();
      await expect(readFile(join(dataRoot, "purge-me.txt"), "utf8")).resolves.toContain("owned data");

      await invokeWrapper([
        "--purge-data", "--yes",
        "--data-root", dataRoot,
        "--shortcut-root", shortcutRoot,
      ]);

      let removed = false;
      let installMissing = false;
      let dataMissing = false;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        installMissing = await stat(installRoot).then(() => false, () => true);
        dataMissing = await stat(dataRoot).then(() => false, () => true);
        if (installMissing && dataMissing) {
          removed = true;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect({ removed, installMissing, dataMissing }).toEqual({ removed: true, installMissing: true, dataMissing: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps process.json when Windows quiesce cannot prove termination", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "openbot-quiesce-fail-"));
    const helper = `
      import { promises as fs } from "node:fs";
      import { spawn } from "node:child_process";
      import { installLayout, pathExists, quiesceInstall } from "./scripts/release-common.mjs";
      const root = process.argv[1];
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      const statePath = installLayout(root).processState;
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(statePath, JSON.stringify({ gatewayPid: child.pid }));
      try {
        await quiesceInstall(root, { timeoutMs: 100, taskkillPath: "__missing_taskkill__" });
        process.exitCode = 2;
      } catch {
        process.stdout.write((await pathExists(statePath)) ? "preserved" : "lost");
      } finally {
        child.kill();
      }
    `;
    try {
      const { stdout: result } = await execFileAsync(process.execPath, ["--input-type=module", "-e", helper, root], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result).toBe("preserved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans the temporary runtime when the deferred wrapper hits its inner failure branch", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "openbot-wrapper-inner-fail-"));
    const tempRoot = join(root, "temp runtime");
    const source = join(root, "versions", "1.0.0");
    try {
      await mkdir(join(source, "scripts"), { recursive: true });
      await writeFile(join(root, "state.json"), JSON.stringify({ product: "OpenBot", installRoot: root, activeVersion: "1.0.0" }));
      // @ts-expect-error executable release helper has no declaration file.
      const { lifecycleWrapperContents } = await import("../scripts/release-common.mjs");
      await writeFile(join(root, "Uninstall-OpenBot.cmd"), lifecycleWrapperContents("uninstall"));
      await expect(execFileAsync("cmd.exe", ["/d", "/c", join(root, "Uninstall-OpenBot.cmd")], {
        cwd: root,
        env: { ...process.env, TEMP: tempRoot, TMP: tempRoot },
        encoding: "utf8",
        windowsHide: true,
      })).rejects.toThrow();
      await expect(stat(tempRoot)).resolves.toBeDefined();
      await expect(readdir(tempRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a directory masquerading as the required SQLite native file", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-native-file-"));
    try {
      const source = await createFixture(join(root, "source"), "1.0.0");
      const packaged = await packageFixture(source, join(root, "release"), "1.0.0");
      const nativePath = join(packaged.root, "app", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
      await rm(nativePath, { force: true });
      await mkdir(nativePath);
      // @ts-expect-error local release helper is executable JavaScript without declarations.
      const { preflightRelease, treeDigest } = await import("../scripts/release-common.mjs");
      const manifestPath = join(packaged.root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const digest = await treeDigest(packaged.root, { exclude: ["manifest.json"] });
      manifest.contentSha256 = digest;
      manifest.sha256 = digest;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await preflightRelease(packaged.root);
      expect(result.ok).toBe(false);
      expect(result.missing).toContain("native/better-sqlite3.node");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reparse paths in digest, copy, and install-root canonicalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-reparse-"));
    const real = join(root, "real");
    const link = join(root, "link");
    try {
      await mkdir(real, { recursive: true });
      await writeFile(join(real, "payload.txt"), "payload\n");
      await symlink(real, link, process.platform === "win32" ? "junction" : "dir");
      // @ts-expect-error local release helper is executable JavaScript without declarations.
      const { canonicalizeInstallRoot, copyTree, treeDigest } = await import("../scripts/release-common.mjs");
      await expect(treeDigest(link)).rejects.toThrow(/Reparse|symbolic-link/);
      await expect(copyTree(real, link)).rejects.toThrow(/Reparse|symbolic-link/);
      await expect(canonicalizeInstallRoot(link)).rejects.toThrow(/Reparse|symbolic-link|canonical/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes a real zip whose manifest agrees with the sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-release-zip-"));
    const source = join(root, "source");
    const output = join(root, "release");
    const extracted = join(root, "extracted");
    try {
      await createFixture(source, "1.0.0");
      const result = await run("scripts/release.mjs", [
        "--source-root", source,
        "--output", output,
        "--version", "1.0.0",
        "--platform", "win32",
        "--arch", "x64",
        "--node", process.execPath,
        "--electron-dist", join(source, "node_modules", "electron", "dist"),
        "--dist", join(source, "dist"),
        "--client-dist", join(source, "client", "extracted", "dist"),
        "--node-modules", join(source, "node_modules"),
      ]);
      expect(result.artifact).toMatch(/\.zip$/iu);
      await expect(stat(result.artifact)).resolves.toBeDefined();
      await mkdir(extracted, { recursive: true });
      const quotedZip = result.artifact.replaceAll("'", "''");
      const quotedExtracted = extracted.replaceAll("'", "''");
      await execFileAsync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        `Expand-Archive -LiteralPath '${quotedZip}' -DestinationPath '${quotedExtracted}' -Force`,
      ], { windowsHide: true });
      const archiveManifest = JSON.parse(await readFile(join(extracted, "manifest.json"), "utf8"));
      const sidecar = JSON.parse(await readFile(result.manifestPath, "utf8"));
      expect(archiveManifest).toMatchObject({ version: "1.0.0", artifactType: "portable-directory" });
      expect(sidecar).toMatchObject({ version: "1.0.0", artifact: result.artifact, artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/iu) });
      const actualArtifactSha256 = createHash("sha256").update(await readFile(result.artifact)).digest("hex");
      expect(sidecar.artifactSha256).toBe(actualArtifactSha256);
      expect(sidecar.sha256).toBe(actualArtifactSha256);
      for (const key of ["schemaVersion", "product", "version", "platform", "arch", "packageJsonVersion", "contentSha256"]) {
        expect(sidecar[key]).toBe(archiveManifest[key]);
      }
      expect(sidecar.payloadSha256).toBe(archiveManifest.contentSha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("records a before/after inventory and leaves no fixture process, port, lock, log, or root residue", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-release-inventory-"));
    const source = join(root, "source");
    const release = join(root, "release");
    const installRoot = join(root, "install");
    const dataRoot = join(root, "data");
    const localDataRoot = join(root, "local");
    const server = http.createServer((_request, response) => response.end("fixture"));
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    let child: ReturnType<typeof spawn> | null = null;
    let green = false;
    try {
      await createFixture(source, "1.0.0");
      const packaged = await packageFixture(source, release, "1.0.0");
      // @ts-expect-error executable local release helpers have no declaration files.
      const { installRelease } = await import("../scripts/install.mjs");
      // @ts-expect-error executable local release helpers have no declaration files.
      const { captureProcessEvidence, installLayout } = await import("../scripts/release-common.mjs");
      await installRelease({ packagePath: packaged.root, installRoot, dataRoot, localDataRoot, skipShortcuts: true });
      await mkdir(localDataRoot, { recursive: true });
      await writeFile(join(dataRoot, "preserved.txt"), "data preserved\n");
      await writeFile(join(localDataRoot, "preserved.txt"), "local data preserved\n");
      const holdScript = join(installRoot, "fixture-owned-process.mjs");
      await writeFile(holdScript, "setInterval(() => {}, 1000);\n");
      child = spawn(process.execPath, [holdScript], { windowsHide: true, stdio: "ignore" });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child?.once("spawn", () => resolveSpawn());
        child?.once("error", rejectSpawn);
      });
      const evidence = await captureProcessEvidence(child.pid, { expectedExecutable: process.execPath, expectedRoot: installRoot });
      await writeFile(installLayout(installRoot).processState, JSON.stringify({
        gateway: { url: isolatedGatewayUrl },
        processes: { fixture: evidence },
      }));
      const before = await captureReleaseInventory(root, installRoot, [port]);
      expect(before.ports).toEqual([port]);
      expect(before.processes).toEqual([{ name: "fixture", pid: child.pid, alive: true }]);
      expect(before.locks).toEqual([]);
      expect(before.logs).toEqual([]);
      expect(before.residualRoots).toEqual([installRoot]);
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await execFileAsync("cmd.exe", ["/d", "/c", join(installRoot, "Uninstall-OpenBot.cmd")], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const temporaryEntries = await readdir(root);
        if (!existsSync(installRoot) && !temporaryEntries.some((entry) => entry.startsWith("install.removing-"))) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      const after = await captureReleaseInventory(root, installRoot, [port]);
      expect(after).toEqual({ processes: [], ports: [], locks: [], logs: [], residualRoots: [] });
      expect(child.exitCode).not.toBeNull();
      await expect(readFile(join(dataRoot, "preserved.txt"), "utf8")).resolves.toBe("data preserved\n");
      await expect(readFile(join(localDataRoot, "preserved.txt"), "utf8")).resolves.toBe("local data preserved\n");
      green = true;
    } finally {
      if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await stopFixtureChild(child);
      if (!green && process.env.OPENBOT_KEEP_RED_FIXTURES === "1") console.error(`[release-lifecycle] RED fixture preserved: ${root}`);
      else await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(process.platform !== "win32")("removes a non-empty deferred uninstall tree through the real Windows helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-deferred-removal-"));
    const target = join(root, "removing-%WINDIR%");
    let green = false;
    try {
      for (let index = 0; index < 40; index += 1) {
        await mkdir(join(target, "nested", String(index)), { recursive: true });
        await writeFile(join(target, "nested", String(index), "payload.txt"), `${index}\n`);
      }
      // @ts-expect-error executable local release helper has no declaration file.
      const { scheduleWindowsDeferredRemoval } = await import("../scripts/uninstall.mjs");
      let helperStderr = "";
      let helperCommand = "";
      let helperExit: string | null = null;
      await scheduleWindowsDeferredRemoval(target, {
        delayMs: 250,
        spawn: (file: string, args: string[], options: Record<string, unknown>) => {
          helperCommand = `${file} ${args.join(" ")}`;
          const spawned = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
          spawned.once("exit", (code, signal) => { helperExit = `code=${String(code)} signal=${String(signal)}`; });
          spawned.stderr?.on("data", (chunk) => { helperStderr += String(chunk); });
          return spawned;
        },
      });
      let removed = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!existsSync(target)) {
          removed = true;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      if (!removed) console.error(`[release-lifecycle] deferred helper command: ${helperCommand}\nexit=${helperExit}\nstderr: ${helperStderr}`);
      expect(removed).toBe(true);
      green = true;
    } finally {
      if (!green && process.env.OPENBOT_KEEP_RED_FIXTURES === "1") console.error(`[release-lifecycle] RED deferred fixture preserved: ${root}`);
      else await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(process.platform !== "win32")("fails closed for junctions in install versions, update staging, and update target", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-release-junction-lifecycle-"));
    const source = join(root, "source");
    const v1Root = join(root, "release-v1");
    const v2Root = join(root, "release-v2");
    const installVersions = join(root, "install-versions");
    const install = join(root, "install");
    const versionsOutside = join(root, "versions-outside");
    const stagingOutside = join(root, "staging-outside");
    const targetOutside = join(root, "target-outside");
    try {
      await createFixture(source, "1.0.0");
      const v1 = await packageFixture(source, v1Root, "1.0.0");
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "openbot", version: "2.0.0", type: "module" }));
      const v2 = await packageFixture(source, v2Root, "2.0.0");
      // @ts-expect-error executable local release helpers have no declaration files.
      const { installRelease } = await import("../scripts/install.mjs");
      // @ts-expect-error executable local release helpers have no declaration files.
      const { stageUpdate, updateRelease } = await import("../scripts/update.mjs");

      await mkdir(versionsOutside, { recursive: true });
      await writeFile(join(versionsOutside, "sentinel.txt"), "versions untouched\n");
      await mkdir(installVersions, { recursive: true });
      await symlink(versionsOutside, join(installVersions, "versions"), "junction");
      await expect(installRelease({
        packagePath: v1.root,
        installRoot: installVersions,
        dataRoot: join(root, "versions-data"),
        localDataRoot: join(root, "versions-local"),
        skipShortcuts: true,
      })).rejects.toThrow(/refusing|reparse|symbolic-link|canonical/i);
      await expect(readdir(versionsOutside)).resolves.toEqual(["sentinel.txt"]);
      await expect(readFile(join(versionsOutside, "sentinel.txt"), "utf8")).resolves.toBe("versions untouched\n");
      expect((await lstat(join(installVersions, "versions"))).isSymbolicLink()).toBe(true);

      await installRelease({
        packagePath: v1.root,
        installRoot: install,
        dataRoot: join(root, "data"),
        localDataRoot: join(root, "local"),
        skipShortcuts: true,
      });
      await mkdir(stagingOutside, { recursive: true });
      await writeFile(join(stagingOutside, "sentinel.txt"), "staging untouched\n");
      await rm(join(install, "staging"), { recursive: true, force: true });
      await symlink(stagingOutside, join(install, "staging"), "junction");
      await expect(stageUpdate({ packagePath: v2.root, installRoot: install })).rejects.toThrow(/reparse|symbolic-link|canonical/i);
      await expect(readdir(stagingOutside)).resolves.toEqual(["sentinel.txt"]);
      await expect(readFile(join(stagingOutside, "sentinel.txt"), "utf8")).resolves.toBe("staging untouched\n");
      expect((await lstat(join(install, "staging"))).isSymbolicLink()).toBe(true);

      await rm(join(install, "staging"), { recursive: true, force: true });
      await mkdir(join(install, "staging"), { recursive: true });
      await mkdir(targetOutside, { recursive: true });
      await writeFile(join(targetOutside, "sentinel.txt"), "untouched\n");
      await symlink(targetOutside, join(install, "versions", v2.manifest.releaseId), "junction");
      await expect(updateRelease({ packagePath: v2.root, installRoot: install, gatewayUrl: isolatedGatewayUrl })).rejects.toThrow(/reparse|symbolic-link|canonical/i);
      await expect(readFile(join(targetOutside, "sentinel.txt"), "utf8")).resolves.toBe("untouched\n");
      await expect(readFile(join(install, "state.json"), "utf8")).resolves.toContain('"activeVersion": "1.0.0"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
