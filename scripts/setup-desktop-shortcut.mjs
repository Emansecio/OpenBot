import { access, lstat, readFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertNoReparseAncestors, createShortcut, isMainModule, parseArgs } from "./release-common.mjs";
import { TASKBAR_APP_ID } from "./shortcut-appid.mjs";

async function desktopPath() {
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Environment]::GetFolderPath('Desktop')"],
  { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  const directory = stdout.trim();
  if (!directory) throw new Error("Windows Desktop folder is unavailable.");
  return join(directory, "OpenBot.lnk");
}

/** Recreates only the checkout shortcut. Does not launch/restart the app or touch bot data. */
export async function setupDesktopShortcut(options = {}) {
  const root = resolve(options.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const target = join(root, "scripts", "openbot-desktop.vbs");
  const icon = join(root, "assets", "openbot.ico");
  await Promise.all([access(target), access(icon)]);
  const path = options.shortcutPath === undefined ? await desktopPath() : resolve(options.shortcutPath);
  return createShortcut(target, path, {
    arguments: "", workingDirectory: root, description: "OpenBot local desktop",
    windowStyle: 7, iconLocation: icon, appUserModelId: TASKBAR_APP_ID, allowFallback: false,
  });
}

async function readTaskbarLink(path) {
  let bytes;
  try {
    await assertNoReparseAncestors(path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Unsafe shortcut: ${path}`);
    bytes = await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)",
    `$path=${quote(path)}`,
    "$link=(New-Object -ComObject WScript.Shell).CreateShortcut($path)",
    "$folder=(New-Object -ComObject Shell.Application).Namespace([IO.Path]::GetDirectoryName($path))",
    "$item=$folder.ParseName([IO.Path]::GetFileName($path))",
    "[pscustomobject]@{target=$link.TargetPath;arguments=$link.Arguments;cwd=$link.WorkingDirectory;icon=$link.IconLocation;appId=$item.ExtendedProperty('System.AppUserModel.ID')} | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  if (!(await readFile(path)).equals(bytes)) throw new Error(`Shortcut changed while reading: ${path}`);
  return { ...JSON.parse(stdout), bytes };
}

async function assertTaskbarLinkUnchanged(path, previous) {
  await assertNoReparseAncestors(path);
  let current = null;
  try { current = await readFile(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous ? !current?.equals(previous.bytes) : current !== null) throw new Error(`Shortcut changed before repair: ${path}`);
}

/** Register the checkout in the Start menu. Desktop shortcuts and bot data are not touched. */
export async function ensureTaskbarShortcut(options = {}) {
  const root = resolve(options.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const target = join(root, "scripts", "openbot-desktop.vbs");
  const icon = join(root, "assets", "openbot.ico");
  const electron = resolve(options.electronPath ?? process.env.ELECTRON_PATH ?? join(root, "node_modules", "electron", "dist", "electron.exe"));
  await Promise.all([access(target), access(icon)]);
  let programs = options.programsPath;
  if (programs === undefined) {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); [Environment]::GetFolderPath('Programs')"],
    { windowsHide: true, encoding: "utf8", timeout: 10_000 });
    programs = stdout.trim();
    if (!programs) throw new Error("Windows Start menu folder is unavailable.");
  }
  const canonical = join(resolve(programs), "OpenBot.lnk");
  const legacyPath = join(resolve(programs), "Electron.lnk");
  const same = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  const [current, legacy] = await Promise.all([readTaskbarLink(canonical), readTaskbarLink(legacyPath)]);
  // An explicit AppID on Electron.lnk makes Explorer choose Electron's name/icon,
  // even when the running HWND has correct OpenBot icons and relaunch metadata.
  const conflicting = legacy?.appId === TASKBAR_APP_ID;
  if (conflicting && (!same(legacy.target, electron) || legacy.arguments !== "")) {
    throw new Error(`Refusing to replace another application's taskbar registration: ${legacyPath}`);
  }
  if (current && (!same(current.target, target) || current.arguments !== "")) {
    throw new Error(`Refusing to replace another application's shortcut: ${canonical}`);
  }
  const correct = link => link && same(link.target, target) && link.arguments === "" &&
    same(link.cwd, root) && same(link.icon, `${icon},0`) && link.appId === TASKBAR_APP_ID;
  let changed = false;
  if (!correct(current)) {
    await assertTaskbarLinkUnchanged(canonical, current);
    const created = await setupDesktopShortcut({ root, shortcutPath: canonical });
    if (created.skipped || !correct(await readTaskbarLink(canonical))) throw new Error("OpenBot taskbar registration was not confirmed.");
    changed = true;
  }
  // Publish and confirm the replacement before removing this exact legacy link.
  if (conflicting) {
    await assertTaskbarLinkUnchanged(legacyPath, legacy);
    await unlink(legacyPath);
    changed = true;
  }
  return { path: canonical, changed, legacyRemoved: Boolean(conflicting) };
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs();
  if (args.shortcut !== undefined && typeof args.shortcut !== "string") throw new Error("--shortcut requires a path.");
  if (args["taskbar-only"] && args.shortcut !== undefined) throw new Error("--taskbar-only does not accept --shortcut.");
  const setup = args["taskbar-only"] ? ensureTaskbarShortcut() : setupDesktopShortcut({ shortcutPath: args.shortcut });
  setup.then(
    result => console.log(JSON.stringify(result)),
    error => { console.error(error.message); process.exitCode = 1; },
  );
}
