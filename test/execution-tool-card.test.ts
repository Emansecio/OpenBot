import { describe, expect, it } from "vitest";
import { stableToolCallId, toolCallResult, toolCallSummary } from "../src/execution/tool-card.js";

describe("tool-card helpers", () => {
  it("keeps a provider id and is stable for empty ids", () => {
    expect(stableToolCallId("abc", "file", "{}")).toBe("abc");
    expect(stableToolCallId("", "file", '{"op":"list"}')).toBe(stableToolCallId("", "file", '{"op":"list"}'));
    expect(stableToolCallId("", "file", "a")).not.toBe(stableToolCallId("", "file", "b"));
  });

  it("summarizes only allowlisted tool metadata without leaking sensitive arguments", () => {
    expect(toolCallSummary("file", '{"op":"write","path":"Documents/a.md"}')).toBe("write Documents/a.md");
    expect(toolCallSummary("search_text", '{"pattern":"needle"}')).toBe("search text");
    expect(toolCallSummary("search_skills", '{"query":"testes"}')).toBe("search skills");
    expect(toolCallSummary("use_skill", '{"id":"tdd","secret":"do-not-show"}')).toBe("use skill tdd");
    expect(toolCallSummary("mcp__github__create_issue", '{"token":"do-not-show"}')).toBe("MCP github");
    expect(toolCallSummary("browser_type", '{"text":"super-secret-password"}')).toBe("type in browser");
    expect(toolCallSummary("browser_navigate", '{"url":"https://user:pass@example.com/path?q=token#frag"}')).toBe("navigate https://example.com");
    expect(toolCallSummary("process_run", '{"executable":"python","argv":["app.py"],"stdin":"secret","env":{"API_KEY":"secret"}}')).toBe("run process");
    expect(toolCallSummary("whatsapp", '{"op":"sweep"}')).toBe("whatsapp sweep");
    const result = toolCallResult(
      { ok: true, operation: "file.write", bytes: 3 },
      { operation: "file.write", path: "Documents/a.md", content: "abc", encoding: "utf8" },
    );
    expect(result).toEqual({ ok: true, operation: "file.write", bytes: 3, path: "Documents/a.md" });
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:\\/);
  });

  it("sanitizes every summary and caps it at 120 characters", () => {
    const pattern = "segredo".repeat(100);
    const summary = toolCallSummary("search_text", JSON.stringify({ pattern }));

    expect([...summary].length).toBeLessThanOrEqual(120);
    expect(summary).toBe("search text");
    expect(summary).not.toContain(pattern);
    const unknown = toolCallSummary("unknown", JSON.stringify({ secret: "x".repeat(500) }));
    expect([...unknown].length).toBeLessThanOrEqual(120);
    expect(unknown).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(unknown).toBe("tool unknown");
    expect(toolCallSummary("search_text", JSON.stringify({ pattern: "line\nsecret" }))).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("não inclui args MCP malformados no resumo", () => {
    const summary = toolCallSummary("mcp__demo__echo", '{"authorization":"SUPERSECRET_123","unterminated":');

    expect(summary).toBe("MCP demo");
    expect(summary).not.toContain("SUPERSECRET_123");
  });

  it("redacts absolute paths and never falls back to raw unknown arguments", () => {
    expect(toolCallSummary("file", '{"op":"write","path":"C:\\\\Users\\\\User\\\\secret.txt"}')).toBe("write file");
    expect(toolCallSummary("unknown", '{"command":"curl https://example.com?token=abc","secret":"SUPERSECRET_123"}')).toBe("tool unknown");
    expect(toolCallSummary("browser_navigate", '{"url":"not a valid url with token=abc"}')).toBe("navigate browser");
  });

  it("never exposes browser navigation path segments that may carry secrets", () => {
    const summary = toolCallSummary("browser_navigate", '{"url":"https://user:pass@example.com/reset/SECRET_TOKEN?q=another-secret#frag"}');

    expect(summary).toBe("navigate https://example.com");
    expect(summary).not.toContain("reset");
    expect(summary).not.toContain("SECRET_TOKEN");
    expect(summary).not.toContain("user:pass");
  });
});
