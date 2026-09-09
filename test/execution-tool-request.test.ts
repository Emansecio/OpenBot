import { describe, expect, it } from "vitest";

import { toolCallToExecutionRequest } from "../src/execution/tool-request.js";
import type { ProviderToolCall } from "../src/providers/router.js";

const call = (name: string, args: unknown, id = "process-1"): ProviderToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

describe("process_run tool translation", () => {
  it("exposes workspace discovery and preserves explicit shared upload paths", () => {
    expect(toolCallToExecutionRequest(call("workspace_info", {}))).toEqual({ request: { operation: "workspace.info" } });
    expect(toolCallToExecutionRequest(call("workspace_info", { path: "C:\\Windows" })).error).toMatch(/unsupported fields/i);
    expect(toolCallToExecutionRequest(call("browser_upload", { selector: "#file", path: "shared://Documents/report.txt" })))
      .toEqual({ request: { operation: "browser.upload", selector: "#file", path: "shared://Documents/report.txt" } });
  });

  it("converte somente o contrato estruturado para process.run", () => {
    expect(toolCallToExecutionRequest(call("process_run", {
      executable: "node",
      argv: ["--version"],
      cwd: "Projects/app",
      timeoutMs: 1_000,
      networkProfile: "none",
    }))).toEqual({
      request: {
        operation: "process.run",
        executable: "node",
        argv: ["--version"],
        cwd: "Projects/app",
        timeoutMs: 1_000,
        networkProfile: "none",
      },
    });
  });

  it("recusa shell e qualquer nome de ferramenta fora da allowlist", () => {
    expect(toolCallToExecutionRequest(call("shell", { cmd: "whoami" })).error).toMatch(/shell.*disabled/i);
    expect(toolCallToExecutionRequest(call("exec", { command: "whoami" })).error).toMatch(/unsupported/i);
  });

  it("recusa campos extras antes de chegar ao backend", () => {
    const result = toolCallToExecutionRequest(call("process_run", {
      executable: "node",
      argv: [],
      cwd: ".",
      timeoutMs: 1_000,
      networkProfile: "none",
      command: "node --version",
    }));
    expect(result.request).toBeUndefined();
    expect(result.error).toMatch(/unsupported fields/i);
  });
});

describe("file tool translation", () => {
  it.each([
    [{ op: "list", path: "Documents" }, { operation: "file.list", path: "Documents" }],
    [{ op: "stat", path: "Documents" }, { operation: "file.stat", path: "Documents" }],
    [{ op: "mkdir", path: "Documents/new" }, { operation: "file.mkdir", path: "Documents/new" }],
    [{ op: "copy", source: "a.txt", destination: "b.txt" }, { operation: "file.copy", source: "a.txt", destination: "b.txt" }],
    [{ op: "move", source: "a.txt", destination: "b.txt" }, { operation: "file.move", source: "a.txt", destination: "b.txt" }],
    [{ op: "trash", path: "a.txt" }, { operation: "file.trash", path: "a.txt" }],
    [{ op: "restore", trashId: "550e8400-e29b-41d4-a716-446655440000" }, { operation: "file.restore", trashId: "550e8400-e29b-41d4-a716-446655440000" }],
    [{ op: "read", path: "a.txt", encoding: "utf8" }, { operation: "file.read", path: "a.txt", encoding: "utf8" }],
    [{ op: "read", path: "a.txt" }, { operation: "file.read", path: "a.txt", encoding: "utf8" }],
    [{ op: "write", path: "a.txt", content: "ok", encoding: "utf8" }, { operation: "file.write", path: "a.txt", content: "ok", encoding: "utf8" }],
  ] as const)("converte %j sem alterar o contrato", (args, request) => {
    expect(toolCallToExecutionRequest(call("file", args))).toEqual({ request });
  });

  it.each([
    { op: "copy", path: "ambiguous.txt", source: "a.txt", destination: "b.txt" },
    { op: "move", source: "a.txt", destination: "b.txt", trashId: "550e8400-e29b-41d4-a716-446655440000" },
    { op: "restore", trashId: "550e8400-e29b-41d4-a716-446655440000", source: "a.txt" },
    { op: "stat", path: "a.txt", destination: "b.txt" },
  ])("recusa campos ambíguos em %j", (args) => {
    const result = toolCallToExecutionRequest(call("file", args));
    expect(result.request).toBeUndefined();
    expect(result.error).toMatch(/unsupported fields/i);
  });
});

describe("browser tools translation", () => {
  it.each([
    ["browser_open", { url: "https://example.com/" }, "browser.open"],
    ["browser_navigate", { url: "https://example.com/next" }, "browser.navigate"],
    ["browser_snapshot", { includeText: true }, "browser.snapshot"],
    ["browser_click", { x: 10, y: 20, button: "left", clickCount: 2 }, "browser.click"],
    ["browser_click_element", { elementId: "ob-el-1" }, "browser.click_element"],
    ["browser_scroll", { deltaX: 0, deltaY: 640 }, "browser.scroll"],
    ["browser_press_key", { key: "ENTER" }, "browser.press_key"],
    ["browser_type", { text: "hello" }, "browser.type"],
    ["browser_upload", { selector: "input[type=file]", path: "Documents/report.pdf" }, "browser.upload"],
    ["browser_screenshot", { fullPage: false }, "browser.screenshot"],
    ["browser_handoff", {}, "browser.handoff"],
    ["browser_close", {}, "browser.close"],
  ] as const)("converte %s em %s", (name, args, operation) => {
    expect(toolCallToExecutionRequest(call(name, args))).toEqual({ request: { operation, ...args } });
  });

  it.each([
    ["browser_open", { url: "https://example.com/", extra: true }],
    ["browser_navigate", { url: "https://example.com/", extra: true }],
    ["browser_snapshot", { includeText: true, extra: true }],
    ["browser_click", { x: 1, y: 2, extra: true }],
    ["browser_click_element", { elementId: "ob-el-1", extra: true }],
    ["browser_scroll", { deltaX: 0, deltaY: 640, extra: true }],
    ["browser_press_key", { key: "ENTER", extra: true }],
    ["browser_type", { text: "hello", extra: true }],
    ["browser_upload", { selector: "input[type=file]", path: "Documents/report.pdf", extra: true }],
    ["browser_screenshot", { fullPage: false, extra: true }],
    ["browser_handoff", { extra: true }],
    ["browser_close", { extra: true }],
  ] as const)("recusa campos extras em %s", (name, args) => {
    expect(toolCallToExecutionRequest(call(name, args)).error).toMatch(/unsupported fields/i);
  });
});

describe("whatsapp tool translation", () => {
  it("converts the structured host contract", () => {
    expect(toolCallToExecutionRequest(call("whatsapp", { op: "doctor" }))).toEqual({
      request: { operation: "whatsapp", op: "doctor" },
    });
    expect(toolCallToExecutionRequest(call("whatsapp", {
      op: "send",
      chat: "5511999999999",
      text: "oi",
    }))).toEqual({
      request: { operation: "whatsapp", op: "send", chat: "5511999999999", text: "oi" },
    });
  });

  it("rejects host paths in chat", () => {
    expect(toolCallToExecutionRequest(call("whatsapp", { op: "send", chat: "C:\\\\Users\\\\x", text: "oi" })).error).toBeDefined();
  });
});
