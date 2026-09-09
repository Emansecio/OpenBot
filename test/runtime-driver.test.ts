import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WslCommandResult, WslCommandRunner } from "../src/execution/runtime/wsl/provisioner.js";
import { createDefaultWslRuntimeDriver } from "../src/execution/runtime/wsl/driver.js";
import { createManagedRuntimeLayout } from "../src/execution/runtime/wsl/installer.js";
import { RuntimeManager, RuntimeManagerError } from "../src/execution/runtime/manager.js";
import { LocalProcessRunner, LocalRuntimeDriver } from "../src/execution/runtime/local/driver.js";
import { WslProcessBackend } from "../src/execution/runtime/wsl/process-backend.js";
import { LocalExecutionBroker } from "../src/execution/broker.js";
import { MAX_PROCESS_OUTPUT_BYTES } from "../src/execution/contracts.js";
import type { RuntimeLease } from "../src/execution/runtime/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeRunner implements WslCommandRunner {
  readonly calls: string[][] = [];
  responses: WslCommandResult[] = [];
  async run(args: readonly string[]): Promise<WslCommandResult> {
    this.calls.push([...args]);
    return this.responses.shift() ?? { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

const bootJson = JSON.stringify({ runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` });

describe("default WSL runtime driver", () => {
  it("não toca Ubuntu pessoal quando OpenBotRuntime não está instalada", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-driver-missing-"));
    roots.push(root);
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from("Default Version: 2\n"), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from("Ubuntu\n"), stderr: Buffer.alloc(0) },
    ];
    const driver = createDefaultWslRuntimeDriver({ runtimeRoot: root, runner });

    await expect(driver.start()).rejects.toMatchObject({ code: "runtime_unavailable" } satisfies Partial<RuntimeManagerError>);
    expect(runner.calls).toEqual([["--status"], ["--list", "--quiet"]]);
    expect(runner.calls.flat()).not.toContain("Ubuntu");
  });

  it("importa automaticamente somente um pacote guest staged e revalida a distro gerenciada", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-driver-staged-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const archive = join(layout.staging, "openbot-runtime-package.tar");
    await writeFile(archive, "archive");
    await writeFile(join(layout.staging, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      supervisorVersion: "0.1.0",
      supervisorDigest: `sha256:${"c".repeat(64)}`,
      rootfsDigest: `sha256:${"d".repeat(64)}`,
    }));
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from("Default Version: 2\n"), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from("Ubuntu\n"), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from("Ubuntu\n"), stderr: Buffer.alloc(0) }, // transactional install --list
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import candidate
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) }, // candidate version
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "candidate-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) }, // candidate start
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) }, // candidate health
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate candidate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // import final
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ supervisorVersion: "0.1.0", supervisorDigest: `sha256:${"c".repeat(64)}` })), stderr: Buffer.alloc(0) }, // final version
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "final-boot", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) }, // final start
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) }, // final health
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // terminate candidate
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, // unregister candidate
      { exitCode: 0, stdout: Buffer.from("Default Version: 2\n"), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from("OpenBotRuntime\n"), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(bootJson), stderr: Buffer.alloc(0) },
    ];
    const driver = createDefaultWslRuntimeDriver({ runtimeRoot: root, runner });

    await expect(driver.start()).resolves.toMatchObject({ runtimeBootId: "boot-1" });
    expect(runner.calls).toContainEqual(["--import", "OpenBotRuntimeCandidate", expect.stringContaining("distro-candidate"), archive, "--version", "2"]);
    expect(runner.calls).toContainEqual(["--import", "OpenBotRuntime", layout.distro, archive, "--version", "2"]);
    expect(runner.calls).toContainEqual(["-d", "OpenBotRuntimeCandidate", "--user", "root", "--", "/usr/lib/openbot/supervisor", "--protocol-version", "1", "version"]);
    expect(runner.calls).toContainEqual(["-d", "OpenBotRuntime", "--user", "root", "--", "/usr/lib/openbot/supervisor", "--protocol-version", "1", "version"]);
    expect(runner.calls.flat()).not.toContain("Ubuntu-24.04");
  });

  it("inicia, faz health e encerra somente OpenBotRuntime por argumentos estruturados", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-driver-ready-"));
    roots.push(root);
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from("Default Version: 2\n"), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from("OpenBotRuntime\n"), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(bootJson), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
    ];
    const driver = createDefaultWslRuntimeDriver({ runtimeRoot: root, runner });
    const boot = await driver.start();
    expect(boot.runtimeBootId).toBe("boot-1");
    await expect(driver.health(boot)).resolves.toEqual({ ok: true });
    await driver.stop("shutdown");
    expect(runner.calls.slice(2).map((args) => args.slice(0, 4))).toEqual([
      ["-d", "OpenBotRuntime", "--user", "root"],
      ["-d", "OpenBotRuntime", "--user", "root"],
      ["-d", "OpenBotRuntime", "--user", "root"],
      ["--terminate", "OpenBotRuntime"],
    ]);
    expect(runner.calls.flat()).not.toContain("Ubuntu");
  });

  it("propaga uma distro live aleatória somente pelo seam explicitamente habilitado", async () => {
    vi.stubEnv("OPENBOT_RUNTIME_WSL_LIVE_TEST", "1");
    const root = await mkdtemp(join(tmpdir(), "openbot-driver-live-seam-"));
    roots.push(root);
    const distro = "OpenBotRuntimeLive-12345678-1234-1234-1234-123456789abc";
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from("Default Version: 2\n"), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(`${distro}\n`), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(bootJson), stderr: Buffer.alloc(0) },
    ];

    const driver = createDefaultWslRuntimeDriver({ runtimeRoot: root, runner, distroName: distro });
    await expect(driver.start()).resolves.toMatchObject({ runtimeBootId: "boot-1" });
    expect(runner.calls).toContainEqual([
      "-d", distro, "--user", "root", "--", "/usr/lib/openbot/supervisor", "--protocol-version", "1", "start",
    ]);
  });

  it("recusa a distro live sem a flag de ambiente", async () => {
    vi.stubEnv("OPENBOT_RUNTIME_WSL_LIVE_TEST", "0");
    const root = await mkdtemp(join(tmpdir(), "openbot-driver-live-closed-"));
    roots.push(root);
    expect(() => createDefaultWslRuntimeDriver({
      runtimeRoot: root,
      runner: new FakeRunner(),
      distroName: "OpenBotRuntimeLive-12345678-1234-1234-1234-123456789abc",
    })).toThrow(/not permitted/i);
  });
});

describe("trusted local runtime", () => {
  it("preserves bounded, redacted partial output and disk effects through timeout and output-limit failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-partial-"));
    roots.push(root);
    const driver = new LocalRuntimeDriver();
    const manager = new RuntimeManager({ driver });
    const backend = new WslProcessBackend({ agentId: "agent-a", manager, runner: driver.processRunner("agent-a", root) });
    const broker = new LocalExecutionBroker(backend, () => "always");
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

  it("returns an honest failure when the child closes stdin before consuming it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-stdin-"));
    roots.push(root);
    const driver = new LocalRuntimeDriver();
    const manager = new RuntimeManager({ driver });
    try {
      const lease = await manager.acquire("agent-a", { kind: "process.run", networkProfile: "host" });
      await expect(driver.processRunner("agent-a", root).run(lease, {
        operation: "process.run", executable: process.execPath, argv: ["-e", "process.exit(0)"], cwd: ".",
        stdin: "x".repeat(1024 * 1024), timeoutMs: 3000, networkProfile: "host",
      }, new AbortController().signal)).resolves.toMatchObject({ ok: false, code: "io_error", message: expect.stringContaining("stdin") });
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
