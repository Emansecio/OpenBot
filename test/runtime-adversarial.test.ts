import { describe, expect, it } from "vitest";

import { RuntimeManager } from "../src/execution/runtime/manager.js";
import { assertManagedRuntimePath, WslRuntimeAdapter } from "../src/execution/runtime/wsl/adapter.js";
import { encodeRuntimeFrame, parseRuntimeFrame, ReplayGuard } from "../src/execution/runtime/wsl/transport.js";

const frame = () => ({
  protocolVersion: 1 as const,
  type: "acquire" as const,
  runtimeBootId: "boot-1",
  leaseId: "lease-1",
  agentId: "agent-a",
  nonce: "nonce-1",
  deadline: Date.now() + 5_000,
  policyDigest: "a".repeat(64),
  payload: {},
});

describe("runtime adversarial boundaries", () => {
  it("rejects workspace/runtime roots that escape through traversal", () => {
    expect(() => assertManagedRuntimePath("C:\\OpenBot\\runtime", "C:\\OpenBot\\runtime\\..\\other")).toThrow(/outside/i);
  });

  it("rejects a reused nonce in ReplayGuard and stale boot identity in the adapter", async () => {
    const parsed = parseRuntimeFrame(encodeRuntimeFrame(frame()));
    const replayGuard = new ReplayGuard();
    expect(parsed.nonce).toBe("nonce-1");
    expect(replayGuard.accept(parsed.nonce)).toBe(true);
    expect(replayGuard.accept(parsed.nonce)).toBe(false);
    expect(() => parseRuntimeFrame(JSON.stringify({ ...frame(), nonce: "" }))).toThrow(/nonce/i);

    const adapter = new WslRuntimeAdapter({
      runtimeRoot: "C:\\OpenBot\\runtime",
      transport: {
        async start() { return { runtimeBootId: "boot-1", runtimeVersion: "1", imageDigest: `sha256:${"a".repeat(64)}` }; },
        async health() { return { ok: true as const }; },
        async acquire() { return { sandboxId: "sandbox" }; },
        async release() {},
        async stop() {},
      },
    });
    await adapter.start();
    const request = {
      leaseId: parsed.leaseId!,
      agentId: parsed.agentId!,
      runtimeBootId: "old-boot",
      capability: { kind: "process.run" as const, networkProfile: "none" as const },
      policyDigest: parsed.policyDigest,
      expiresAt: parsed.deadline,
    };
    await expect(adapter.acquire(request)).rejects.toThrow(/boot identity is stale/i);
    await expect(adapter.acquire({ ...request, runtimeBootId: "boot-1" })).resolves.toEqual({ sandboxId: "sandbox" });
  });

  it("does not allow a manager lease for a fenced agent", async () => {
    const manager = new RuntimeManager({
      driver: {
        async start() { return { runtimeBootId: "boot", runtimeVersion: "1", imageDigest: `sha256:${"a".repeat(64)}` }; },
        async health() { return { ok: true as const }; },
        async acquire() { return { sandboxId: "sandbox" }; },
        async release() {},
        async stop() {},
      },
    });
    manager.fenceAgent("agent-a");
    await expect(manager.acquire("agent-a", { kind: "process.run", networkProfile: "none" })).rejects.toMatchObject({ code: "agent_fenced" });
  });
});
