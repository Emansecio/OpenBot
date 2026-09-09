import { describe, expect, it } from "vitest";

import {
  capabilityDigest,
  parseRuntimeCapability,
  runtimeCapabilityForRequest,
} from "../src/execution/runtime/policy.js";

describe("runtime policy", () => {
  it("aceita process.run no host", () => {
    const capability = parseRuntimeCapability({ kind: "process.run", networkProfile: "host" });
    expect(capability).toEqual({ kind: "process.run", networkProfile: "host" });
    expect(runtimeCapabilityForRequest({
      operation: "process.run",
      executable: "node",
      argv: [],
      cwd: ".",
      timeoutMs: 1000,
      networkProfile: "host",
    })).toEqual(capability);
  });

  it("rejeita capability de navegador ou perfil desconhecido", () => {
    expect(() => parseRuntimeCapability({ kind: "process.run", networkProfile: "web" })).toThrow(/network/i);
    expect(() => parseRuntimeCapability({ kind: "browser.start" })).toThrow(/unsupported/i);
  });

  it("produz digest estável para a capability exata", () => {
    const capability = parseRuntimeCapability({ kind: "process.run", networkProfile: "none" });
    expect(capabilityDigest(capability)).toBe(capabilityDigest({ ...capability }));
    expect(capabilityDigest(capability)).toMatch(/^[a-f0-9]{64}$/);
  });
});
