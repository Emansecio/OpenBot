import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Native ESM launcher helper.
import { ensureTaskbarShortcut, ensureTaskbarShortcutCached } from "../scripts/setup-desktop-shortcut.mjs";
// @ts-expect-error Native ESM script helper.
import { createShortcut } from "../scripts/common.mjs";
// @ts-expect-error Native ESM shortcut parser.
import { getShortcutAppId, parseLnk } from "../scripts/shortcut-appid.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
async function fixture(run: (options: { root: string; programsPath: string; electronPath: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "openbot-taskbar-"));
  const programsPath = join(root, "menu");
  const electronPath = join(root, "electron.exe");
  try {
    for (const dir of [programsPath, join(root, "scripts"), join(root, "assets")]) mkdirSync(dir);
    copyFileSync(join(repo, "scripts/openbot-desktop.vbs"), join(root, "scripts/openbot-desktop.vbs"));
    copyFileSync(join(repo, "assets/openbot.ico"), join(root, "assets/openbot.ico"));
    writeFileSync(electronPath, "fixture only; never executed");
    await run({ root, programsPath, electronPath });
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}
const linkOptions = { arguments: "", appUserModelId: "OpenBot.Desktop", allowFallback: false };

describe.skipIf(process.platform !== "win32")("Start-menu taskbar identity", () => {
  it("skips the shell round trips while the confirmed registration is unchanged", async () => {
    await fixture(async options => {
      const canonical = join(options.programsPath, "OpenBot.lnk");
      const stampPath = join(options.root, "logs", "taskbar-shortcut.json");
      expect(await ensureTaskbarShortcutCached({ ...options, stampPath })).toMatchObject({ path: canonical, changed: true, cached: false });
      expect(await ensureTaskbarShortcutCached({ ...options, stampPath })).toMatchObject({ path: canonical, changed: false, cached: true });
      // A foreign Electron alias appearing next to it invalidates the stamp.
      await createShortcut(options.electronPath, join(options.programsPath, "Electron.lnk"), linkOptions);
      expect(await ensureTaskbarShortcutCached({ ...options, stampPath })).toMatchObject({ cached: false, legacyRemoved: true });
      // So do a deleted link and a torn stamp file.
      rmSync(canonical);
      expect(await ensureTaskbarShortcutCached({ ...options, stampPath })).toMatchObject({ cached: false, changed: true });
      writeFileSync(stampPath, "{");
      expect(await ensureTaskbarShortcutCached({ ...options, stampPath })).toMatchObject({ cached: false, changed: false });
    });
  });

  it("replaces the Electron alias, stays idempotent and repairs its recurrence without touching Desktop", async () => {
    await fixture(async options => {
      const legacy = join(options.programsPath, "Electron.lnk");
      const canonical = join(options.programsPath, "OpenBot.lnk");
      const desktop = join(options.root, "Desktop"); mkdirSync(desktop);
      const desktopLink = join(desktop, "OpenBot.lnk"); writeFileSync(desktopLink, "untouched desktop fixture");
      await createShortcut(options.electronPath, legacy, linkOptions);
      // This is the observed failure: Explorer indexes Electron under OpenBot's ID.
      expect(getShortcutAppId(legacy)).toBe("OpenBot.Desktop");
      expect(existsSync(canonical)).toBe(false);
      expect(await ensureTaskbarShortcut(options)).toMatchObject({ changed: true, legacyRemoved: true });
      expect(existsSync(legacy)).toBe(false);
      const saved = readFileSync(canonical);
      expect(getShortcutAppId(canonical)).toBe("OpenBot.Desktop");
      const { strings } = parseLnk(saved, canonical);
      expect(strings.iconLocation).toBe(join(options.root, "assets/openbot.ico"));
      expect(strings.workingDir).toBe(options.root);
      expect(await ensureTaskbarShortcut(options)).toMatchObject({ changed: false, legacyRemoved: false });
      expect(readFileSync(canonical)).toEqual(saved);
      await createShortcut(options.electronPath, legacy, linkOptions);
      expect(await ensureTaskbarShortcut(options)).toMatchObject({ changed: true, legacyRemoved: true });
      expect(readFileSync(canonical)).toEqual(saved);
      expect(readFileSync(desktopLink, "utf8")).toBe("untouched desktop fixture");
    });
  });

  it.each(["Electron.lnk", "OpenBot.lnk"])("refuses a foreign %s without changing it", async name => {
    await fixture(async options => {
      const path = join(options.programsPath, name);
      await createShortcut(join(options.root, "foreign.exe"), path, linkOptions);
      const before = readFileSync(path);
      await expect(ensureTaskbarShortcut(options)).rejects.toThrow("Refusing to replace another application's");
      expect(readFileSync(path)).toEqual(before);
    });
  });

  it("preserves an unrelated Electron registration", async () => {
    await fixture(async options => {
      const legacy = join(options.programsPath, "Electron.lnk");
      await createShortcut(options.electronPath, legacy, { ...linkOptions, appUserModelId: "Other.Application" });
      const before = readFileSync(legacy);
      expect(await ensureTaskbarShortcut(options)).toMatchObject({ changed: true, legacyRemoved: false });
      expect(readFileSync(legacy)).toEqual(before);
    });
  });

  it("does not remove the conflicting link when publishing its replacement fails", async () => {
    await fixture(async options => {
      const legacy = join(options.programsPath, "Electron.lnk");
      await createShortcut(options.electronPath, legacy, linkOptions);
      const before = readFileSync(legacy);
      vi.stubEnv("OPENBOT_TEST_SHORTCUT_FAILURE", "1");
      await expect(ensureTaskbarShortcut(options)).rejects.toThrow("Simulated shortcut creation failure");
      expect(readFileSync(legacy)).toEqual(before);
      expect(existsSync(join(options.programsPath, "OpenBot.lnk"))).toBe(false);
    });
  });
});
