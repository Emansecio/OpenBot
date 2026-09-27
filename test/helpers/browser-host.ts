// Loads scripts/openbot-browser-host.cjs as a module in this realm, with a fake
// Electron, process and (optionally) replaced Node modules or timers. The
// host exports its internals when it is not Electron's main script, so tests
// call the real functions instead of slicing the file's text.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hostPath = fileURLToPath(new URL("../../scripts/openbot-browser-host.cjs", import.meta.url));
export const BROWSER_HOST_SOURCE = readFileSync(hostPath, "utf8");
const requireFromTest = createRequire(import.meta.url);

type AnyFunction = (...args: any[]) => any;

/** The host's test exports (see the end of openbot-browser-host.cjs). */
export interface BrowserHostModule {
  TABS: Map<string, any>;
  ACTIVE_DOWNLOADS: Map<string, Set<any>>;
  RESERVED_DOWNLOAD_PATHS: Set<string>;
  enqueueRequest: AnyFunction;
  handleCancel: AnyFunction;
  handleLine: (line: string) => Promise<void>;
  execute: (request: any, signal: AbortSignal) => Promise<any>;
  failFastHost: AnyFunction;
  openTab: (request: any, signal: AbortSignal) => Promise<any>;
  uploadTab: (request: any, signal: AbortSignal) => Promise<any>;
  closeTab: (request: any, signal?: AbortSignal) => Promise<any>;
  createTab: (request: any, signal: AbortSignal) => Promise<any>;
  handleWillDownload: (config: any, item: any) => void;
  secureBrowserSession: (browserSession: any) => Promise<void>;
  attachWindowSecurity: (window: any) => void;
  loadUrl: (window: any, url: string, signal?: AbortSignal) => Promise<void>;
  captureViewport: (window: any, signal?: AbortSignal) => Promise<any>;
  captureFullPage: (window: any, signal?: AbortSignal) => Promise<any>;
  readVisibleText: (window: any, signal?: AbortSignal) => Promise<string>;
  readInteractiveElements: (window: any, signal?: AbortSignal) => Promise<any[]>;
  sanitizeElements: (value: unknown) => unknown[];
  readUploadFile: (homeRoot: string, relativePath: string) => Promise<any>;
  uniqueDownloadPath: (root: string, filename: string) => string;
  safeFilename: (filename: string) => string;
}

export interface FakeElectronApp {
  switches: string[][];
  handlers: Map<string, AnyFunction>;
  quitCalls: number;
}

export interface BrowserHostHarnessOptions {
  /** Host environment; a valid launch config is not needed for the exports. */
  env?: Record<string, string>;
  /** Overrides for the fake Electron module (BrowserWindow, session, ...). */
  electron?: Record<string, unknown>;
  /** Replacement Node modules by require id, e.g. "node:fs/promises". */
  modules?: Record<string, unknown>;
  setTimeout?: AnyFunction;
  clearTimeout?: AnyFunction;
  /** Extra code evaluated inside the host's module scope. */
  append?: string;
}

export interface BrowserHostHarness {
  host: BrowserHostModule;
  app: FakeElectronApp;
  /** Frames the host wrote to stdout (responses and events). */
  frames: unknown[];
  /** Values the appended code stored on `harness`. */
  scope: Record<string, any>;
}

export function loadBrowserHost(options: BrowserHostHarnessOptions = {}): BrowserHostHarness {
  const app = {
    switches: [] as string[][],
    handlers: new Map<string, AnyFunction>(),
    quitCalls: 0,
    commandLine: { appendSwitch: (...values: string[]) => { app.switches.push(values); } },
    on(event: string, handler: AnyFunction) {
      app.handlers.set(event, handler);
      return app;
    },
    isReady: () => true,
    quit() { app.quitCalls += 1; },
    whenReady: () => new Promise<void>(() => undefined),
    setPath: () => undefined,
  };
  const frames: unknown[] = [];
  const fakeProcess = {
    env: { ...(options.env ?? {}) },
    exitCode: 0,
    on: () => fakeProcess,
    exit: () => undefined,
    stderr: { write: () => true },
    stdout: {
      write: (chunk: string, callback?: () => void) => {
        frames.push(JSON.parse(String(chunk)));
        callback?.();
        return true;
      },
      once: () => undefined,
    },
    platform: process.platform,
    arch: process.arch,
  };
  const electron = {
    app,
    BrowserWindow: class {},
    ipcMain: { on: () => undefined },
    nativeImage: {},
    session: {},
    ...options.electron,
  };
  const requireShim = Object.assign(
    (id: string) => (id === "electron" ? electron : options.modules?.[id] ?? requireFromTest(id)),
    { main: undefined },
  );
  const module = { exports: {} as unknown };
  const scope: Record<string, any> = {};
  const factory = new Function(
    "require", "module", "exports", "__dirname", "__filename", "process",
    "setTimeout", "clearTimeout", "setImmediate", "harness",
    `${BROWSER_HOST_SOURCE}\n${options.append ?? ""}`,
  ) as (...args: unknown[]) => void;
  factory(
    requireShim, module, module.exports, dirname(hostPath), hostPath, fakeProcess,
    options.setTimeout ?? setTimeout, options.clearTimeout ?? clearTimeout, setImmediate, scope,
  );
  return { host: module.exports as BrowserHostModule, app, frames, scope };
}
