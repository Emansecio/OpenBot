import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeManager, RuntimeManagerError } from "../src/execution/runtime/manager.js";
import { LocalProcessRunner, LocalRuntimeDriver } from "../src/execution/runtime/local/driver.js";
import { RuntimeProcessBackend } from "../src/execution/runtime/process-backend.js";
import { LocalExecutionBroker } from "../src/execution/broker.js";
import { MAX_PROCESS_OUTPUT_BYTES } from "../src/execution/contracts.js";
import type { RuntimeLease } from "../src/execution/runtime/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted local runtime", () => {
  it("preserves bounded, redacted partial output and disk effects through timeout and output-limit failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-partial-"));
    roots.push(root);
    const driver = new LocalRuntimeDriver();
    const manager = new RuntimeManager({ driver });
    const backend = new RuntimeProcessBackend({ agentId: "agent-a", manager, runner: driver.processRunner("agent-a", root) });
    const broker = new LocalExecutionBroker(backend);
    try {
      const result = await broker.execute("agent-a", "timeout", {
        operation: "process.run", executable: process.execPath,
        argv: ["-e", "require('fs').writeFileSync('partial.txt','saved');console.log('BEFORE '+process.env.AUDIT_SECRET);console.error('ERROR-BEFORE');setInterval(()=>{},1000)"],
        cwd: ".", timeoutMs: 600, networkProfile: "host", env: { AUDIT_SECRET: "synthetic-secret-829463" },
      });
      expect(result).toMatchObject({ ok: false, code: "process_timeout", message: expect.stringContaining("Earlier effects"),
        partialOutput: { stdout: expect.stringContaining("BEFORE"), stderr: expect.stringContaining("ERROR-BEFORE"), stdoutTruncated: false } });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret-829463");
      await expect(readFile(join(root, "partial.txt"), "utf8")).resolves.toBe("saved");
      const limited = await broker.execute("agent-a", "limit", {
        operation: "process.run", executable: process.execPath,
        argv: ["-e", `process.stdout.write('prefix'+ 'x'.repeat(${MAX_PROCESS_OUTPUT_BYTES + 100}));setInterval(()=>{},1000)`],
        cwd: ".", timeoutMs: 5000, networkProfile: "host",
      });
      expect(limited).toMatchObject({ ok: false, code: "output_limit", partialOutput: { stdoutTruncated: true } });
      if (!limited.ok) {
        expect(limited.partialOutput?.stdout.startsWith("prefix")).toBe(true);
        expect(Buffer.byteLength(limited.partialOutput!.stdout)).toBeLessThanOrEqual(MAX_PROCESS_OUTPUT_BYTES);
      }
    } finally { await manager.close(); }
  });
  it("stops only the native processes owned by the stopped bot", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-stop-"));
    roots.push(root);
    const driver = new LocalRuntimeDriver();
    const manager = new RuntimeManager({ driver });
    try {
      const a = await manager.acquire("agent-a", { kind: "process.run", networkProfile: "host" });
      const b = await manager.acquire("agent-b", { kind: "process.run", networkProfile: "host" });
      const request = { operation: "process.run" as const, executable: process.execPath,
        argv: ["-e", "console.log('before-stop');require('fs').writeFileSync('ready.txt','ready');setTimeout(()=>require('fs').writeFileSync('late.txt','late'),1000)"],
        cwd: ".", timeoutMs: 4000, networkProfile: "host" as const };
      const pending = driver.processRunner("agent-a", root).run(a, request, new AbortController().signal);
      await vi.waitFor(async () => expect(await readFile(join(root, "ready.txt"), "utf8")).toBe("ready"));
      await manager.stop("agent-a", "manual");
      await expect(pending).resolves.toMatchObject({ ok: false, code: "process_aborted", partialOutput: { stdout: "before-stop\n" } });
      await expect(driver.processRunner("agent-b", root).run(b, { ...request, argv: ["-e", "process.stdout.write('b-alive')"] }, new AbortController().signal))
        .resolves.toMatchObject({ ok: true, stdout: "b-alive" });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await expect(readFile(join(root, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await manager.close(); }
  });

  it("reports the exit of a child that closes stdin before consuming it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-stdin-"));
    roots.push(root);
    const driver = new LocalRuntimeDriver();
    const manager = new RuntimeManager({ driver });
    try {
      const lease = await manager.acquire("agent-a", { kind: "process.run", networkProfile: "host" });
      await expect(driver.processRunner("agent-a", root).run(lease, {
        operation: "process.run", executable: process.execPath, argv: ["-e", "process.exit(0)"], cwd: ".",
        stdin: "x".repeat(1024 * 1024), timeoutMs: 3000, networkProfile: "host",
      }, new AbortController().signal)).resolves.toMatchObject({ ok: true, exitCode: 0 });
    } finally { await manager.close(); }
  });

  it("explains that a bare command name only resolves to an .exe when the process cannot start", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-missing-"));
    roots.push(root);
    const driver = new LocalRuntimeDriver();
    const manager = new RuntimeManager({ driver });
    try {
      const lease = await manager.acquire("agent-a", { kind: "process.run", networkProfile: "host" });
      await expect(driver.processRunner("agent-a", root).run(lease, {
        operation: "process.run", executable: "openbot-definitely-missing-tool", argv: [], cwd: ".", timeoutMs: 5000, networkProfile: "host",
      }, new AbortController().signal)).resolves.toMatchObject({ ok: false, code: "io_error", message: expect.stringContaining("npm.cmd") });
    } finally { await manager.close(); }
  });

  it("runs an installed host executable in an absolute directory outside the agent workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openbot-local-workspace-"));
    const hostDirectory = await mkdtemp(join(tmpdir(), "openbot-local-host-"));
    roots.push(workspace, hostDirectory);
    const runner = new LocalProcessRunner("agent-1", workspace);
    const lease: RuntimeLease = {
      leaseId: "lease-1",
      agentId: "agent-1",
      runtimeBootId: "boot-1",
      sandboxId: "native-lease-1",
      capability: { kind: "process.run", networkProfile: "host" },
      expiresAt: Date.now() + 10_000,
      released: false,
      release: async () => undefined,
    };
    const result = await runner.run(lease, {
      operation: "process.run",
      executable: process.execPath,
      argv: ["-e", "require('node:fs').writeFileSync('host-access.txt', 'ok')"],
      cwd: hostDirectory,
      timeoutMs: 5_000,
      networkProfile: "host",
    }, new AbortController().signal);

    expect(result).toMatchObject({ ok: true, operation: "process.run", exitCode: 0 });
    await expect(readFile(join(hostDirectory, "host-access.txt"), "utf8")).resolves.toBe("ok");

    const denied = await runner.run({ ...lease, capability: { kind: "process.run", networkProfile: "none" } }, {
      operation: "process.run",
      executable: process.execPath,
      argv: ["-e", "process.stdout.write('should-not-run')"],
      cwd: hostDirectory,
      timeoutMs: 5_000,
      networkProfile: "none",
    }, new AbortController().signal);
    expect(denied).toMatchObject({ ok: false, operation: "process.run", code: "process_not_allowed" });
  });

  it("kills the complete Windows process tree on timeout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openbot-local-workspace-"));
    const hostDirectory = await mkdtemp(join(tmpdir(), "openbot-local-tree-"));
    roots.push(workspace, hostDirectory);
    const marker = join(hostDirectory, "orphan.txt");
    const runner = new LocalProcessRunner("agent-1", workspace);
    const lease: RuntimeLease = {
      leaseId: "lease-tree",
      agentId: "agent-1",
      runtimeBootId: "boot-1",
      sandboxId: "native-lease-tree",
      capability: { kind: "process.run", networkProfile: "host" },
      expiresAt: Date.now() + 10_000,
      released: false,
      release: async () => undefined,
    };
    const childScript = "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), 1000)";
    const parentScript = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'}); setInterval(()=>{},1000)";
    const result = await runner.run(lease, {
      operation: "process.run",
      executable: process.execPath,
      argv: ["-e", parentScript, childScript, marker],
      cwd: hostDirectory,
      timeoutMs: 500,
      networkProfile: "host",
    }, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, operation: "process.run", code: "timed_out" });
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
