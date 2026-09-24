import http from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TempRoots } from "./helpers/temp-roots.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoots = new TempRoots();
const execFileAsync = promisify(execFileCallback);
const currentProcessEvidence = {
  pid: process.pid,
  creationTime: "test-process",
  executablePath: process.execPath,
  commandLine: process.execPath,
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await tempRoots.cleanup();
});

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempRoots.track(path);
  return path;
}


describe("desktop lifecycle hardening", () => {

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

  it.skipIf(process.platform !== "win32")("routes missing-state wrapper exits through verified cleanup and keeps apostrophe paths out of PowerShell literals", async () => {
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

  it.skipIf(process.platform !== "win32")("cleans missing-state and repair-package early exits with apostrophe TEMP roots", async () => {
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
