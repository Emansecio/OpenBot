import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// @ts-expect-error Release helpers are native ESM scripts.
import { createShortcut, writeVersionLauncher } from "../scripts/release-common.mjs";
// @ts-expect-error Desktop setup is a native ESM script.
import { setupDesktopShortcut } from "../scripts/setup-desktop-shortcut.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);

// This reads real HWND state, not calls recorded by a BrowserWindow mock.
// WM_GETICON must run out-of-process while Electron's message loop stays free.
const nativeProbe = String.raw`
param([string]$Actual, [string]$Reference, [string]$Stock)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class WindowIdentity {
  [DllImport("user32.dll", SetLastError=true)]
  static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
  [StructLayout(LayoutKind.Sequential)]
  struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size=24)]
  struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")]
  static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  [DllImport("ole32.dll")]
  static extern int PropVariantClear(ref PropVariant value);
  public static string Property(long handle, uint pid) {
    var iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(handle), ref iid, out store));
    try {
      var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = pid };
      PropVariant value;
      Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
      try {
        if (value.vt != 31) throw new Exception("Expected VT_LPWSTR for property " + pid + ", got " + value.vt);
        return Marshal.PtrToStringUni(value.pointer);
      } finally { PropVariantClear(ref value); }
    } finally { Marshal.ReleaseComObject(store); }
  }
  public static string IconHash(long handle, uint size) {
    UIntPtr result;
    if (SendMessageTimeout(new IntPtr(handle), 0x007f, new UIntPtr(size), IntPtr.Zero, 2, 5000, out result) == IntPtr.Zero)
      throw new Exception("WM_GETICON failed: " + Marshal.GetLastWin32Error());
    if (result == UIntPtr.Zero) return null;
    // FromHandle borrows the HWND-owned HICON; do not call DestroyIcon on it.
    using (var icon = Icon.FromHandle(new IntPtr(unchecked((long)result.ToUInt64()))))
    using (var bitmap = icon.ToBitmap())
    using (var stream = new MemoryStream())
    using (var sha = SHA256.Create()) {
      bitmap.Save(stream, ImageFormat.Png);
      return BitConverter.ToString(sha.ComputeHash(stream.ToArray()));
    }
  }
}
'@
@{
  appId = [WindowIdentity]::Property([long]$Actual, 5)
  relaunchCommand = [WindowIdentity]::Property([long]$Actual, 2)
  relaunchIcon = [WindowIdentity]::Property([long]$Actual, 3)
  relaunchName = [WindowIdentity]::Property([long]$Actual, 4)
  actualIcons = @([WindowIdentity]::IconHash([long]$Actual, 0), [WindowIdentity]::IconHash([long]$Actual, 1))
  referenceIcons = @([WindowIdentity]::IconHash([long]$Reference, 0), [WindowIdentity]::IconHash([long]$Reference, 1))
  stockIcons = @([WindowIdentity]::IconHash([long]$Stock, 0), [WindowIdentity]::IconHash([long]$Stock, 1))
} | ConvertTo-Json -Compress
`;

const electronFixture = String.raw`
const { app, BrowserWindow, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const root = process.env.OPENBOT_IDENTITY_FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
app.setPath('userData', path.join(root, 'profile', 'electron'));
app.setPath('sessionData', path.join(root, 'profile', 'session'));
app.setPath('logs', path.join(root, 'profile', 'logs'));
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error('Identity fixture timeout'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const png = nativeImage.createFromPath(config.png);
  if (png.isEmpty()) throw new Error('Real PNG asset did not decode');
  const options = { show: false, width: 240, height: 160, webPreferences: { sandbox: true } };
  const stock = new BrowserWindow(options);
  const reference = new BrowserWindow(options);
  reference.setIcon(png);
  // The only stub is the full extracted application entry. All Electron APIs
  // and the production wrapper remain real; no gateway or renderer is loaded.
  const originalLoad = Module._load;
  let intercepted = 0;
  Module._load = function(request, parent, isMain) {
    if (request === '../client/extracted/dist/electron-main/main.cjs' && parent.filename === config.wrapper) {
      intercepted++;
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { require(config.wrapper); } finally { Module._load = originalLoad; }
  if (intercepted !== 1) throw new Error('Extracted entry was not isolated');
  const actual = new BrowserWindow(options);
  const handle = window => {
    const value = window.getNativeWindowHandle();
    return value.length === 8 ? value.readBigUInt64LE().toString() : value.readUInt32LE().toString();
  };
  const probe = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'native.ps1'), handle(actual), handle(reference), handle(stock)], { windowsHide: true, timeout: 20000 });
  const generated = shell.readShortcutLink(config.shortcut);
  const checkoutShortcut = shell.readShortcutLink(config.checkoutShortcut);
  const nativeLink = path.join(root, 'native-reference.lnk');
  if (!shell.writeShortcutLink(nativeLink, 'create', {
    target: config.launcher, args: '', cwd: root, icon: config.ico, iconIndex: 0, appUserModelId: 'OpenBot.Desktop'
  })) throw new Error('Native reference shortcut creation failed');
  const nativeShortcut = shell.readShortcutLink(nativeLink);
  // openPath uses ShellExecute, the same default shell verb as double-click.
  // Deliberately give both caller and .lnk System32 as cwd: the production VBS
  // must establish the fixture root itself before it dispatches the sentinel.
  const previousCwd = process.cwd();
  process.chdir(path.join(process.env.SystemRoot, 'System32'));
  let openError;
  try { openError = await shell.openPath(config.shortcut); }
  finally { process.chdir(previousCwd); }
  if (openError) throw new Error(openError);
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path.join(root, 'sentinel.txt'))) {
    if (Date.now() >= deadline) throw new Error('Direct-VBS shortcut did not dispatch sentinel');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // The sentinel is written atomically after cmd has returned. The production
  // VBS then removes its own log before exit; wait for that cleanup as well.
  while (fs.readdirSync(path.join(root, 'logs')).some(name => name.startsWith('launcher-'))) {
    if (Date.now() >= deadline) throw new Error('Hidden launcher did not finish');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
    appName: app.getName(), native: JSON.parse(probe.stdout.trim()), generated, nativeShortcut, checkoutShortcut,
    sentinel: fs.readFileSync(path.join(root, 'sentinel.txt'), 'utf16le').replace(/^\uFEFF/, '').trim()
  }));
  for (const window of [actual, reference, stock]) window.destroy();
  clearTimeout(watchdog);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
`;

describe.skipIf(process.platform !== "win32")("real Windows desktop identity", () => {
  it("sets native window icons/taskbar properties and launches a direct-VBS shortcut in an isolated root", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot identity açento "));
    let electronPid: number | undefined;
    try {
      for (const directory of ["assets", "profile", "profile/electron", "profile/session", "profile/logs", "profile/temp", "profile/roaming", "profile/local"])
        mkdirSync(join(root, directory), { recursive: true });
      const png = join(root, "assets", "openbot.png");
      const ico = join(root, "assets", "openbot.ico");
      copyFileSync(join(repo, "assets", "openbot.png"), png);
      copyFileSync(join(repo, "assets", "openbot.ico"), ico);
      await writeVersionLauncher(root);
      // Replace only the disposable fixture CMD, never a real launcher. /u
      // makes cmd's cwd output Unicode without depending on the system locale.
      writeFileSync(join(root, "OpenBot.cmd"), '@echo off\r\n"%ComSpec%" /d /u /c cd > "%~dp0sentinel.tmp"\r\nmove /y "%~dp0sentinel.tmp" "%~dp0sentinel.txt" >nul\r\nexit /b 0\r\n');
      const launcher = join(root, "OpenBot.vbs");
      const shortcut = join(root, "OpenBot fixture.lnk");
      const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      const created = await createShortcut(launcher, shortcut, {
        arguments: "", workingDirectory: system32, iconLocation: `${ico},0`,
        appUserModelId: "OpenBot.Desktop", allowFallback: false,
      });
      expect(created.skipped).toBe(false);
      expect(created.fallback).toBe(false);
      mkdirSync(join(root, "scripts"));
      copyFileSync(join(repo, "scripts", "openbot-desktop.vbs"), join(root, "scripts", "openbot-desktop.vbs"));
      const checkoutShortcut = join(root, "checkout-fixture.lnk");
      await setupDesktopShortcut({ root, shortcutPath: checkoutShortcut });
      writeFileSync(join(root, "native.ps1"), nativeProbe, "utf8");
      writeFileSync(join(root, "main.cjs"), electronFixture, "utf8");
      writeFileSync(join(root, "config.json"), JSON.stringify({
        png, ico, launcher, shortcut, checkoutShortcut, wrapper: join(repo, "scripts", "openbot-electron.cjs"),
      }));
      const env: NodeJS.ProcessEnv = { ...process.env, OPENBOT_IDENTITY_FIXTURE: root, OPENBOT_RELEASE_ROOT: root, OPENBOT_INSTALL_ROOT: root,
        APPDATA: join(root, "profile", "roaming"), LOCALAPPDATA: join(root, "profile", "local"),
        USERPROFILE: join(root, "profile"), HOME: join(root, "profile"), OPENBOT_HOME: join(root, "profile"),
        TEMP: join(root, "profile", "temp"), TMP: join(root, "profile", "temp"),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const electron: unknown = createRequire(import.meta.url)("electron");
      if (typeof electron !== "string") throw new Error("Installed Electron executable is unavailable");
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (electronPid != null) void execute("taskkill.exe", ["/PID", String(electronPid), "/T", "/F"], { windowsHide: true }).catch(reject);
        }, 65000);
        const child = execFile(electron, [join(root, "main.cjs"), "--disable-gpu", "--no-first-run"],
          { env, cwd: system32, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
          (error, stdout, stderr) => {
            clearTimeout(timeout);
            electronPid = undefined;
            if (error) reject(new Error(`Electron identity fixture failed: ${error.message}\n${stdout}\n${stderr}`));
            else resolve();
          });
        electronPid = child.pid;
      });
      const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
      expect(result.appName).toBe("OpenBot");
      expect(result.native.appId).toBe("OpenBot.Desktop");
      expect(result.native.relaunchName).toBe("OpenBot");
      expect(result.native.relaunchCommand).toBe(`"${join(system32, "wscript.exe")}" "${launcher}"`);
      expect(result.native.relaunchIcon.toLowerCase()).toBe(`${ico},0`.toLowerCase());
      expect(result.native.referenceIcons).toHaveLength(2);
      for (const icon of result.native.referenceIcons) expect(icon).toMatch(/^[0-9A-F-]{95}$/);
      expect(result.native.actualIcons).toEqual(result.native.referenceIcons);
      expect(result.native.actualIcons).not.toEqual(result.native.stockIcons);
      for (const link of [result.generated, result.nativeShortcut]) {
        expect(link.target.toLowerCase()).toBe(launcher.toLowerCase());
        expect(link.args).toBe("");
        expect(link.icon.toLowerCase()).toBe(ico.toLowerCase());
        expect(link.iconIndex).toBe(0);
        expect(link.appUserModelId).toBe("OpenBot.Desktop");
      }
      expect(result.checkoutShortcut).toMatchObject({
        target: join(root, "scripts", "openbot-desktop.vbs"), args: "", cwd: root,
        icon: ico, iconIndex: 0, appUserModelId: "OpenBot.Desktop",
      });
      expect(result.generated.cwd.toLowerCase()).toBe(system32.toLowerCase());
      expect(result.sentinel.toLowerCase()).toBe(root.toLowerCase());
    } finally {
      if (electronPid != null) await execute("taskkill.exe", ["/PID", String(electronPid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 90000);
});
