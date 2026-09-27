import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error helper script is authored as ESM JavaScript.
import { resolveElectronExecutable } from "../scripts/electron-executable.mjs";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();

afterEach(async () => {
  await temp.cleanup();
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temp.track(root);
  return root;
}

describe("electron launch script helpers", () => {
  it.skipIf(process.platform !== "win32")("boots the checkout's Node with no system Node in PATH", () => {
    const root = tempRoot("openbot portable runtime ");
    const scriptDirectory = join(root, "scripts");
    const runtimeDirectory = join(root, "runtime", "node");
    mkdirSync(scriptDirectory, { recursive: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    copyFileSync(process.execPath, join(runtimeDirectory, "node.exe"));
    const source = readFileSync(new URL("../scripts/openbot-desktop.cmd", import.meta.url), "utf8");
    const boundary = source.indexOf('node "%CD%\\scripts\\launch.mjs"');
    expect(boundary).toBeGreaterThan(0);
    const launcher = join(scriptDirectory, "probe.cmd");
    writeFileSync(launcher, source.slice(0, boundary) + 'node -p "process.versions.modules"\r\nexit /b %ERRORLEVEL%\r\n');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "probe.cmd"], {
      cwd: scriptDirectory, env, windowsHide: true, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(process.versions.modules);
  });

  it("prefers ELECTRON_EXE override when present", () => {
    const root = tempRoot("openbot-electron-override-");
    const override = join(root, "custom-electron.exe");
    writeFileSync(override, "fixture");
    expect(resolveElectronExecutable(root, override)).toBe(override);
  });

  it("falls back to the repository's node_modules electron", () => {
    const root = tempRoot("openbot-electron-repo-");
    const repoElectron = join(root, "node_modules", "electron", "dist", "electron.exe");
    mkdirSync(join(root, "node_modules", "electron", "dist"), { recursive: true });
    writeFileSync(repoElectron, "fixture", { encoding: "utf8" });
    expect(resolveElectronExecutable(root, "")).toBe(repoElectron);
  });

  it("throws a clear error when override is invalid", () => {
    expect(() => resolveElectronExecutable("C:\\Repo", "C:\\missing\\electron.exe", () => false))
      .toThrow(/override \(ELECTRON_EXE\/ELECTRON_PATH\) not found/i);
  });

  it("throws a clear error when no runtime exists, without probing other applications", () => {
    const probed: string[] = [];
    expect(() => resolveElectronExecutable("C:\\Repo", "", (path: string) => { probed.push(path); return false; }))
      .toThrow(/Electron runtime not found at C:\\Repo\\node_modules\\electron\\dist\\electron\.exe[\s\S]*npm install/u);
    expect(probed).toEqual(["C:\\Repo\\node_modules\\electron\\dist\\electron.exe"]);
  });

  it("accepts the ELECTRON_PATH override the desktop launcher has always honoured", () => {
    const root = tempRoot("openbot-electron-path-");
    const override = join(root, "electron.exe");
    writeFileSync(override, "fixture");
    const previousExe = process.env.ELECTRON_EXE;
    const previousPath = process.env.ELECTRON_PATH;
    try {
      delete process.env.ELECTRON_EXE;
      process.env.ELECTRON_PATH = override;
      expect(resolveElectronExecutable(root)).toBe(override);
    } finally {
      if (previousExe === undefined) delete process.env.ELECTRON_EXE; else process.env.ELECTRON_EXE = previousExe;
      if (previousPath === undefined) delete process.env.ELECTRON_PATH; else process.env.ELECTRON_PATH = previousPath;
    }
  });
});
