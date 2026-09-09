import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEARCH_PATHS,
  ExecutionRequestError,
  parseExecutionRequest,
} from "../src/execution/contracts.js";

describe("execution contracts", () => {
  it.each([
    [{ operation: "file.list", path: "." }, "file.list"],
    [{ operation: "file.stat", path: "src" }, "file.stat"],
    [{ operation: "file.mkdir", path: "src/new" }, "file.mkdir"],
    [{ operation: "file.copy", source: "src/a.txt", destination: "src/b.txt" }, "file.copy"],
    [{ operation: "file.move", source: "src/a.txt", destination: "src/b.txt" }, "file.move"],
    [{ operation: "file.trash", path: "src/a.txt" }, "file.trash"],
    [{ operation: "file.restore", trashId: "550e8400-e29b-41d4-a716-446655440000" }, "file.restore"],
    [{ operation: "file.read", path: "src/index.ts", encoding: "utf8" }, "file.read"],
    [{ operation: "file.write", path: "notes.txt", content: "ok" }, "file.write"],
    [{ operation: "command.run", command: "search.files", params: { paths: ["src"] } }, "command.run"],
    [{ operation: "command.run", command: "search.text", params: { pattern: "needle", mode: "fixed" } }, "command.run"],
    [{
      operation: "process.run",
      executable: "node",
      argv: ["--version"],
      cwd: "Projects/app",
      env: { NODE_ENV: "test" },
      stdin: "",
      timeoutMs: 1_000,
      networkProfile: "none",
    }, "process.run"],
    [{
      operation: "process.run",
      executable: "powershell.exe",
      argv: ["-NoProfile", "-Command", "Get-Location"],
      cwd: "C:\\",
      timeoutMs: 1_000,
      networkProfile: "host",
    }, "process.run"],
    [{ operation: "browser.open", url: "https://example.com/" }, "browser.open"],
    [{ operation: "browser.navigate", url: "https://example.com/next" }, "browser.navigate"],
    [{ operation: "browser.snapshot", includeText: true }, "browser.snapshot"],
    [{ operation: "browser.click", x: 10, y: 20, button: "left", clickCount: 1 }, "browser.click"],
    [{ operation: "browser.click_element", elementId: "ob-el-1" }, "browser.click_element"],
    [{ operation: "browser.scroll", deltaX: 0, deltaY: 640 }, "browser.scroll"],
    [{ operation: "browser.press_key", key: "ENTER" }, "browser.press_key"],
    [{ operation: "browser.type", text: "hello" }, "browser.type"],
    [{ operation: "browser.upload", selector: "input[type=file]", path: "Documents/report.pdf" }, "browser.upload"],
    [{ operation: "browser.screenshot", fullPage: false }, "browser.screenshot"],
    [{ operation: "browser.handoff" }, "browser.handoff"],
    [{ operation: "browser.close" }, "browser.close"],
    [{ operation: "whatsapp", op: "doctor" }, "whatsapp"],
    [{ operation: "whatsapp", op: "sweep" }, "whatsapp"],
    [{ operation: "whatsapp", op: "messages_list", chat: "5511999999999@s.whatsapp.net", limit: 20 }, "whatsapp"],
    [{ operation: "whatsapp", op: "send", chat: "5511999999999", text: "oi", etapa: "adesao" }, "whatsapp"],
    [{ operation: "whatsapp", op: "download", chat: "5511999999999", mediaId: "ABC" }, "whatsapp"],
  ] as const)("aceita %j", (input, operation) => {
    expect(parseExecutionRequest(input).operation).toBe(operation);
  });

  it.each([
    { operation: "shell", cmd: "whoami" },
    { operation: "command.run", command: "powershell", params: {} },
    { operation: "command.run", command: "search.files", params: { argv: ["--exec"] } },
    { operation: "file.read", path: "a", extra: true },
    { operation: "file.copy", source: "a", destination: "b", extra: true },
    { operation: "file.restore", trashId: "not-an-id" },
    { operation: "file.write", path: "a", content: "x", encoding: "hex" },
    { operation: "command.run", command: "search.text", params: { pattern: "" } },
    { operation: "process.run", executable: "node", argv: "--version", cwd: ".", timeoutMs: 1_000, networkProfile: "none" },
    { operation: "process.run", executable: "node", argv: [], cwd: ".", timeoutMs: 0, networkProfile: "none" },
    { operation: "process.run", executable: "node", argv: [], cwd: ".", timeoutMs: 1_000, networkProfile: "web" },
    { operation: "process.run", executable: "node", argv: [], cwd: ".", timeoutMs: 1_000, networkProfile: "none", extra: true },
    { operation: "browser.navigate", url: "file:///secret" },
    { operation: "browser.navigate", url: "https://example.com", extra: true },
    { operation: "browser.click", x: -1, y: 2 },
    { operation: "browser.click_element", elementId: "bad" },
    { operation: "browser.scroll", deltaX: 0, deltaY: 100_000 },
    { operation: "browser.press_key", key: "F12" },
    { operation: "browser.type", text: "x".repeat(70_000) },
    { operation: "browser.upload", selector: "input[type=file]", path: "../secret.txt" },
    { operation: "browser.upload", selector: "input[type=file]", path: "C:\\secret.txt" },
    { operation: "browser.snapshot", includeText: "yes" },
    { operation: "whatsapp", op: "shell" },
    { operation: "whatsapp", op: "send", chat: "C:\\secret.txt", text: "x" },
    { operation: "whatsapp", op: "doctor", extra: true },
    { operation: "whatsapp", op: "sweep", chat: "5511" },
  ])("rejeita entrada não permitida %#", (input) => {
    expect(() => parseExecutionRequest(input)).toThrow(ExecutionRequestError);
  });

  it("defaults omitted search paths to Documents and Projects", () => {
    const files = parseExecutionRequest({ operation: "command.run", command: "search.files", params: {} });
    const text = parseExecutionRequest({ operation: "command.run", command: "search.text", params: { pattern: "needle", mode: "fixed" } });
    expect(files).toMatchObject({ operation: "command.run", params: { paths: [...DEFAULT_SEARCH_PATHS] } });
    expect(text).toMatchObject({ operation: "command.run", params: { paths: [...DEFAULT_SEARCH_PATHS] } });
  });

  it("defaults omitted file.read encoding to utf8", () => {
    expect(parseExecutionRequest({ operation: "file.read", path: "Documents/note.md" })).toMatchObject({
      operation: "file.read",
      path: "Documents/note.md",
      encoding: "utf8",
    });
  });

  it("copia arrays de entrada para manter o request imutável", () => {
    const paths = ["src"];
    const request = parseExecutionRequest({ operation: "command.run", command: "search.files", params: { paths } });
    paths.push("outside");
    expect(request.operation === "command.run" ? request.params.paths : []).toEqual(["src"]);
  });

  it("copia argv e env de process.run para manter o request imutável", () => {
    const argv = ["--version"];
    const env = { NODE_ENV: "test" };
    const request = parseExecutionRequest({
      operation: "process.run",
      executable: "node",
      argv,
      cwd: ".",
      env,
      timeoutMs: 1_000,
      networkProfile: "none",
    });
    argv.push("--help");
    env.NODE_ENV = "changed";
    expect(request).toMatchObject({ operation: "process.run", argv: ["--version"], env: { NODE_ENV: "test" } });
  });
});
