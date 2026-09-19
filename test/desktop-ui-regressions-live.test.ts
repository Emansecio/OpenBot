import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createPortServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { registerRpcHandlers } from "../src/rpc/index.js";
import { createMemoryTranscriptStore } from "../src/rpc/send.js";
import { Gateway } from "../src/server/gateway.js";
// @ts-expect-error Shared E2E helpers are native ESM scripts.
import { cleanE2eEnvironment, connectCdp } from "../scripts/e2e-runtime.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Real main/preload/renderer and native controls. Only gateway data is disposable.
const entry = String.raw`
const {app, screen} = require('electron');
let main, overlay;
const watchdog = setTimeout(() => app.exit(1), 60000);
watchdog.unref();
app.on('quit', () => clearTimeout(watchdog));
app.on('browser-window-created', (_, w) => {
  const set = w.setTitleBarOverlay.bind(w);
  w.setTitleBarOverlay = options => { overlay = options; return set(options); };
  w.webContents.on('did-finish-load', () => {
    if (w.webContents.getURL().includes('/renderer/index.html')) main = w;
  });
});
process.on('message', message => {
  if (message.type === 'quit') { app.quit(); return; }
  try {
    if (message.size) { main.unmaximize(); main.setBounds({x: 100, y: 80, width: message.size[0], height: message.size[1]}); }
    if (message.maximize) main.maximize();
    if (message.zoom) main.webContents.setZoomFactor(message.zoom);
    if (!main.isAlwaysOnTop()) { main.setAlwaysOnTop(true); main.focus(); }
    process.send({id: message.id, bounds: main.getBounds(), scale: screen.getDisplayMatching(main.getBounds()).scaleFactor, overlay});
  } catch (error) { process.send({id: message.id, error: String(error)}); }
});
require(BOOTSTRAP);
`;

async function freePort() {
  const server = createPortServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("No diagnostic port");
  return address.port;
}

async function configure(child: ChildProcess, options: object = {}) {
  const id = randomBytes(6).toString("hex");
  return new Promise<any>((resolve, reject) => {
    const listener = (message: any) => {
      if (message.id !== id) return;
      clearTimeout(timeout); child.off("message", listener);
      if (message.error) reject(new Error(message.error)); else resolve(message);
    };
    const timeout = setTimeout(() => { child.off("message", listener); reject(new Error("Window configuration timed out")); }, 5000);
    child.on("message", listener);
    child.send({ id, ...options });
  });
}

async function nativePixels(window: any) {
  const { bounds: b, scale } = window;
  const x = Math.round(b.x * scale), y = Math.round(b.y * scale), width = Math.round(b.width * scale);
  const command = `Add-Type -AssemblyName System.Drawing; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class OpenBotChromePixels { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'; [OpenBotChromePixels]::SetProcessDPIAware() | Out-Null; $b=New-Object Drawing.Bitmap ${width},80; $g=[Drawing.Graphics]::FromImage($b); try { $g.CopyFromScreen(${x},${y},0,0,$b.Size); $a=$b.GetPixel(${width - Math.round(170 * scale)},${Math.round(10 * scale)}); $c=$b.GetPixel(${width - Math.round(110 * scale)},${Math.round(10 * scale)}); [pscustomobject]@{header=@($a.R,$a.G,$a.B);controls=@($c.R,$c.G,$c.B)} | ConvertTo-Json -Compress } finally {$g.Dispose();$b.Dispose()}`;
  const result = await execute("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true, timeout: 15000 });
  return JSON.parse(result.stdout);
}

describe.skipIf(process.platform !== "win32")("desktop selection and native chrome regressions", () => {
  it("deletes the selected bot without stale messages and keeps settings clear of transparent native controls", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-ui-regressions-"));
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    const store = createMemoryTranscriptStore();
    const token = randomBytes(24).toString("base64url");
    const gateway = new Gateway({ gatewayToken: token, sseChannels: new Set(["agents", "agent-upserted", "transcript", "typing", "prompt-status", "settings"]) });
    const http = createServer(gateway.createHandler());
    let child: ChildProcess | undefined, cdp: any, logs = "";
    let startupError: Error | undefined;
    let exited: Promise<unknown> | undefined;
    try {
      config.update({ agents: [{ id: "diag-a", name: "Diag A", avatarId: "diag-a" }, { id: "diag-b", name: "Diag B", avatarId: "diag-b" }] });
      for (const id of ["diag-a", "diag-b"]) store.append(id, [{ kind: "message", id: `${id}-message`, role: "user", content: `MARKER_${id}`, timestampMs: Date.now() }]);
      registerRpcHandlers(gateway, { store, config });
      await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("No gateway port");
      const port = await freePort();
      for (const folder of ["roaming", "local", "profile", "data", "temp"]) mkdirSync(join(root, folder));
      writeFileSync(join(root, "entry.cjs"), entry.replace("BOOTSTRAP", JSON.stringify(join(repo, "scripts/openbot-electron.cjs"))));
      const electron: string = createRequire(import.meta.url)("electron");
      child = spawn(electron, ["--disable-gpu", "--no-sandbox", `--user-data-dir=${join(root, "profile")}`, `--remote-debugging-port=${port}`, join(root, "entry.cjs")], {
        cwd: repo, stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: cleanE2eEnvironment({ APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"),
          OPENBOT_USER_DATA: join(root, "profile"), OPENBOT_DATA_ROOT: join(root, "data"), OPENBOT_LOCAL_DATA_ROOT: join(root, "local"),
          SAND_USER_DATA_DIR: join(root, "profile"), SAND_DATA_ROOT: join(root, "data"), TEMP: join(root, "temp"), TMP: join(root, "temp"),
          OPENBOT_LOCAL_GATEWAY: "1", SAND_HOST_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
          SAND_HOST_GATEWAY_TOKEN: token, SAND_HOST_GATEWAY_NETWORK_TOKEN: token }),
      });
      exited = new Promise(resolve => child!.once("close", resolve));
      child.once("error", error => { startupError = error; });
      child.stdout!.on("data", data => { logs += data; }); child.stderr!.on("data", data => { logs += data; });
      let target;
      for (let i = 0; i < 150; i++) {
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
          target = targets.find(t => t.type === "page" && t.url.includes("/renderer/"));
        } catch { /* CDP not ready */ }
        if (target) break;
        if (startupError) throw startupError;
        if (child.exitCode != null || child.signalCode != null) throw new Error("Electron exited before renderer startup");
        await sleep(100);
      }
      if (!target) throw new Error("Renderer target missing");
      cdp = connectCdp(target.webSocketDebuggerUrl); await cdp.ready; await cdp.send("Runtime.enable");
      const evaluate = async (expression: string) => {
        const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result?.value;
      };
      const wait = async (expression: string) => {
        for (let i = 0; i < 100; i++) { const result = await evaluate(expression); if (result) return result; await sleep(100); }
        throw new Error(`Condition timed out: ${expression}`);
      };
      await wait("document.querySelectorAll('.sand-agent-item').length === 2");
      await evaluate(`document.querySelector('.sand-agent-item[data-agent-id="diag-b"]').click()`);
      await wait("document.body.innerText.includes('MARKER_diag-b')");
      const point = await evaluate(`(() => { const r = document.querySelector('.sand-agent-item[data-agent-id="diag-b"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, button: "right", clickCount: 1, ...point });
      const deleteItem = `[...document.querySelectorAll('[role="menuitem"]')].find(e => /^(Excluir|Delete)$/.test(e.innerText.trim()))`;
      await wait(`Boolean(${deleteItem})`); await evaluate(`(${deleteItem}).click()`);
      await wait("Boolean(document.querySelector('[role=alertdialog]'))");
      await evaluate(`[...document.querySelectorAll('[role=alertdialog] button')].find(e => /^(Excluir|Delete)$/.test(e.innerText.trim())).click()`);
      // No click on the survivor: header, selected row and transcript must agree by themselves.
      await wait("document.querySelectorAll('.sand-agent-item').length === 1 && document.body.innerText.includes('MARKER_diag-a')");
      expect(await evaluate("document.body.innerText.includes('MARKER_diag-b')")).toBe(false);
      expect(await evaluate("document.querySelector('.sand-chat-header').innerText")).toContain("Diag A");
      expect(await evaluate("document.querySelector('.sand-agent-item[aria-current=page]')?.dataset.agentId")).toBe("diag-a");
      expect(store.getAgentTranscriptTail("diag-a").entries).toMatchObject([{ content: "MARKER_diag-a" }]);

      let window = await configure(child, { size: [1040, 760], zoom: 1 });
      await evaluate("window.desktop.theme.set('dark')"); await sleep(250);
      const normal = await nativePixels(window);
      expect(normal.header).toEqual([7, 7, 7]); expect(normal.controls).toEqual(normal.header);
      await evaluate(`document.querySelector('button[aria-label="Abrir menu da conta"],button[aria-label="Open account menu"]').click()`);
      const settings = `[...document.querySelectorAll('[role=menuitem]')].find(e => /Configurações|Settings/.test(e.innerText))`;
      await wait(`Boolean(${settings})`); await evaluate(`(${settings}).click()`);
      await wait("Boolean(document.querySelector('.sand-settings-dialog'))"); await sleep(250);
      window = await configure(child);
      expect(window.overlay.color).toBe("#00000000");
      const modal = await nativePixels(window);
      expect(modal.header).toEqual([3, 3, 3]); expect(modal.controls).toEqual(modal.header);
      // This modal intentionally opens with initialFocus=-1. Focus a real control
      // before checking that resizing/zooming preserves interaction inside it.
      await evaluate("document.querySelector('.sand-settings-nav__item').focus()");
      expect(await evaluate("document.querySelector('.sand-settings-dialog').contains(document.activeElement)")).toBe(true);
      for (const options of [{ size: [1040, 760], zoom: 1 }, { size: [840, 600], zoom: 1.25 }, { maximize: true, zoom: 1 }]) {
        await configure(child, options); await sleep(250);
        const geometry = await evaluate(`(() => { const d = document.querySelector('.sand-settings-dialog'); const r = d.getBoundingClientRect(); const c = navigator.windowControlsOverlay.getTitlebarAreaRect(); return {top:r.top,bottom:r.bottom,caption:c.bottom,height:innerHeight,focused:d.contains(document.activeElement),active:document.activeElement?.className}; })()`);
        expect(geometry.caption).toBeGreaterThan(0);
        expect(geometry.top).toBeGreaterThanOrEqual(geometry.caption + 10);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
        expect(geometry.focused, JSON.stringify(geometry)).toBe(true);
      }
      await configure(child, { size: [1040, 760], zoom: 1 });
      await evaluate("window.desktop.theme.set('light')"); await sleep(250);
      window = await configure(child);
      expect(window.overlay.color).toBe("#00000000");
      const light = await nativePixels(window);
      expect(light.controls).toEqual(light.header);
      for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await wait("!document.querySelector('.sand-settings-dialog')");
      expect(await evaluate("document.body.innerText.includes('MARKER_diag-a')")).toBe(true);
    } catch (error) {
      throw new Error(`${String(error)}\n${logs.slice(-5000)}`, { cause: error });
    } finally {
      cdp?.close();
      if (child?.connected) child.send({ type: "quit" });
      if (exited) await Promise.race([exited, sleep(3000)]);
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }).catch(() => undefined);
        if (exited) await Promise.race([exited, sleep(3000)]);
      }
      gateway.close(); http.closeAllConnections();
      if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
      config.close();
      if (child?.pid && child.exitCode === null && child.signalCode === null) throw new Error(`Fixture did not exit; state retained at ${root}`);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 120000);
});
