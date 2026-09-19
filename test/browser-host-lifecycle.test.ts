import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../scripts/openbot-browser-host.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function compileClose(tabs: Map<string, unknown>, downloads: Map<string, unknown>, browserSession: unknown) {
  const start = source.indexOf("async function closeTab(");
  const end = source.indexOf("\nasync function handoffTab(", start);
  if (start < 0 || end < 0) throw new Error("browser lifecycle seam is missing");
  return new Function("TABS", "ACTIVE_DOWNLOADS", "session", "throwIfAborted", "assertTabOwnership",
    `${source.slice(start, end)}; return closeTab;`)(
    tabs, downloads, { fromPartition: () => browserSession },
    (signal?: AbortSignal) => signal?.throwIfAborted(), () => undefined,
  ) as (request: { tabId: string; partition: string }) => Promise<unknown>;
}

describe("browser host home lifecycle", () => {
  it.each([true, false])("awaits owned download cleanup and flushes storage even if the tab is present=%s", async (present) => {
    let finishDownload!: () => void;
    const done = new Promise<void>((resolve) => { finishDownload = resolve; });
    const cancel = vi.fn();
    const otherCancel = vi.fn();
    const destroy = vi.fn();
    const close = vi.fn(() => { throw new Error("beforeunload may veto close"); });
    const window = { isDestroyed: () => false, destroy, close };
    const tabs = new Map<string, unknown>(present ? [["a", { window }]] : []);
    const downloads = new Map<string, unknown>([
      ["a", new Set([{ item: { cancel }, finished: false, done }])],
      ["b", new Set([{ item: { cancel: otherCancel }, finished: false, done: Promise.resolve() }])],
    ]);
    const storage = { flushStorageData: vi.fn(), cookies: { flushStore: vi.fn(async () => undefined) }, clearStorageData: vi.fn() };
    const closeTab = compileClose(tabs, downloads, storage);
    let drained = false;
    const closing = closeTab({ tabId: "a", partition: "persist:agent-a" }).then(() => { drained = true; });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(otherCancel).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(present ? 1 : 0);
    expect(close).not.toHaveBeenCalled();
    expect(drained).toBe(false);
    expect(storage.flushStorageData).not.toHaveBeenCalled();
    finishDownload();
    await closing;
    expect(storage.flushStorageData).toHaveBeenCalledOnce();
    expect(storage.cookies.flushStore).toHaveBeenCalledOnce();
    expect(storage.clearStorageData).not.toHaveBeenCalled();
    expect(tabs.has("a")).toBe(false);
  });
});
