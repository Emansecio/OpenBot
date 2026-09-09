import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error helper script is authored as ESM JavaScript.
import { HERMES_ELECTRON_EXE, resolveElectronExecutable } from "../scripts/electron-executable.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("electron launch script helpers", () => {
  it("prefers ELECTRON_EXE override when present", () => {
    const root = tempRoot("openbot-electron-override-");
    const override = join(root, "custom-electron.exe");
    writeFileSync(override, "fixture");
    expect(resolveElectronExecutable(root, override)).toBe(override);
  });

  it("falls back to repo node_modules electron before Hermes", () => {
    const root = tempRoot("openbot-electron-repo-");
    const repoElectron = join(root, "node_modules", "electron", "dist", "electron.exe");
    mkdirSync(join(root, "node_modules", "electron", "dist"), { recursive: true });
    writeFileSync(repoElectron, "fixture", { encoding: "utf8" });
    expect(resolveElectronExecutable(root, "")).toBe(repoElectron);
  });

  it("throws a clear error when override is invalid", () => {
    expect(() => resolveElectronExecutable("C:\\Repo", "C:\\missing\\electron.exe", () => false))
      .toThrow(/ELECTRON_EXE override not found/i);
  });

  it("throws a clear error when no runtime exists", () => {
    expect(() => resolveElectronExecutable("C:\\Repo", "", () => false))
      .toThrow(new RegExp(HERMES_ELECTRON_EXE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  });
});
