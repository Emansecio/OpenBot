import { readFileSync } from "node:fs";
import { link, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsp from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserSessionManager,
  type BrowserHostProcess,
} from "../src/browser/browser-session-manager.js";
import type { EgressProxy } from "../src/browser/egress-proxy.js";
import { encodeBrowserFrame } from "../src/browser/protocol.js";
import { PassThrough, Writable } from "node:stream";
import { loadBrowserHost, type BrowserHostHarnessOptions } from "./helpers/browser-host.js";

const PROXY_TOKEN = "p".repeat(43);
const PROXY_ENV = {
  OPENBOT_BROWSER_PROXY_URL: "http://127.0.0.1:32123",
  OPENBOT_BROWSER_PROXY_TOKEN: PROXY_TOKEN,
};
const PARTITION = "persist:openbot-agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function hostWith(options: BrowserHostHarnessOptions = {}) {
  return loadBrowserHost({ ...options, env: { ...PROXY_ENV, ...options.env } });
}

class ReadyHost implements BrowserHostProcess {
  readonly stdout = new PassThrough();
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.frames.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      const request = JSON.parse(chunk.toString()) as { id: string; tabId: string; command: { command: string } };
      queueMicrotask(() => this.stdout.write(encodeBrowserFrame({
        protocolVersion: 1,
        kind: "response",
        id: request.id,
        ok: true,
        result: { command: request.command.command, tabId: request.tabId },
      })));
      callback();
    },
  });
  readonly frames: Array<Record<string, unknown>> = [];
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  constructor() {
    queueMicrotask(() => this.stdout.write(encodeBrowserFrame({ protocolVersion: 1, kind: "ready", hostVersion: "test" })));
  }

  kill(): void {
    for (const listener of this.exitListeners) listener(0, null);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }
}

/** A downloads root inside a temporary managed base, as the host validates it. */
async function downloadFixture(env: Record<string, string> = {}) {
  const base = await tempRoot("openbot-host-downloads-");
  const root = join(base, "agent-a", "Downloads");
  await mkdir(root, { recursive: true });
  const cleanupCalls: string[] = [];
  const harness = hostWith({
    env: { OPENBOT_BROWSER_DOWNLOADS_ROOT: base, OPENBOT_BROWSER_MAX_DOWNLOAD_BYTES: "1024", ...env },
    modules: { "node:fs/promises": { ...fsp, rm: async (target: string) => { cleanupCalls.push(target); } } },
  });
  const config = { root, realBase: await realpath(base), relation: join("agent-a", "Downloads"), tabId: "tab-a", downloads: 0, bytes: 0 };
  return { harness, config, base, root, cleanupCalls };
}

function downloadItem(expectedBytes: number, filename = "report.txt") {
  const cancelCalls: string[] = [];
  const savePaths: string[] = [];
  let receivedBytes = 0;
  let updated: ((event: unknown, state: string) => void) | undefined;
  let done: ((event: unknown, state: string) => void) | undefined;
  return {
    cancelCalls,
    savePaths,
    advance: (value: number) => {
      receivedBytes = value;
      updated?.({}, "progressing");
    },
    finish: (state: string) => done?.({}, state),
    value: {
      getFilename: () => filename,
      getTotalBytes: () => expectedBytes,
      getReceivedBytes: () => receivedBytes,
      setSavePath: (value: string) => savePaths.push(value),
      cancel: () => cancelCalls.push("cancelled"),
      on: (_event: string, handler: (event: unknown, state: string) => void) => { updated = handler; },
      once: (_event: string, handler: (event: unknown, state: string) => void) => { done = handler; },
    },
  };
}

const settle = () => new Promise((resolveImmediate) => setImmediate(resolveImmediate));

describe("browser security wiring", () => {
  it("retries only transient compositor capture failures within the existing bound", async () => {
    const { host } = hostWith();
    let calls = 0;
    const resized: unknown[] = [];
    const frame = {
      getSize: () => ({ width: 10, height: 10 }),
      resize: (size: unknown) => { resized.push(size); return frame; },
      toPNG: () => Buffer.from("png"),
    };
    const window = { webContents: { capturePage: async () => {
      if (++calls === 1) throw new Error("UnknownVizError");
      return frame;
    } } };
    await expect(host.captureViewport(window)).resolves.toMatchObject({ mimeType: "image/png", width: 10, height: 10 });
    expect(calls).toBe(2);
    // High-DPI captures are normalized to window coordinates before encoding.
    expect(resized).toEqual([{ width: 10, height: 10, quality: "better" }]);
    calls = 0;
    window.webContents.capturePage = async () => { calls++; throw new Error("UnknownVizError"); };
    await expect(host.captureViewport(window)).rejects.toThrow("UnknownVizError");
    expect(calls).toBe(5);
    calls = 0;
    window.webContents.capturePage = async () => { calls++; throw new Error("destroyed"); };
    await expect(host.captureViewport(window)).rejects.toThrow("destroyed");
    expect(calls).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(host.captureViewport(window, controller.signal)).rejects.toMatchObject({ code: "BROWSER_COMMAND_ABORTED" });
    expect(calls).toBe(1);
  });

  it("starts the authenticated proxy before the host and keeps proxy credentials out of frames", async () => {
    const lifecycle: string[] = [];
    const launchOptions: Array<Record<string, unknown>> = [];
    const host = new ReadyHost();
    const proxy = {
      address: null,
      start: async () => {
        lifecycle.push("proxy");
        return { host: "127.0.0.1", port: 32123, token: PROXY_TOKEN };
      },
      close: async () => undefined,
    } as unknown as EgressProxy;
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\workspaces",
      egressProxy: proxy,
      launchHost: (options) => {
        lifecycle.push("host");
        launchOptions.push(options as unknown as Record<string, unknown>);
        return host;
      },
    });
    const lease = await manager.acquire("agent-a");
    await manager.open(lease, "https://example.com/");
    expect(launchOptions[0]?.proxyUrl).toBe("http://127.0.0.1:32123");
    expect(launchOptions[0]?.proxyToken).toBe(PROXY_TOKEN);
    expect(launchOptions[0]?.userDataRoot).toMatch(/browser-user-data|[\\/]browser[\\/]/iu);
    expect(launchOptions[0]?.maxDownloadBytes).toBe(1024 * 1024);
    expect(lifecycle).toEqual(["proxy", "host"]);
    expect(host.frames.length).toBeGreaterThan(0);
    const launchedProxyUrl = String(launchOptions[0]?.proxyUrl);
    const launchedProxyToken = String(launchOptions[0]?.proxyToken);
    for (const frame of host.frames) {
      expect(frame).not.toHaveProperty("proxyUrl");
      expect(frame).not.toHaveProperty("proxyToken");
      expect(JSON.stringify(frame)).not.toContain(launchedProxyToken);
      expect(JSON.stringify(frame)).not.toContain(launchedProxyUrl);
    }
    await manager.close();
  });

  it("requires a per-agent Downloads resolver to stay inside the managed root", async () => {
    const manager = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\workspaces",
      resolveDownloadRoot: (agentId) => `C:\\Temp\\OpenBot\\workspaces\\${agentId}\\Downloads`,
      launchHost: () => new ReadyHost(),
    });
    await expect(manager.acquire("agent-a")).resolves.toMatchObject({
      downloadRoot: "C:\\Temp\\OpenBot\\workspaces\\agent-a\\Downloads",
    });
    await manager.close();

    const unsafe = new BrowserSessionManager({
      downloadsRoot: "C:\\Temp\\OpenBot\\workspaces",
      resolveDownloadRoot: () => "C:\\Temp\\Outside\\Downloads",
      launchHost: () => new ReadyHost(),
    });
    await expect(unsafe.acquire("agent-a")).rejects.toMatchObject({ code: "BROWSER_DOWNLOAD_ROOT_INVALID" });
    await unsafe.close();
  });

  it("enforces proxy, scheme, permission and popup rules in the host", async () => {
    const { app, host } = hostWith();
    expect(app.switches).toEqual([
      ["disable-quic"],
      ["disable-features", "DnsOverHttps,UseDnsHttpsSvcbAlpn,AsyncDns,EncryptedClientHello,CalculateNativeWinOcclusion"],
      ["force-webrtc-ip-handling-policy", "disable_non_proxied_udp"],
      ["disable-smooth-scrolling"],
    ]);
    const login = app.handlers.get("login")!;
    const credentials: unknown[][] = [];
    login({ preventDefault: () => undefined }, null, null, { isProxy: true, host: "127.0.0.1", port: 32123 }, (...values: unknown[]) => credentials.push(values));
    login({ preventDefault: () => undefined }, null, null, { isProxy: false, host: "example.com", port: 443 }, (...values: unknown[]) => credentials.push(values));
    expect(credentials).toEqual([["openbot", PROXY_TOKEN], []]);
    const certificateChoices: unknown[][] = [];
    let certificatePrevented = false;
    app.handlers.get("select-client-certificate")!({ preventDefault: () => { certificatePrevented = true; } }, null, "https://mtls.example/", [{ subjectName: "user" }],
      (...values: unknown[]) => certificateChoices.push(values));
    expect(certificatePrevented).toBe(true);
    expect(certificateChoices).toEqual([[]]);

    const permissionResults: boolean[] = [];
    const chooserDecisions: string[] = [];
    const proxySettings: unknown[] = [];
    const requestHandlers: Array<(details: { url: string; resourceType: string }, callback: (result: { cancel: boolean }) => void) => void> = [];
    const browserSession = {
      setProxy: async (value: unknown) => { proxySettings.push(value); },
      setPermissionRequestHandler: (handler: (_contents: unknown, _permission: string, callback: (allowed: boolean) => void) => void) => {
        handler({}, "camera", (allowed) => permissionResults.push(allowed));
      },
      setPermissionCheckHandler: (handler: () => boolean) => permissionResults.push(handler()),
      setDevicePermissionHandler: (handler: () => boolean) => permissionResults.push(handler()),
      on: (event: string, handler: (event: { preventDefault(): void }, details: unknown, callback: (...values: unknown[]) => void) => void) => {
        handler({ preventDefault: () => chooserDecisions.push(`${event}:prevented`) }, {}, (...values) => chooserDecisions.push(`${event}:${values.length}`));
      },
      webRequest: {
        onBeforeRequest: (_filter: unknown, handler: typeof requestHandlers[number]) => requestHandlers.push(handler),
      },
    };
    await expect(host.secureBrowserSession(browserSession)).resolves.toBeUndefined();
    expect(proxySettings).toEqual([{ mode: "fixed_servers", proxyRules: "http=127.0.0.1:32123;https=127.0.0.1:32123", proxyBypassRules: "<-loopback>" }]);
    expect(permissionResults).toEqual([false, false, false]);
    const decisions: boolean[] = [];
    requestHandlers[0]?.({ url: "https://example.com", resourceType: "mainFrame" }, ({ cancel }) => decisions.push(cancel));
    requestHandlers[0]?.({ url: "file:///etc/passwd", resourceType: "mainFrame" }, ({ cancel }) => decisions.push(cancel));
    requestHandlers[0]?.({ url: "wss://example.com/socket", resourceType: "webSocket" }, ({ cancel }) => decisions.push(cancel));
    expect(decisions).toEqual([false, true, false]);
    expect(chooserDecisions).toEqual([
      "select-hid-device:prevented", "select-hid-device:0",
      "select-serial-port:prevented", "select-serial-port:0",
      "select-usb-device:prevented", "select-usb-device:0",
    ]);

    const contentHandlers = new Map<string, (event: { preventDefault(): void }, ...args: unknown[]) => void>();
    let popupHandler: ((details?: { url: string }) => { action: string }) | undefined;
    const sameTabLoads: string[] = [];
    host.attachWindowSecurity({
      webContents: {
        setWindowOpenHandler: (handler: (details?: { url: string }) => { action: string }) => { popupHandler = handler; },
        on: (event: string, handler: (event: { preventDefault(): void }, ...args: unknown[]) => void) => contentHandlers.set(event, handler),
        isDestroyed: () => false,
        loadURL: async (url: string) => { sameTabLoads.push(url); },
      },
    });
    expect(popupHandler?.()).toEqual({ action: "deny" });
    expect(popupHandler?.({ url: "https://accounts.example/login" })).toEqual({ action: "deny" });
    expect(popupHandler?.({ url: "file:///C:/Windows/win.ini" })).toEqual({ action: "deny" });
    await settle();
    expect(sameTabLoads).toEqual(["https://accounts.example/login"]);
    const prevented: string[] = [];
    contentHandlers.get("will-attach-webview")?.({ preventDefault: () => prevented.push("webview") });
    contentHandlers.get("will-navigate")?.({ preventDefault: () => prevented.push("scheme") }, "file:///etc/passwd");
    contentHandlers.get("will-prevent-unload")?.({ preventDefault: () => prevented.push("unload-veto") });
    const bluetoothChoices: unknown[] = [];
    contentHandlers.get("select-bluetooth-device")?.({ preventDefault: () => prevented.push("bluetooth") }, [{ deviceId: "nearby" }],
      (deviceId: unknown) => bluetoothChoices.push(deviceId));
    expect(prevented).toEqual(["webview", "scheme", "unload-veto", "bluetooth"]);
    expect(bluetoothChoices).toEqual([""]);
  });

  it("enforces the per-file download limit, removes failed files and reports each outcome", async () => {
    const { harness, config, root, cleanupCalls } = await downloadFixture();
    const report = join(root, "report.txt");
    const item = downloadItem(1025);
    harness.host.handleWillDownload(config, item.value);
    expect(item.cancelCalls).toHaveLength(1);
    expect(item.savePaths).toEqual([report]);
    item.finish("cancelled");
    await settle();
    expect(cleanupCalls).toEqual([report]);
    const streamedItem = downloadItem(0);
    harness.host.handleWillDownload(config, streamedItem.value);
    streamedItem.advance(1025);
    expect(streamedItem.cancelCalls).toHaveLength(1);
    streamedItem.finish("cancelled");
    await settle();
    expect(cleanupCalls).toEqual([report, report]);
    const completedItem = downloadItem(1024);
    harness.host.handleWillDownload(config, completedItem.value);
    completedItem.advance(1024);
    completedItem.finish("completed");
    await settle();
    expect(completedItem.cancelCalls).toHaveLength(0);
    expect(cleanupCalls).toHaveLength(2);
    expect(harness.frames).toEqual([
      expect.objectContaining({ kind: "event", event: "download", path: report, state: "limit" }),
      expect.objectContaining({ kind: "event", event: "download", path: report, state: "limit" }),
      expect.objectContaining({ kind: "event", event: "download", path: report, state: "completed", bytes: 1024 }),
    ]);
    // The save path is reserved while in flight and released when done.
    expect(harness.host.RESERVED_DOWNLOAD_PATHS.size).toBe(0);
  });

  it("caps downloads per tab and per session and re-checks the download root", async () => {
    // Per-file limit 150 MB so the 200 MB session budget binds first.
    const { harness, config, root } = await downloadFixture({ OPENBOT_BROWSER_MAX_DOWNLOAD_BYTES: String(150 * 1024 * 1024) });
    const first = downloadItem(0);
    harness.host.handleWillDownload(config, first.value);
    expect(harness.host.RESERVED_DOWNLOAD_PATHS.has(join(root, "report.txt").toLowerCase())).toBe(true);
    first.advance(150 * 1024 * 1024);
    first.finish("completed");
    await settle();
    const second = downloadItem(0);
    harness.host.handleWillDownload(config, second.value);
    second.advance(60 * 1024 * 1024);
    // 150 MB committed + 60 MB in flight exceeds the 200 MB session budget
    // although each file is under the per-file limit.
    expect(second.cancelCalls).toHaveLength(1);
    second.finish("cancelled");
    await settle();

    for (let index = config.downloads; index < 20; index += 1) {
      const allowed = downloadItem(1, `file-${index}.txt`);
      harness.host.handleWillDownload(config, allowed.value);
      expect(allowed.savePaths).toHaveLength(1);
    }
    const overCount = downloadItem(1);
    harness.host.handleWillDownload(config, overCount.value);
    expect(overCount.cancelCalls).toHaveLength(1);
    expect(overCount.savePaths).toHaveLength(0);

    // Replacing Downloads with a junction after the tab opened cancels saves.
    const swapped = await downloadFixture();
    const elsewhere = join(swapped.base, "elsewhere");
    await mkdir(elsewhere);
    await rm(swapped.root, { recursive: true, force: true });
    await symlink(elsewhere, swapped.root, process.platform === "win32" ? "junction" : "dir");
    const redirected = downloadItem(1);
    swapped.harness.host.handleWillDownload(swapped.config, redirected.value);
    expect(redirected.cancelCalls).toHaveLength(1);
    expect(redirected.savePaths).toHaveLength(0);

    const unknownTab = downloadItem(1);
    swapped.harness.host.handleWillDownload(undefined, unknownTab.value);
    expect(unknownTab.cancelCalls).toHaveLength(1);
  });

  it("gives a concurrent same-named download a different path and keeps extensions on long names", () => {
    const { host } = hostWith({ env: { OPENBOT_BROWSER_DOWNLOADS_ROOT: "C:\\Missing" } });
    const first = host.uniqueDownloadPath("C:\\Missing\\Downloads", "report.pdf");
    host.RESERVED_DOWNLOAD_PATHS.add(first.toLowerCase());
    expect(first).toBe("C:\\Missing\\Downloads\\report.pdf");
    expect(host.uniqueDownloadPath("C:\\Missing\\Downloads", "report.pdf")).toBe("C:\\Missing\\Downloads\\report (1).pdf");

    const long = host.safeFilename(`${"a".repeat(300)}.pdf`);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(180);
    expect(host.safeFilename("con.txt")).toBe("_con.txt");
    expect(host.safeFilename("invoice.pdf. ")).toBe("invoice.pdf");
    const astral = host.safeFilename(`${"😀".repeat(200)}.txt`);
    expect(astral.length).toBeLessThanOrEqual(180);
    expect(astral).not.toContain("\uFFFD");
    expect(astral.endsWith(".txt")).toBe(true);
  });

  it("skips page copy handlers and clears the selection unless the user holds a handoff", () => {
    const source = readFileSync(new URL("../scripts/openbot-browser-preload.cjs", import.meta.url), "utf8");
    const listeners = new Map<string, { handler: (event: unknown) => void; capture: unknown }>();
    let allowed = false;
    const effects: string[] = [];
    const window = {
      addEventListener: (type: string, handler: (event: unknown) => void, capture: unknown) => listeners.set(type, { handler, capture }),
      getSelection: () => ({ removeAllRanges: () => effects.push("selection-cleared") }),
    };
    const document = {
      activeElement: { selectionEnd: 7, setSelectionRange: (start: number, end: number) => effects.push(`range:${start}-${end}`) },
    };
    new Function("require", "window", "document", source)(
      (id: string) => {
        if (id !== "electron") throw new Error(`unexpected module ${id}`);
        return { ipcRenderer: { sendSync: (channel: string) => channel === "openbot:clipboard-write-allowed" && allowed } };
      },
      window,
      document,
    );
    expect([...listeners.keys()]).toEqual(["copy", "cut"]);
    expect(listeners.get("copy")?.capture).toBe(true);
    const event = {
      stopImmediatePropagation: () => effects.push("page-handlers-skipped"),
      preventDefault: () => effects.push("cancelled"),
    };
    listeners.get("copy")!.handler(event);
    // Not cancelled: a cancelled copy event would write the page's data.
    expect(effects).toEqual(["page-handlers-skipped", "range:7-7", "selection-cleared"]);

    effects.length = 0;
    allowed = true;
    listeners.get("cut")!.handler(event);
    expect(effects).toEqual([]);
  });

  it("never exposes typed secrets in snapshot element names and re-bounds page results", async () => {
    const { host } = hostWith();
    const elements = await host.readInteractiveElements(snapshotWindow([
      fakeInput({ type: "password", value: "hunter2" }),
      fakeInput({ type: "text", value: "4111 1111 1111 1111", autocomplete: "cc-number" }),
      fakeInput({ type: "text", value: "123456", autocomplete: "one-time-code", placeholder: "Code" }),
      fakeInput({ type: "text", value: "visible draft" }),
    ]));
    expect(elements.map((element: { name: string }) => element.name)).toEqual(["", "", "Code", "visible draft"]);
    expect(JSON.stringify(elements)).not.toMatch(/hunter2|4111|123456/u);

    expect(host.sanitizeElements([
      { id: "ob-el-1", role: "r".repeat(500), name: "n".repeat(10_000), x: 1e12, y: -1e12, width: 3.6, height: 2 },
      { id: "<script>", role: "button", name: "", x: 1, y: 1, width: 1, height: 1 },
      { id: "ob-el-2", role: "button", name: "ok", x: Number.NaN, y: 1, width: 1, height: 1 },
      "not an element",
    ])).toEqual([{ id: "ob-el-1", role: "r".repeat(64), name: "n".repeat(256), x: 100_000, y: -100_000, width: 4, height: 2 }]);
  });

  it("wires session and window security at the production tab creation call site before navigation", async () => {
    const base = await tempRoot("openbot-host-open-");
    const order: string[] = [];
    let currentUrl = "about:blank";
    let visible = false;
    const session = {
      setProxy: async () => { order.push("session-security"); },
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      setDevicePermissionHandler: () => undefined,
      on: () => undefined,
      webRequest: { onBeforeRequest: () => undefined },
    };
    const window = {
      webContents: {
        id: 7,
        session,
        getURL: () => currentUrl,
        getTitle: () => "test",
        on: () => undefined,
        once: () => undefined,
        removeListener: () => undefined,
        setWindowOpenHandler: () => { order.push("window-security"); },
      },
      isDestroyed: () => false,
      isVisible: () => visible,
      destroy: () => undefined,
      loadURL: async (url: string) => { order.push("navigation"); currentUrl = url; },
      show: () => { order.push("show"); visible = true; },
      showInactive: () => { order.push("show-inactive"); visible = true; },
      focus: () => { order.push("focus"); },
      on: () => undefined,
    };
    const { host } = hostWith({
      env: { OPENBOT_BROWSER_DOWNLOADS_ROOT: base },
      electron: { BrowserWindow: class { constructor() { return window; } } },
    });

    await host.openTab({
      tabId: "tab-a",
      agentId: "agent-a",
      sessionId: "session-a",
      partition: PARTITION,
      downloadRoot: join(base, "agent-a", "Downloads"),
      command: { command: "open", url: "https://example.com/" },
    }, new AbortController().signal);

    // Agent tabs appear behind the user's windows; only a handoff focuses.
    expect(order).toEqual(["session-security", "window-security", "navigation", "show-inactive"]);
  });

  it("captures the WebContents id before the window closed callback", async () => {
    const base = await tempRoot("openbot-host-closed-");
    const windowHandlers = new Map<string, () => void>();
    let willDownload: ((event: unknown, item: unknown, webContents: { id: number }) => void) | undefined;
    let destroyed = false;
    const window = {
      webContents: {
        get id() { if (destroyed) throw new Error("destroyed WebContents"); return 71; },
        session: {
          setProxy: async () => undefined,
          setPermissionRequestHandler: () => undefined,
          setPermissionCheckHandler: () => undefined,
          on: (event: string, handler: typeof willDownload) => { if (event === "will-download") willDownload = handler; },
          webRequest: { onBeforeRequest: () => undefined },
        },
        on: () => undefined,
        setWindowOpenHandler: () => undefined,
      },
      isDestroyed: () => destroyed,
      on: (event: string, handler: () => void) => { windowHandlers.set(event, handler); },
    };
    const { host } = hostWith({
      env: { OPENBOT_BROWSER_DOWNLOADS_ROOT: base },
      electron: { BrowserWindow: class { constructor() { return window; } } },
    });
    await host.createTab({
      tabId: "tab-a",
      agentId: "agent-a",
      sessionId: "session-a",
      partition: PARTITION,
      downloadRoot: join(base, "agent-a", "Downloads"),
    }, new AbortController().signal);
    expect(host.TABS.has("tab-a")).toBe(true);

    destroyed = true;
    expect(() => windowHandlers.get("closed")?.()).not.toThrow();
    expect(host.TABS.has("tab-a")).toBe(false);
    // The tab's download config went away with it: a late download is refused.
    const late = downloadItem(1);
    willDownload?.({}, late.value, { id: 71 });
    expect(late.cancelCalls).toHaveLength(1);
  });

  it("enforces the production full-page screenshot dimension, pixel, and byte boundaries", async () => {
    const { host } = hostWith({
      electron: { nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 2, height: 3 }) }) } },
    });
    const commands: Array<{ command: string; parameters: Record<string, unknown> }> = [];
    const detached: string[] = [];
    const window = fullPageWindow({ width: 8192, height: 1, deviceScaleFactor: 1 }, commands, detached);
    await expect(host.captureFullPage(window)).resolves.toMatchObject({ mimeType: "image/png", width: 2, height: 3 });
    expect(commands).toEqual([{
      command: "Page.captureScreenshot",
      parameters: expect.objectContaining({ captureBeyondViewport: true, clip: { x: 0, y: 0, width: 8192, height: 1, scale: 1 } }),
    }]);
    expect(detached).toEqual(["detached"]);

    const oversizedCommands: typeof commands = [];
    await expect(host.captureFullPage(fullPageWindow({ width: 8193, height: 1, deviceScaleFactor: 1 }, oversizedCommands, [])))
      .rejects.toMatchObject({ code: "BROWSER_SCREENSHOT_LIMIT" });
    expect(oversizedCommands).toHaveLength(0);

    await expect(host.captureFullPage(fullPageWindow({ width: 4096, height: 4096, deviceScaleFactor: 1 }, [], [])))
      .resolves.toMatchObject({ mimeType: "image/png" });
    await expect(host.captureFullPage(fullPageWindow({ width: 4097, height: 4096, deviceScaleFactor: 1 }, [], [])))
      .rejects.toMatchObject({ code: "BROWSER_SCREENSHOT_LIMIT" });

    await expect(host.captureFullPage(fullPageWindow({ width: 2, height: 3, deviceScaleFactor: 1 }, [], [], 5 * 1024 * 1024)))
      .resolves.toMatchObject({ mimeType: "image/png" });
    await expect(host.captureFullPage(fullPageWindow({ width: 2, height: 3, deviceScaleFactor: 1 }, [], [], 5 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ code: "BROWSER_SCREENSHOT_LIMIT" });
  });

  it("truncates visible text without splitting a non-BMP UTF-8 character", async () => {
    const { host } = hostWith();
    const prefix = "a".repeat(128 * 1024 - 1);
    const result = await host.readVisibleText({
      webContents: { executeJavaScriptInIsolatedWorld: async () => `${prefix}😀` },
    }, new AbortController().signal);

    expect(result).toBe(prefix);
    expect(result).not.toContain("�");
    expect(Buffer.byteLength(result, "utf8")).toBe(128 * 1024 - 1);
  });

  it("uploads only a bounded home file through the DOM file input", async () => {
    const home = await tempRoot("openbot-host-upload-");
    await mkdir(join(home, "Documents"));
    await writeFile(join(home, "Documents", "report.txt"), "safe");
    const { host } = hostWith();
    const input = { type: "file", files: undefined as unknown, events: [] as string[], dispatchEvent(event: { type: string }) { this.events.push(event.type); } };
    host.TABS.set("tab-a", { window: uploadWindow(input), agentId: "agent-a", sessionId: "session-a", partition: PARTITION });
    await expect(host.uploadTab({
      agentId: "agent-a",
      sessionId: "session-a",
      partition: PARTITION,
      homeRoot: home,
      tabId: "tab-a",
      command: { selector: "#upload", path: "Documents/report.txt" },
    }, new AbortController().signal)).resolves.toMatchObject({ upload: { fileName: "report.txt", bytes: 4 } });
    expect(input.events).toEqual(["input", "change"]);
    expect(input.files).toMatchObject({ files: [expect.objectContaining({ name: "report.txt", size: 4 })] });

    await writeFile(join(home, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(host.readUploadFile(home, "large.bin")).rejects.toMatchObject({ code: "BROWSER_UPLOAD_FILE_TOO_LARGE" });
  });

  it("rejects a hardlink inside the home before reading the outside file", async () => {
    const root = await tempRoot("openbot-browser-hardlink-");
    const home = join(root, "home");
    const documents = join(home, "Documents");
    const outside = join(root, "outside-secret.txt");
    const inside = join(documents, "report.txt");
    await mkdir(documents, { recursive: true });
    await writeFile(outside, "secret outside home");
    await link(outside, inside);

    await expect(hostWith().host.readUploadFile(home, "Documents/report.txt")).rejects.toMatchObject({
      code: "BROWSER_UPLOAD_HARDLINK_UNSAFE",
      message: expect.not.stringContaining(outside),
    });
  });

  it("rejects a home path that is swapped to an external reparse target after validation", async () => {
    const root = await tempRoot("openbot-browser-upload-race-");
    const home = join(root, "home");
    const documents = join(home, "Documents");
    const outside = join(root, "outside");
    const outsideFile = join(outside, "report.txt");
    const inside = join(documents, "report.txt");
    await mkdir(documents, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(inside, "safe inside home");
    await writeFile(outsideFile, "secret outside home");

    const realOpen = fsp.open;
    const swappingFsp = {
      ...fsp,
      open: async (filename: Parameters<typeof fsp.open>[0], ...args: Parameters<typeof fsp.open> extends [unknown, ...infer Rest] ? Rest : never) => {
        await rm(documents, { recursive: true, force: true });
        await symlink(outside, documents, process.platform === "win32" ? "junction" : "dir");
        return realOpen(filename, ...args);
      },
    } as typeof fsp;
    const { host } = hostWith({ modules: { "node:fs/promises": swappingFsp } });

    await expect(host.readUploadFile(home, "Documents/report.txt")).rejects.toMatchObject({
      code: "BROWSER_UPLOAD_PATH_CHANGED",
    });
  });

  it("reads a stable regular home file through the opened handle", async () => {
    const root = await tempRoot("openbot-browser-upload-stable-");
    const home = join(root, "home");
    const documents = join(home, "Documents");
    await mkdir(documents, { recursive: true });
    await writeFile(join(documents, "report.txt"), "safe inside home");

    await expect(hostWith().host.readUploadFile(home, "Documents/report.txt")).resolves.toMatchObject({
      bytes: 16,
      dataBase64: Buffer.from("safe inside home").toString("base64"),
    });
  });

  it("clears the navigation timeout after a successful load", async () => {
    const scheduled = { id: 1 };
    const clearCalls: unknown[] = [];
    const { host } = hostWith({ setTimeout: () => scheduled, clearTimeout: (timer: unknown) => clearCalls.push(timer) });

    await expect(host.loadUrl(navigationWindow(async () => "loaded"), "https://example.com/")).resolves.toBeUndefined();
    expect(clearCalls).toEqual([scheduled]);
  });

  it("clears the navigation timeout when a load fails", async () => {
    const scheduled = { id: 2 };
    const clearCalls: unknown[] = [];
    const { host } = hostWith({ setTimeout: () => scheduled, clearTimeout: (timer: unknown) => clearCalls.push(timer) });

    await expect(host.loadUrl(navigationWindow(async () => { throw new Error("navigation failed"); }), "https://example.com/"))
      .rejects.toThrow("navigation failed");
    expect(clearCalls).toEqual([scheduled]);
  });
});

function navigationWindow(loadURL: (url: string) => Promise<unknown>): unknown {
  return { loadURL, webContents: { once: () => undefined, removeListener: () => undefined } };
}

function fullPageWindow(
  metrics: { width: number; height: number; deviceScaleFactor: number },
  commands: Array<{ command: string; parameters: Record<string, unknown> }>,
  detached: string[],
  payloadBytes = 3,
): unknown {
  return {
    webContents: {
      executeJavaScriptInIsolatedWorld: async () => metrics,
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        detach: () => detached.push("detached"),
        sendCommand: async (command: string, parameters: Record<string, unknown>) => {
          commands.push({ command, parameters });
          return { data: Buffer.alloc(payloadBytes).toString("base64") };
        },
      },
    },
  };
}

function uploadWindow(input: { type: string; files: unknown; dispatchEvent(event: { type: string }): void }): unknown {
  class FakeInput {}
  Object.setPrototypeOf(input, FakeInput.prototype);
  class FakeFile {
    readonly size: number;
    constructor(_parts: unknown[], readonly name: string) {
      this.size = (_parts[0] as Uint8Array).byteLength;
    }
  }
  class FakeDataTransfer {
    readonly files: { files: FakeFile[] } = { files: [] };
    readonly items = { add: (file: FakeFile) => this.files.files.push(file) };
  }
  return {
    webContents: {
      getURL: () => "https://example.com/",
      getTitle: () => "Example",
      executeJavaScript: async (source: string) => new Function(
        "document",
        "HTMLInputElement",
        "File",
        "DataTransfer",
        "Event",
        "atob",
        `return ${source}`,
      )(
        { querySelector: () => input },
        FakeInput,
        FakeFile,
        FakeDataTransfer,
        class { constructor(readonly type: string) {} },
        (value: string) => Buffer.from(value, "base64").toString("binary"),
      ),
    },
  };
}

interface FakeInputOptions { type: string; value: string; autocomplete?: string; placeholder?: string }

class FakeHTMLInputElement {
  readonly tagName = "INPUT";
  readonly innerText = "";
  constructor(private readonly options: FakeInputOptions) {}
  get type(): string { return this.options.type; }
  get value(): string { return this.options.value; }
  getAttribute(name: string): string | null {
    if (name === "type") return this.options.type;
    if (name === "autocomplete") return this.options.autocomplete ?? null;
    if (name === "placeholder") return this.options.placeholder ?? null;
    return null;
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
}

function fakeInput(options: FakeInputOptions): FakeHTMLInputElement {
  return new FakeHTMLInputElement(options);
}

/** A window whose isolated-world script runs against a small fake DOM. */
function snapshotWindow(elements: FakeHTMLInputElement[]): unknown {
  return {
    webContents: {
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: Array<{ code: string }>) => new Function(
        "document", "getComputedStyle", "HTMLInputElement", "window", "globalThis", `return ${scripts[0]!.code}`,
      )(
        { querySelectorAll: () => elements },
        () => ({ display: "block", visibility: "visible", opacity: "1" }),
        FakeHTMLInputElement,
        { innerHeight: 800, innerWidth: 1280 },
        {},
      ),
    },
  };
}
