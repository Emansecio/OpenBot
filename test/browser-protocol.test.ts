import { describe, expect, it } from "vitest";

import {
  BROWSER_PROTOCOL_VERSION,
  assertSafeBrowserUrl,
  encodeBrowserFrame,
  parseBrowserHostMessage,
  validateBrowserCommand,
} from "../src/browser/protocol.js";

describe("browser host protocol", () => {
  it("accepts only the versioned response envelope", () => {
    const frame = encodeBrowserFrame({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: "response",
      id: "request-1",
      ok: true,
      result: { command: "handoff", tabId: "tab-1", visible: true },
    });
    expect(parseBrowserHostMessage(frame.trim())).toMatchObject({ kind: "response", ok: true, id: "request-1" });
    expect(() => parseBrowserHostMessage(JSON.stringify({ protocolVersion: 2, kind: "ready", hostVersion: "1" }))).toThrow(/protocol/i);
    expect(() => parseBrowserHostMessage(JSON.stringify({ protocolVersion: 1, kind: "response", id: "x", ok: false }))).toThrow(/error/i);
  });

  it("rejects unsafe URLs and arbitrary command shapes", () => {
    expect(assertSafeBrowserUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(() => assertSafeBrowserUrl("file:///C:/secret.txt")).toThrow(/protocol/i);
    expect(() => assertSafeBrowserUrl("javascript:alert(1)")).toThrow(/protocol/i);
    expect(() => validateBrowserCommand({ command: "click", x: -1, y: 2 })).toThrow(/coordinate/i);
    expect(() => validateBrowserCommand({ command: "type", text: "x".repeat(70_000) })).toThrow(/large/i);
  });

  it("accepts a relative, bounded upload command and rejects path escapes", () => {
    expect(validateBrowserCommand({ command: "upload", selector: "input[type=file]", path: "Documents/report.pdf" })).toEqual({
      command: "upload",
      selector: "input[type=file]",
      path: "Documents/report.pdf",
    });
    expect(() => validateBrowserCommand({ command: "upload", selector: "input[type=file]", path: "../secret.txt" })).toThrow(/outside|invalid/i);
    expect(() => validateBrowserCommand({ command: "upload", selector: "input[type=file]", path: "C:\\secret.txt" })).toThrow(/relative|invalid/i);
    expect(() => validateBrowserCommand({ command: "upload", selector: "x".repeat(5_000), path: "Documents/report.pdf" })).toThrow(/selector/i);
  });

  it("valida ações semânticas limitadas para elemento, rolagem e teclado", () => {
    expect(validateBrowserCommand({ command: "click_element", elementId: "ob-el-42" })).toEqual({ command: "click_element", elementId: "ob-el-42" });
    expect(validateBrowserCommand({ command: "scroll", deltaX: 0, deltaY: 640 })).toEqual({ command: "scroll", deltaX: 0, deltaY: 640 });
    expect(validateBrowserCommand({ command: "press_key", key: "ENTER" })).toEqual({ command: "press_key", key: "ENTER" });
    expect(() => validateBrowserCommand({ command: "click_element", elementId: "../escape" })).toThrow(/element/i);
    expect(() => validateBrowserCommand({ command: "scroll", deltaX: 0, deltaY: 100_000 })).toThrow(/scroll/i);
    expect(() => validateBrowserCommand({ command: "press_key", key: "F12" } as never)).toThrow(/key/i);
  });

  it("bounds serialized frames", () => {
    expect(() => encodeBrowserFrame({ value: "x".repeat(9 * 1024 * 1024) })).toThrow(/exceeds/i);
  });
});
