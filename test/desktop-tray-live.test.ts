import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// @ts-expect-error Shared E2E environment helper is a native ESM script.
import { cleanE2eEnvironment } from "../scripts/e2e-runtime.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);
const fixture = String.raw`
const electron = require('electron');
const { app, BrowserWindow } = electron;
const { join } = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const run = promisify(require('node:child_process').execFile);
const root = __dirname;
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'session'));
app.setPath('logs', join(root, 'logs'));
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error('Tray fixture timeout'); app.exit(1); }, 30000);
const waitFor = async (check) => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Tray state timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
let tray, menu, main, auxiliaryClosed = false, quitPasses = 0, closed = false;
app.whenReady().then(async () => {
  const wrapper = join(root, 'scripts', 'openbot-electron.cjs');
  const load = Module._load;
  // Capture handles, but use real Electron Tray, Menu and BrowserWindow APIs.
  Module._load = function(request, parent, isMain) {
    if (request === 'electron' && parent.filename === wrapper) return {
      ...electron,
      Tray: function(image) { tray = new electron.Tray(image); return tray; },
      Menu: { buildFromTemplate(items) { menu = electron.Menu.buildFromTemplate(items); return menu; } },
    };
    return load.call(this, request, parent, isMain);
  };
  try { require(wrapper); } finally { Module._load = load; }
  main = new BrowserWindow({ width: 420, height: 280, show: false, titleBarStyle: 'hidden', titleBarOverlay: { height: 51 }, webPreferences: { sandbox: true } });
  await main.loadFile(join(root, 'client/extracted/dist/renderer/index.html'));
  main.show();
  await waitFor(() => main.isVisible());
  assert.ok(tray && !tray.isDestroyed());
  assert.deepEqual(menu.items.filter(item => item.type !== 'separator').map(item => item.label), ['Reabrir OpenBot', 'Encerrar OpenBot']);
  main.on('closed', () => { closed = true; });
  // WM_CLOSE exercises the same native path as the title-bar X / Alt+F4.
  const handle = main.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
  await run('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class TrayCloseFixture { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }\'; if (-not [TrayCloseFixture]::PostMessage([IntPtr]::new(' + hwnd + '), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { exit 1 }'
  ], { windowsHide: true, timeout: 10000 });
  await waitFor(() => !main.isVisible());
  assert.equal(closed, false);
  menu.items[0].click();
  await waitFor(() => main.isVisible() && main.isFocused());
  assert.equal(await main.webContents.executeJavaScript('document.querySelector("#draft").value'), 'preserved');
  main.minimize();
  await waitFor(() => main.isMinimized());
  main.close();
  tray.emit('double-click');
  await waitFor(() => main.isVisible() && !main.isMinimized());
  main.close();
  app.emit('second-instance', {}, []);
  await waitFor(() => main.isVisible());
  const auxiliary = new BrowserWindow({ show: false });
  auxiliary.on('closed', () => { auxiliaryClosed = true; });
  auxiliary.close();
  await waitFor(() => auxiliaryClosed);
  app.on('before-quit', event => {
    quitPasses++;
    if (quitPasses === 1) {
      event.preventDefault();
      assert.equal(tray.isDestroyed(), false);
      setImmediate(() => app.quit());
    }
  });
  app.on('quit', () => {
    assert.equal(closed, true);
    assert.equal(tray.isDestroyed(), true);
    fs.writeFileSync(join(root, 'result.json'), JSON.stringify({ closed, auxiliaryClosed, quitPasses, trayDestroyed: tray.isDestroyed() }));
    clearTimeout(watchdog);
  });
  main.close();
  menu.items[2].click();
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
`;

describe.skipIf(process.platform !== "win32")("real Windows close-to-tray", () => {
  it("handles native close, real menu callbacks, restore and deferred normal quit with disposable state", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-tray-"));
    let pid: number | undefined;
    try {
      for (const folder of ["scripts", "assets", "client/extracted/dist/renderer", "client/extracted/dist/electron-main", "profile", "session", "logs", "roaming", "local", "temp"])
        mkdirSync(join(root, folder), { recursive: true });
      copyFileSync(join(repo, "scripts/openbot-electron.cjs"), join(root, "scripts/openbot-electron.cjs"));
      for (const icon of ["openbot.png", "openbot.ico"]) copyFileSync(join(repo, "assets", icon), join(root, "assets", icon));
      // Isolate the extracted app, not Electron APIs; no real gateway/bots/profile.
      writeFileSync(join(root, "client/extracted/dist/electron-main/main.cjs"), "");
      writeFileSync(join(root, "client/extracted/dist/renderer/index.html"), '<title>OpenBot tray fixture</title><input id="draft" value="preserved">');
      writeFileSync(join(root, "main.cjs"), fixture);
      const electron: unknown = createRequire(import.meta.url)("electron");
      if (typeof electron !== "string") throw new Error("Installed Electron executable is unavailable");
      await new Promise<void>((resolve, reject) => {
        const child = execFile(electron, [join(root, "main.cjs"), "--disable-gpu", "--no-first-run"], {
          // Do not launch with SW_HIDE: visibility is part of this gate.
          cwd: root, maxBuffer: 2 * 1024 * 1024,
          env: cleanE2eEnvironment({ APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"),
            TEMP: join(root, "temp"), TMP: join(root, "temp"), OPENBOT_RELEASE_ROOT: root }),
        }, (error, stdout, stderr) => {
          clearTimeout(timeout);
          pid = undefined;
          if (error) reject(new Error(`Tray fixture failed: ${error.message}\n${stdout}\n${stderr}`));
          else resolve();
        });
        pid = child.pid;
        const timeout = setTimeout(() => {
          if (pid != null) void execute("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(reject);
        }, 45000);
      });
      expect(JSON.parse(readFileSync(join(root, "result.json"), "utf8"))).toEqual({
        closed: true, auxiliaryClosed: true, quitPasses: 2, trayDestroyed: true,
      });
    } finally {
      if (pid != null) await execute("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60000);
});
