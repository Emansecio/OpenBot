import { readFileSync } from "node:fs";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BrowserSessionManager,
  type BrowserHostProcess,
} from "../src/browser/browser-session-manager.js";
import type { EgressProxy } from "../src/browser/egress-proxy.js";
import { encodeBrowserFrame } from "../src/browser/protocol.js";
import { PassThrough, Writable } from "node:stream";

const HOST_SOURCE = readFileSync(new URL("../scripts/openbot-browser-host.cjs", import.meta.url), "utf8");

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

describe("browser security wiring", () => {
  it("retries only transient compositor capture failures within the existing bound", async () => {
    const start = HOST_SOURCE.indexOf("async function captureViewport(");
    const end = HOST_SOURCE.indexOf("\nasync function captureFullPage(", start);
    const capture = new Function("throwIfAborted", "assertWindowAlive", "delayWithAbort", "formatScreenshot", "browserError",
      `${HOST_SOURCE.slice(start, end)}; return captureViewport;`)(
      (signal?: AbortSignal) => signal?.throwIfAborted(), () => undefined,
      async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted(),
      () => "frame", (code: string) => new Error(code),
    );
    let calls = 0;
    const frame = { getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from("png") };
    const window = { webContents: { capturePage: async () => {
      if (++calls === 1) throw new Error("UnknownVizError");
      return frame;
    } } };
    await expect(capture(window)).resolves.toBe("frame");
    expect(calls).toBe(2);
    calls = 0;
    window.webContents.capturePage = async () => { calls++; throw new Error("UnknownVizError"); };
    await expect(capture(window)).rejects.toThrow("UnknownVizError");
    expect(calls).toBe(5);
    calls = 0;
    window.webContents.capturePage = async () => { calls++; throw new Error("destroyed"); };
    await expect(capture(window)).rejects.toThrow("destroyed");
    expect(calls).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(capture(window, controller.signal)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("starts the authenticated proxy before the host and keeps proxy credentials out of frames", async () => {
    const lifecycle: string[] = [];
    const launchOptions: Array<Record<string, unknown>> = [];
    const host = new ReadyHost();
    const proxyToken = "p".repeat(43);
    const proxy = {
      address: null,
      start: async () => {
        lifecycle.push("proxy");
        return { host: "127.0.0.1", port: 32123, token: proxyToken };
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
    expect(launchOptions[0]?.proxyToken).toBe(proxyToken);
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

  it("enforces proxy, scheme, permission, popup and download limits in the host", async () => {
    const bootstrap = compileHostNetworkBootstrap();
    expect(bootstrap.switches).toEqual([
      ["disable-quic"],
      ["disable-features", "DnsOverHttps,UseDnsHttpsSvcbAlpn,AsyncDns,EncryptedClientHello"],
      ["force-webrtc-ip-handling-policy", "disable_non_proxied_udp"],
    ]);
    const credentials: unknown[][] = [];
    bootstrap.login({ preventDefault: () => undefined }, null, null, { isProxy: true, host: "127.0.0.1", port: 32123 }, (...values: unknown[]) => credentials.push(values));
    bootstrap.login({ preventDefault: () => undefined }, null, null, { isProxy: false, host: "example.com", port: 443 }, (...values: unknown[]) => credentials.push(values));
    expect(credentials).toEqual([["openbot", "p".repeat(43)], []]);

    const { secureBrowserSession, attachWindowSecurity } = compileHostSecurity();
    const permissionResults: boolean[] = [];
    const proxySettings: unknown[] = [];
    const requestHandlers: Array<(details: { url: string; resourceType: string }, callback: (result: { cancel: boolean }) => void) => void> = [];
    const browserSession = {
      setProxy: async (value: unknown) => { proxySettings.push(value); },
      setPermissionRequestHandler: (handler: (_contents: unknown, _permission: string, callback: (allowed: boolean) => void) => void) => {
        handler({}, "camera", (allowed) => permissionResults.push(allowed));
      },
      setPermissionCheckHandler: (handler: () => boolean) => permissionResults.push(handler()),
      setDevicePermissionHandler: (handler: () => boolean) => permissionResults.push(handler()),
      webRequest: {
        onBeforeRequest: (_filter: unknown, handler: typeof requestHandlers[number]) => requestHandlers.push(handler),
      },
    };
    await expect(secureBrowserSession(browserSession)).resolves.toBeUndefined();
    expect(proxySettings).toEqual([{ mode: "fixed_servers", proxyRules: "http=127.0.0.1:32123;https=127.0.0.1:32123", proxyBypassRules: "<-loopback>" }]);
    expect(permissionResults).toEqual([false, false, false]);
    const decisions: boolean[] = [];
    requestHandlers[0]?.({ url: "https://example.com", resourceType: "mainFrame" }, ({ cancel }) => decisions.push(cancel));
    requestHandlers[0]?.({ url: "file:///etc/passwd", resourceType: "mainFrame" }, ({ cancel }) => decisions.push(cancel));
    expect(decisions).toEqual([false, true]);

    const contentHandlers = new Map<string, (event: { preventDefault(): void }, url?: string) => void>();
    let popupHandler: (() => { action: string }) | undefined;
    attachWindowSecurity({
      webContents: {
        setWindowOpenHandler: (handler: () => { action: string }) => { popupHandler = handler; },
        on: (event: string, handler: (event: { preventDefault(): void }, url?: string) => void) => contentHandlers.set(event, handler),
      },
    });
    expect(popupHandler?.()).toEqual({ action: "deny" });
    const prevented: string[] = [];
    contentHandlers.get("will-attach-webview")?.({ preventDefault: () => prevented.push("webview") });
    contentHandlers.get("will-navigate")?.({ preventDefault: () => prevented.push("scheme") }, "file:///etc/passwd");
    expect(prevented).toEqual(["webview", "scheme"]);

    const download = compileHostDownloadHandler();
    const item = download.item(1025);
    download.handler({}, item.value, { id: 7 });
    expect(item.cancelCalls).toHaveLength(1);
    expect(item.savePaths).toEqual(["C:\\Downloads\\report.txt"]);
    item.finish("cancelled");
    await Promise.resolve();
    expect(download.cleanupCalls).toEqual(["C:\\Downloads\\report.txt"]);
    const streamedItem = download.item(0);
    download.handler({}, streamedItem.value, { id: 7 });
    streamedItem.advance(1025);
    expect(streamedItem.cancelCalls).toHaveLength(1);
    streamedItem.finish("cancelled");
    await Promise.resolve();
    expect(download.cleanupCalls).toEqual([
      "C:\\Downloads\\report.txt",
      "C:\\Downloads\\report.txt",
    ]);
    const completedItem = download.item(1024);
    download.handler({}, completedItem.value, { id: 7 });
    completedItem.advance(1024);
    completedItem.finish("completed");
    await Promise.resolve();
    expect(completedItem.cancelCalls).toHaveLength(0);
    expect(download.cleanupCalls).toHaveLength(2);
  });

  it("wires session and window security at the production tab creation call site before navigation", async () => {
    const order: string[] = [];
    const openTab = compileHostOpenCallSite(order);

    await openTab({
      tabId: "tab-a",
      agentId: "agent-a",
      sessionId: "session-a",
      partition: "persist:openbot-agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      downloadRoot: "C:\\Downloads",
      command: { command: "open", url: "https://example.com/" },
    }, new AbortController().signal);

    expect(order).toEqual(["session-security", "window-security", "navigation"]);
  });

  it("captures the WebContents id before the window closed callback", () => {
    const deleted: number[] = [];
    let closed: (() => void) | undefined;
    let destroyed = false;
    const window = {
      webContents: { get id() { if (destroyed) throw new Error("destroyed WebContents"); return 71; } },
      on: (_event: string, handler: () => void) => { closed = handler; },
    };
    compileHostClosedLifecycle()({
      window,
      downloadConfigs: { set: () => undefined, delete: (id: number) => { deleted.push(id); } },
      request: { tabId: "tab-a", agentId: "agent-a", sessionId: "session-a" },
    });
    destroyed = true;
    expect(() => closed?.()).not.toThrow();
    expect(deleted).toEqual([71]);
  });

  it("enforces the production full-page screenshot dimension, pixel, and byte boundaries", async () => {
    const captureFullPage = compileHostFullPageCapture();
    const commands: Array<{ command: string; parameters: Record<string, unknown> }> = [];
    const detached: string[] = [];
    const window = fullPageWindow({ width: 8192, height: 1, deviceScaleFactor: 1 }, commands, detached);
    await expect(captureFullPage(window)).resolves.toMatchObject({ mimeType: "image/png", width: 2, height: 3 });
    expect(commands).toEqual([{
      command: "Page.captureScreenshot",
      parameters: expect.objectContaining({ captureBeyondViewport: true, clip: { x: 0, y: 0, width: 8192, height: 1, scale: 1 } }),
    }]);
    expect(detached).toEqual(["detached"]);

    const oversizedCommands: typeof commands = [];
    await expect(captureFullPage(fullPageWindow({ width: 8193, height: 1, deviceScaleFactor: 1 }, oversizedCommands, [])))
      .rejects.toMatchObject({ code: "BROWSER_SCREENSHOT_LIMIT" });
    expect(oversizedCommands).toHaveLength(0);

    await expect(captureFullPage(fullPageWindow({ width: 4096, height: 4096, deviceScaleFactor: 1 }, [], [])))
      .resolves.toMatchObject({ mimeType: "image/png" });
    await expect(captureFullPage(fullPageWindow({ width: 4097, height: 4096, deviceScaleFactor: 1 }, [], [])))
      .rejects.toMatchObject({ code: "BROWSER_SCREENSHOT_LIMIT" });

    await expect(captureFullPage(fullPageWindow({ width: 2, height: 3, deviceScaleFactor: 1 }, [], [], 5 * 1024 * 1024)))
      .resolves.toMatchObject({ mimeType: "image/png" });
    await expect(captureFullPage(fullPageWindow({ width: 2, height: 3, deviceScaleFactor: 1 }, [], [], 5 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ code: "BROWSER_SCREENSHOT_LIMIT" });
  });

  it("truncates visible text without splitting a non-BMP UTF-8 character", async () => {
    const readVisibleText = compileHostVisibleText();
    const prefix = "a".repeat(128 * 1024 - 1);
    const result = await readVisibleText({
      webContents: { executeJavaScript: async () => `${prefix}😀` },
    }, new AbortController().signal);

    expect(result).toBe(prefix);
    expect(result).not.toContain("�");
    expect(Buffer.byteLength(result, "utf8")).toBe(128 * 1024 - 1);
  });

  it("uploads only a bounded home file through the DOM file input", async () => {
    const calls: Array<{ homeRoot: string; relativePath: string }> = [];
    const uploadTab = compileHostUpload(async (homeRoot, relativePath) => {
      calls.push({ homeRoot, relativePath });
      return { fileName: "report.txt", bytes: 4, dataBase64: Buffer.from("safe").toString("base64") };
    });
    const input = { type: "file", files: undefined as unknown, events: [] as string[], dispatchEvent(event: { type: string }) { this.events.push(event.type); } };
    const window = uploadWindow(input);
    await expect(uploadTab({
      homeRoot: "C:\\Users\\agent-a",
      tabId: "tab-a",
      command: { selector: "#upload", path: "Documents/report.txt" },
    }, new AbortController().signal)).resolves.toMatchObject({ upload: { fileName: "report.txt", bytes: 4 } });
    expect(calls).toEqual([{ homeRoot: "C:\\Users\\agent-a", relativePath: "Documents/report.txt" }]);
    expect(input.events).toEqual(["input", "change"]);
    expect(input.files).toMatchObject({ files: [expect.objectContaining({ name: "report.txt", size: 4 })] });

    const root = await mkdtemp(join(tmpdir(), "openbot-browser-upload-limit-"));
    try {
      await writeFile(join(root, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
      await expect(compileHostUploadReader()(root, "large.bin")).rejects.toMatchObject({ code: "BROWSER_UPLOAD_FILE_TOO_LARGE" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a hardlink inside the home before reading the outside file", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-browser-hardlink-"));
    try {
      const home = join(root, "home");
      const documents = join(home, "Documents");
      const outside = join(root, "outside-secret.txt");
      const inside = join(documents, "report.txt");
      await mkdir(documents, { recursive: true });
      await writeFile(outside, "secret outside home");
      await link(outside, inside);

      const readUploadFile = compileHostUploadReader();
      await expect(readUploadFile(home, "Documents/report.txt")).rejects.toMatchObject({
        code: "BROWSER_UPLOAD_HARDLINK_UNSAFE",
        message: expect.not.stringContaining(outside),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a home path that is swapped to an external reparse target after validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-browser-upload-race-"));
    try {
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
      const readUploadFile = compileHostUploadReader(swappingFsp);

      await expect(readUploadFile(home, "Documents/report.txt")).rejects.toMatchObject({
        code: "BROWSER_UPLOAD_PATH_CHANGED",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a stable regular home file through the opened handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-browser-upload-stable-"));
    try {
      const home = join(root, "home");
      const documents = join(home, "Documents");
      await mkdir(documents, { recursive: true });
      await writeFile(join(documents, "report.txt"), "safe inside home");

      const readUploadFile = compileHostUploadReader();
      await expect(readUploadFile(home, "Documents/report.txt")).resolves.toMatchObject({
        bytes: 16,
        dataBase64: Buffer.from("safe inside home").toString("base64"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears the navigation timeout after a successful load", async () => {
    const scheduled = { id: 1 };
    const clearCalls: unknown[] = [];
    const loadUrl = compileHostLoader(
      () => scheduled,
      (timer) => clearCalls.push(timer),
    );

    await expect(loadUrl({ loadURL: async () => "loaded" }, "https://example.com/")).resolves.toBeUndefined();
    expect(clearCalls).toEqual([scheduled]);
  });

  it("clears the navigation timeout when a load fails", async () => {
    const scheduled = { id: 2 };
    const clearCalls: unknown[] = [];
    const loadUrl = compileHostLoader(
      () => scheduled,
      (timer) => clearCalls.push(timer),
    );

    await expect(loadUrl({ loadURL: async () => { throw new Error("navigation failed"); } }, "https://example.com/"))
      .rejects.toThrow("navigation failed");
    expect(clearCalls).toEqual([scheduled]);
  });
});

function compileHostUploadReader(filesystem: typeof fsp = fsp): (homeRoot: string, relativePath: string) => Promise<unknown> {
  const start = HOST_SOURCE.indexOf("async function readUploadFile");
  const end = HOST_SOURCE.indexOf("\nfunction uniqueDownloadPath", start);
  if (start < 0 || end < 0) throw new Error("browser upload reader seam is missing");
  const source = HOST_SOURCE.slice(start, end);
  const factory = new Function(
    "fsp",
    "path",
    "browserError",
    "isPathWithin",
    "safeFilename",
    "MAX_UPLOAD_PATH_BYTES",
    "MAX_UPLOAD_BYTES",
    "INVALID_UPLOAD_COMPONENT",
    "RESERVED_UPLOAD_DEVICE",
    `${source}\nreturn readUploadFile;`,
  ) as (...args: unknown[]) => (homeRoot: string, relativePath: string) => Promise<unknown>;
  return factory(
    filesystem,
    path,
    (code: string, message: string) => Object.assign(new Error(message), { code }),
    (root: string, candidate: string) => {
      const relation = path.relative(path.resolve(root), path.resolve(candidate));
      return relation === "" || (!relation.startsWith("..") && !path.isAbsolute(relation));
    },
    (filename: string) => filename,
    4096,
    4 * 1024 * 1024,
    /[<>:"|?*\u0000-\u001f]/u,
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu,
  );
}

function compileHostSecurity(): {
  secureBrowserSession: (browserSession: unknown) => Promise<void>;
  attachWindowSecurity: (window: unknown) => void;
} {
  const start = HOST_SOURCE.indexOf("async function secureBrowserSession");
  const end = HOST_SOURCE.indexOf("\nfunction getTab", start);
  if (start < 0 || end < 0) throw new Error("browser security seam is missing");
  const factory = new Function(
    "SECURED_SESSIONS",
    "PROXY",
    "browserError",
    `${HOST_SOURCE.slice(start, end)}\nreturn { secureBrowserSession, attachWindowSecurity };`,
  ) as (...args: unknown[]) => {
    secureBrowserSession: (browserSession: unknown) => Promise<void>;
    attachWindowSecurity: (window: unknown) => void;
  };
  return factory(
    new WeakSet(),
    { token: "p".repeat(43), rules: "http=127.0.0.1:32123;https=127.0.0.1:32123" },
    (code: string, message: string) => Object.assign(new Error(message), { code }),
  );
}

function compileHostNetworkBootstrap(): {
  switches: string[][];
  login: (...args: unknown[]) => void;
} {
  const start = HOST_SOURCE.indexOf('app.commandLine.appendSwitch("disable-quic")');
  const end = HOST_SOURCE.indexOf("\n\nif (!AUTH_TOKEN", start);
  if (start < 0 || end < 0) throw new Error("browser network bootstrap seam is missing");
  const switches: string[][] = [];
  let login: ((...args: unknown[]) => void) | undefined;
  const app = {
    commandLine: { appendSwitch: (...values: string[]) => switches.push(values) },
    on: (event: string, handler: (...args: unknown[]) => void) => { if (event === "login") login = handler; },
  };
  const factory = new Function("app", "PROXY", HOST_SOURCE.slice(start, end)) as (...args: unknown[]) => void;
  factory(app, { host: "127.0.0.1", port: 32123, token: "p".repeat(43) });
  if (login === undefined) throw new Error("browser proxy login handler was not registered");
  return { switches, login };
}

function compileHostDownloadHandler(): {
  handler: (event: unknown, item: unknown, webContents: { id: number }) => void;
  cleanupCalls: string[];
  item: (expectedBytes: number) => {
    value: unknown;
    cancelCalls: string[];
    savePaths: string[];
    advance: (receivedBytes: number) => void;
    finish: (state: string) => void;
  };
} {
  const start = HOST_SOURCE.indexOf('browserSession.on("will-download"');
  const endMarker = "\n    });\n  }\n  // Electron can destroy webContents";
  const end = HOST_SOURCE.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("browser download seam is missing");
  let handler: ((event: unknown, item: unknown, webContents: { id: number }) => void) | undefined;
  const cleanupCalls: string[] = [];
  const factory = new Function(
    "browserSession",
    "downloadConfigs",
    "safeFilename",
    "uniqueDownloadPath",
    "MAX_DOWNLOAD_BYTES",
    "fsp",
    "send",
    "PROTOCOL_VERSION",
    "ACTIVE_DOWNLOADS",
    HOST_SOURCE.slice(start, end + "\n    });".length),
  ) as (...args: unknown[]) => void;
  factory(
    { on: (_event: string, callback: typeof handler) => { handler = callback; } },
    new Map([[7, { root: "C:\\Downloads", tabId: "tab-a" }]]),
    (filename: string) => filename,
    (root: string, filename: string) => `${root}\\${filename}`,
    1024,
    { rm: async (target: string) => { cleanupCalls.push(target); } },
    () => undefined,
    1,
    new Map(),
  );
  if (handler === undefined) throw new Error("browser download handler was not registered");
  return {
    handler,
    cleanupCalls,
    item: (expectedBytes) => {
      const cancelCalls: string[] = [];
      const savePaths: string[] = [];
      let receivedBytes = 0;
      let updated: ((event: unknown, state: string) => void) | undefined;
      let done: ((event: unknown, state: string) => void) | undefined;
      return {
        cancelCalls,
        savePaths,
        advance: (value) => {
          receivedBytes = value;
          updated?.({}, "progressing");
        },
        finish: (state) => done?.({}, state),
        value: {
          getFilename: () => "report.txt",
          getTotalBytes: () => expectedBytes,
          getReceivedBytes: () => receivedBytes,
          setSavePath: (value: string) => savePaths.push(value),
          cancel: () => cancelCalls.push("cancelled"),
          on: (_event: string, handler: (event: unknown, state: string) => void) => { updated = handler; },
          once: (_event: string, handler: (event: unknown, state: string) => void) => { done = handler; },
        },
      };
    },
  };
}

function compileHostClosedLifecycle(): (options: {
  window: unknown;
  downloadConfigs: unknown;
  request: { tabId: string; agentId: string; sessionId: string };
}) => void {
  const start = HOST_SOURCE.indexOf("const webContentsId = window.webContents.id;");
  const end = HOST_SOURCE.indexOf("\n  return tab;", start);
  if (start < 0 || end < 0) throw new Error("browser closed lifecycle seam is missing");
  const source = HOST_SOURCE.slice(start, end);
  return ({ window, downloadConfigs, request }) => {
    const factory = new Function(
      "window",
      "downloadConfigs",
      "request",
      "downloadRoot",
      "attachWindowSecurity",
      "TABS",
      source,
    ) as (...args: unknown[]) => void;
    factory(window, downloadConfigs, request, "C:\\Downloads", () => undefined, new Map([[request.tabId, { window }]]));
  };
}

function compileHostFullPageCapture(): (window: unknown, signal?: AbortSignal) => Promise<unknown> {
  const start = HOST_SOURCE.indexOf("async function captureFullPage");
  const end = HOST_SOURCE.indexOf("\nasync function readVisibleText", start);
  if (start < 0 || end < 0) throw new Error("browser full-page capture seam is missing");
  const factory = new Function(
    "throwIfAborted",
    "assertWindowAlive",
    "browserError",
    "nativeImage",
    "MAX_SCREENSHOT_DIMENSION",
    "MAX_SCREENSHOT_PIXELS",
    "MAX_SCREENSHOT_BYTES",
    `${HOST_SOURCE.slice(start, end)}\nreturn (window, signal = new AbortController().signal) => captureFullPage(window, signal);`,
  ) as (...args: unknown[]) => (window: unknown, signal?: AbortSignal) => Promise<unknown>;
  return factory(
    (signal: AbortSignal) => { if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "BROWSER_COMMAND_ABORTED" }); },
    () => undefined,
    (code: string, message: string) => Object.assign(new Error(message), { code }),
    { createFromBuffer: () => ({ getSize: () => ({ width: 2, height: 3 }) }) },
    8192,
    16 * 1024 * 1024,
    5 * 1024 * 1024,
  );
}

function fullPageWindow(
  metrics: { width: number; height: number; deviceScaleFactor: number },
  commands: Array<{ command: string; parameters: Record<string, unknown> }>,
  detached: string[],
  payloadBytes = 3,
): unknown {
  return {
    webContents: {
      executeJavaScript: async () => metrics,
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

function compileHostVisibleText(): (window: unknown, signal: AbortSignal) => Promise<string> {
  const start = HOST_SOURCE.indexOf("async function readVisibleText");
  const end = HOST_SOURCE.indexOf("\nasync function readInteractiveElements", start);
  if (start < 0 || end < 0) throw new Error("browser visible-text seam is missing");
  const factory = new Function(
    "throwIfAborted",
    "assertWindowAlive",
    "MAX_SNAPSHOT_TEXT_BYTES",
    `${HOST_SOURCE.slice(start, end)}\nreturn readVisibleText;`,
  ) as (...args: unknown[]) => (window: unknown, signal: AbortSignal) => Promise<string>;
  return factory(
    (signal: AbortSignal) => { if (signal.aborted) throw new Error("aborted"); },
    () => undefined,
    128 * 1024,
  );
}

function compileHostOpenCallSite(order: string[]): (request: unknown, signal: AbortSignal) => Promise<unknown> {
  const openStart = HOST_SOURCE.indexOf("async function openTab");
  const openEnd = HOST_SOURCE.indexOf("\nasync function navigateTab", openStart);
  const createStart = HOST_SOURCE.indexOf("async function createTab");
  const createEnd = HOST_SOURCE.indexOf("\nasync function secureBrowserSession", createStart);
  if (openStart < 0 || openEnd < 0 || createStart < 0 || createEnd < 0) throw new Error("browser tab creation seam is missing");
  const tabs = new Map<string, unknown>();
  let currentUrl = "about:blank";
  const browserSession = { on: () => undefined };
  const window = {
    webContents: {
      id: 7,
      session: browserSession,
      getURL: () => currentUrl,
      getTitle: () => "test",
    },
    isDestroyed: () => false,
    destroy: () => undefined,
    show: () => undefined,
    on: () => undefined,
  };
  const factory = new Function(
    "TABS",
    "throwIfAborted",
    "assertTabOwnership",
    "assertSafeUrl",
    "assertWindowAlive",
    "loadUrl",
    "resultBase",
    "ensureDownloadRoot",
    "BrowserWindow",
    "secureBrowserSession",
    "DOWNLOAD_CONFIG",
    "DOWNLOAD_SESSIONS",
    "safeFilename",
    "uniqueDownloadPath",
    "MAX_DOWNLOAD_BYTES",
    "fsp",
    "send",
    "PROTOCOL_VERSION",
    "attachWindowSecurity",
    `${HOST_SOURCE.slice(openStart, openEnd)}\n${HOST_SOURCE.slice(createStart, createEnd)}\nreturn openTab;`,
  ) as (...args: unknown[]) => (request: unknown, signal: AbortSignal) => Promise<unknown>;
  return factory(
    tabs,
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined,
    async (_window: unknown, url: string) => { order.push("navigation"); currentUrl = url; },
    (command: string, tabId: string) => ({ command, tabId }),
    async (root: string) => root,
    class { constructor() { return window; } },
    async () => { order.push("session-security"); },
    new WeakMap(),
    new WeakSet(),
    (filename: string) => filename,
    (root: string, filename: string) => `${root}\\${filename}`,
    1024,
    { rm: async () => undefined },
    () => undefined,
    1,
    () => { order.push("window-security"); },
  );
}

function compileHostUpload(
  readUploadFile: (homeRoot: string, relativePath: string) => Promise<{ fileName: string; bytes: number; dataBase64: string }>,
): (request: unknown, signal: AbortSignal) => Promise<unknown> {
  const start = HOST_SOURCE.indexOf("async function uploadTab");
  const end = HOST_SOURCE.indexOf("\nasync function screenshotTab", start);
  if (start < 0 || end < 0) throw new Error("browser upload command seam is missing");
  const factory = new Function(
    "throwIfAborted",
    "getTab",
    "readUploadFile",
    "assertWindowAlive",
    "browserError",
    "resultBase",
    `${HOST_SOURCE.slice(start, end)}\nreturn uploadTab;`,
  ) as (...args: unknown[]) => (request: unknown, signal: AbortSignal) => Promise<unknown>;
  return factory(
    (signal: AbortSignal) => { if (signal.aborted) throw new Error("aborted"); },
    (request: { window?: unknown }) => ({ window: request.window ?? currentUploadWindow }),
    readUploadFile,
    () => undefined,
    (code: string, message: string) => Object.assign(new Error(message), { code }),
    (command: string, tabId: string, _window: unknown, extra: Record<string, unknown>) => ({ command, tabId, ...extra }),
  );
}

let currentUploadWindow: unknown;

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
  currentUploadWindow = {
    webContents: {
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
  return currentUploadWindow;
}

function compileHostLoader(
  schedule: (callback: () => void, delayMs: number) => unknown,
  clear: (timer: unknown) => void,
): (window: { loadURL: (url: string) => Promise<unknown> }, url: string) => Promise<unknown> {
  const start = HOST_SOURCE.indexOf("async function loadUrl");
  const end = HOST_SOURCE.indexOf("\nasync function capture", start);
  if (start < 0 || end < 0) throw new Error("browser navigation seam is missing");
  const source = HOST_SOURCE.slice(start, end);
  const factory = new Function(
    "setTimeout",
    "clearTimeout",
    "browserError",
    `${source}\nreturn loadUrl;`,
  ) as (...args: unknown[]) => (window: { loadURL: (url: string) => Promise<unknown> }, url: string) => Promise<unknown>;
  return factory(
    schedule,
    clear,
    (code: string, message: string) => Object.assign(new Error(message), { code }),
  );
}
