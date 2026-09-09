import { describe, expect, it } from "vitest";

import {
  PUBLIC_READONLY_URLS,
  assertPublicReadonlyCommand,
  assertPublicReadonlyUrl,
  classifyPublicReadonlyFailure,
  type PublicReadonlyGateError,
} from "../src/browser/public-readonly-gate.js";

describe("browser public read-only gate policy", () => {
  it("accepts only the fixed HTTPS URLs without credentials, query, or fragment", () => {
    for (const url of PUBLIC_READONLY_URLS) {
      expect(assertPublicReadonlyUrl(url)).toBe(url);
    }

    for (const url of [
      "http://example.com/",
      "https://example.com/path",
      "https://example.com/?q=1",
      "https://example.com/#fragment",
      "https://user:password@example.com/",
      "https://not-allowlisted.example/",
    ]) {
      expect(() => assertPublicReadonlyUrl(url)).toThrow();
    }
  });

  it("allows only open, navigate, snapshot, and screenshot", () => {
    expect(assertPublicReadonlyCommand({ command: "open", url: PUBLIC_READONLY_URLS[0] })).toEqual({
      command: "open",
      url: PUBLIC_READONLY_URLS[0],
    });
    expect(assertPublicReadonlyCommand({ command: "navigate", url: PUBLIC_READONLY_URLS[1] })).toEqual({
      command: "navigate",
      url: PUBLIC_READONLY_URLS[1],
    });
    expect(assertPublicReadonlyCommand({ command: "snapshot", includeText: true })).toEqual({
      command: "snapshot",
      includeText: true,
    });
    expect(assertPublicReadonlyCommand({ command: "screenshot", fullPage: false })).toEqual({
      command: "screenshot",
      fullPage: false,
    });

    for (const command of [
      { command: "click", x: 1, y: 1 },
      { command: "type", text: "mutate" },
      { command: "upload", selector: "input", path: "file.txt" },
      { command: "download" },
      { command: "popup" },
    ]) {
      try {
        assertPublicReadonlyCommand(command as never);
        throw new Error("expected command to be rejected");
      } catch (error) {
        expect((error as PublicReadonlyGateError).code).toBe("PUBLIC_READONLY_COMMAND_FORBIDDEN");
      }
    }
  });

  it("classifies only environment network failures as BLOCKED_ENV", () => {
    expect(classifyPublicReadonlyFailure(Object.assign(new Error("DNS resolution timed out"), { code: "dns_timeout" }))).toBe("BLOCKED_ENV");
    expect(classifyPublicReadonlyFailure(Object.assign(new Error("certificate verify failed"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }))).toBe("BLOCKED_ENV");
    expect(classifyPublicReadonlyFailure(Object.assign(new Error("browser command timed out"), { code: "BROWSER_COMMAND_TIMEOUT" }))).toBe("RED");
    expect(classifyPublicReadonlyFailure(Object.assign(new Error("ERR_FAILED loading public URL"), { code: "ERR_FAILED" }))).toBe("RED");
    expect(classifyPublicReadonlyFailure(Object.assign(new Error("browser snapshot failed"), { code: "BROWSER_COMMAND_FAILED" }))).toBe("RED");
  });
});
