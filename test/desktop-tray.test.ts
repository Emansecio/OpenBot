import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const bootstrap = readFileSync(new URL("../scripts/openbot-electron.cjs", import.meta.url), "utf8");
const rendererURL = pathToFileURL("C:\\OpenBot\\client\\extracted\\dist\\renderer\\index.html").href;

function fixture(failTray = false) {
  const app = Object.assign(new EventEmitter(), {
    setName: vi.fn(), setAppUserModelId: vi.fn(), quit: vi.fn(),
  });
  const trays: FakeTray[] = [];
  class FakeTray extends EventEmitter {
    destroyed = false;
    menu: any[] = [];
    constructor(_image: unknown) {
      super();
      if (failTray) throw new Error("tray fixture failure");
      trays.push(this);
    }
    setToolTip = vi.fn();
    setContextMenu(menu: any[]) { this.menu = menu; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  class FakeWindow extends EventEmitter {
    visible = true;
    destroyed = false;
    minimized = false;
    setIcon = vi.fn();
    setAppDetails = vi.fn();
    nativeOverlay = vi.fn();
    setTitleBarOverlay = this.nativeOverlay;
    focus = vi.fn();
    webContents: EventEmitter & { getURL: () => string };
    constructor(url: string) {
      super();
      this.webContents = Object.assign(new EventEmitter(), { getURL: () => url });
      app.emit("browser-window-created", {}, this);
      this.webContents.emit("did-finish-load");
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    close() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit("close", event);
      if (!event.defaultPrevented) {
        this.destroyed = true;
        this.emit("closed");
      }
      return event;
    }
  }
  const error = vi.fn();
  runInNewContext(bootstrap, {
    __dirname: "C:\\OpenBot\\scripts",
    process: { platform: "win32", env: {} }, console: { error },
    require(id: string) {
      if (id === "node:path") return win32;
      if (id === "node:url") return { pathToFileURL };
      if (id === "electron") return {
        app, Tray: FakeTray, Menu: { buildFromTemplate: (items: any[]) => items },
        nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
      };
      expect(id).toBe("../client/extracted/dist/electron-main/main.cjs");
      return {};
    },
  });
  const createMain = (suffix = "") => new FakeWindow(rendererURL + suffix);
  return { app, trays, createMain, FakeWindow, error };
}

describe("desktop close-to-tray", () => {
  it("keeps main-window controls transparent across host updates without changing native geometry or symbols", () => {
    const { createMain, FakeWindow } = fixture();
    const auxiliary = new FakeWindow("about:blank");
    expect(auxiliary.nativeOverlay).not.toHaveBeenCalled();
    const main = createMain();
    expect(main.nativeOverlay).toHaveBeenLastCalledWith({ color: "#00000000" });
    const update = { color: "#0B0B0B", symbolColor: "#FFFFFF", height: 51 };
    main.setTitleBarOverlay(update);
    expect(main.nativeOverlay).toHaveBeenLastCalledWith({ ...update, color: "#00000000" });
    expect(update.color).toBe("#0B0B0B");
    main.setTitleBarOverlay({ color: "#FCFCFC", symbolColor: "#141414", height: 43 });
    expect(main.nativeOverlay).toHaveBeenLastCalledWith({ color: "#00000000", symbolColor: "#141414", height: 43 });
    main.webContents.emit("did-finish-load");
    expect(main.nativeOverlay).toHaveBeenCalledTimes(3);
  });

  it.each(["", "?fixture=1#chat"])("keeps the same window alive and restores it from the menu (%s)", suffix => {
    const { app, trays, createMain } = fixture();
    const window = createMain(suffix);
    window.webContents.emit("did-finish-load");
    expect(window.listenerCount("close")).toBe(1);
    expect(trays).toHaveLength(1);
    expect(trays[0]!.menu.map(item => item.label ?? item.type)).toEqual([
      "Reabrir OpenBot", "separator", "Encerrar OpenBot",
    ]);
    // Existing draft/state close listeners must still execute.
    const persist = vi.fn();
    window.on("close", persist);
    expect(window.close().defaultPrevented).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(window.visible).toBe(false);
    expect(window.destroyed).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
    trays[0]!.menu[0].click();
    expect(window.visible).toBe(true);
    expect(window.focus).toHaveBeenCalledOnce();
    window.close();
    window.minimized = true;
    trays[0]!.emit("double-click");
    expect(window.minimized).toBe(false);
    expect(window.visible).toBe(true);
  });

  it("reopens on another launch or activation and ignores auxiliary windows", () => {
    const { app, trays, createMain, FakeWindow } = fixture();
    const auxiliary = new FakeWindow("file:///C:/Other/index.html");
    expect(trays).toHaveLength(0);
    const main = createMain();
    expect(auxiliary.close().defaultPrevented).toBe(false);
    for (const event of ["second-instance", "activate"]) {
      main.close();
      app.emit(event, {}, []);
      expect(main.visible).toBe(true);
    }
    expect(trays).toHaveLength(1);
  });

  it("uses normal quit, allows deferred flush, and destroys the tray only on will-quit", () => {
    const { app, trays, createMain } = fixture();
    const window = createMain();
    window.close();
    trays[0]!.menu[2].click();
    expect(app.quit).toHaveBeenCalledOnce();
    app.emit("before-quit", { preventDefault: vi.fn() });
    expect(trays[0]!.destroyed).toBe(false);
    expect(window.close().defaultPrevented).toBe(false);
    app.emit("before-quit", {});
    app.emit("will-quit", {});
    expect(trays[0]!.destroyed).toBe(true);
    expect(() => app.emit("second-instance", {}, [])).not.toThrow();
  });

  it.each(["query-session-end", "session-end"])("does not block Windows %s", event => {
    const { createMain } = fixture();
    const window = createMain();
    const preventDefault = vi.fn();
    window.emit(event, { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(window.close().defaultPrevented).toBe(false);
  });

  it("falls back to normal closing if tray creation fails or tray is destroyed", () => {
    const failed = fixture(true);
    expect(failed.createMain().close().defaultPrevented).toBe(false);
    expect(failed.error).toHaveBeenCalledOnce();
    const normal = fixture();
    const window = normal.createMain();
    normal.trays[0]!.destroy();
    expect(window.close().defaultPrevented).toBe(false);
  });
});
