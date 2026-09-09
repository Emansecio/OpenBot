import { mkdir, mkdtemp, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
  };
});

import * as fsp from "node:fs/promises";

import {
  assertManagedRuntimePath,
  validateRuntimeDistroName,
  WslRuntimeAdapter,
  type WslSupervisorTransport,
} from "../src/execution/runtime/wsl/adapter.js";
import {
  createManagedRuntimeLayout,
  readRuntimeManifest,
  writeRuntimeManifest,
  type RuntimeImageManifest,
} from "../src/execution/runtime/wsl/installer.js";
import { parseWslDistroList, probeWslAvailability } from "../src/execution/runtime/wsl/health.js";
import { WslGuestClient } from "../src/execution/runtime/wsl/guest-runner.js";
import { WslRuntimeResourceReconciler } from "../src/execution/runtime/wsl/reconciler.js";
import type { WslCommandRunner } from "../src/execution/runtime/wsl/provisioner.js";
import {
  MAX_RUNTIME_FRAME_BYTES,
  ReplayGuard,
  encodeRuntimeFrame,
  parseRuntimeFrame,
  type RuntimeFrame,
} from "../src/execution/runtime/wsl/transport.js";
import type {
  RuntimeBoot,
  RuntimeDriverLease,
  RuntimeHealth,
  RuntimeLeaseRequest,
  StopReason,
} from "../src/execution/runtime/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fsp.writeFile).mockImplementation(actual.writeFile);
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
});

class FakeTransport implements WslSupervisorTransport {
  calls: Array<{ method: "start" | "health" | "acquire" | "release" | "stop"; value?: unknown }> = [];
  stops: StopReason[] = [];
  releases: string[] = [];
  async start(): Promise<RuntimeBoot> {
    this.calls.push({ method: "start" });
    return { runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` };
  }
  async health(boot: RuntimeBoot): Promise<RuntimeHealth> {
    this.calls.push({ method: "health", value: boot });
    return { ok: true };
  }
  async acquire(request: RuntimeLeaseRequest): Promise<RuntimeDriverLease> {
    this.calls.push({ method: "acquire", value: request });
    return { sandboxId: `sandbox-${request.agentId}` };
  }
  async release(lease: RuntimeDriverLease): Promise<void> {
    this.calls.push({ method: "release", value: lease });
    this.releases.push(lease.leaseId ?? "missing");
  }
  async stop(reason: StopReason): Promise<void> {
    this.calls.push({ method: "stop", value: reason });
    this.stops.push(reason);
  }
}

class FakeRunner implements WslCommandRunner {
  readonly calls: Array<{ args: string[]; input?: Buffer }> = [];
  responses: Array<{ exitCode: number; stdout: Buffer; stderr: Buffer }> = [];

  async run(args: readonly string[], _signal?: AbortSignal, input?: Buffer) {
    this.calls.push({ args: [...args], ...(input === undefined ? {} : { input }) });
    return this.responses.shift() ?? { exitCode: 0, stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
  }
}

const frame = (overrides: Partial<RuntimeFrame> = {}): RuntimeFrame => ({
  protocolVersion: 1,
  type: "health",
  runtimeBootId: "boot-1",
  leaseId: "lease-1",
  agentId: "agent-a",
  nonce: "nonce-1",
  deadline: Date.now() + 5_000,
  policyDigest: "a".repeat(64),
  payload: {},
  ...overrides,
});

describe("WSL runtime identity and transport", () => {
  it("aceita somente a distro administrada OpenBotRuntime", () => {
    expect(validateRuntimeDistroName("OpenBotRuntime")).toBe("OpenBotRuntime");
    expect(() => validateRuntimeDistroName("Ubuntu")).toThrow(/managed/i);
    expect(() => validateRuntimeDistroName("OpenBotRuntime; evil")).toThrow(/managed/i);
  });

  it("não permite que artefatos do runtime escapem da raiz administrada", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-runtime-"));
    roots.push(root);
    expect(assertManagedRuntimePath(root, join(root, "distro"))).toBe(true);
    expect(() => assertManagedRuntimePath(root, join(root, "..", "personal"))).toThrow(/outside/i);
  });

  it("serializa frames estritos e rejeita campos extras, tamanho e replay", () => {
    const original = frame();
    const encoded = encodeRuntimeFrame(original);
    expect(parseRuntimeFrame(encoded)).toEqual(original);
    expect(() => parseRuntimeFrame(JSON.stringify({ ...frame(), extra: true }))).toThrow(/unsupported/i);
    expect(() => parseRuntimeFrame("x".repeat(MAX_RUNTIME_FRAME_BYTES + 1))).toThrow(/frame/i);

    const replay = new ReplayGuard();
    expect(replay.accept("nonce-1")).toBe(true);
    expect(replay.accept("nonce-1")).toBe(false);
  });

  it("cria layout gerenciado e grava manifesto em staging de forma atômica", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-runtime-layout-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const manifest: RuntimeImageManifest = {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      imageDigest: `sha256:${"b".repeat(64)}`,
    };
    await writeRuntimeManifest(layout, manifest);
    await expect(readRuntimeManifest(layout)).resolves.toEqual(manifest);
    expect((await readdir(layout.staging)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

    const target = join(layout.staging, "runtime-manifest.json");
    await unlink(target);
    await mkdir(target);
    await expect(writeRuntimeManifest(layout, manifest)).rejects.toThrow();
    expect((await readdir(layout.staging)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("remove o manifesto temporário quando a escrita parcial falha", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "openbot-runtime-partial-manifest-"));
    roots.push(root);
    const layout = await createManagedRuntimeLayout(root);
    const writeFailure = new Error("injected partial write failure");
    vi.mocked(fsp.writeFile).mockImplementationOnce(async (file, data, options) => {
      await actual.writeFile(file, String(data).slice(0, 8), options);
      throw writeFailure;
    });

    await expect(writeRuntimeManifest(layout, {
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      imageDigest: `sha256:${"b".repeat(64)}`,
    })).rejects.toBe(writeFailure);
    expect((await readdir(layout.staging)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("normaliza a saída UTF-16 do wsl.exe sem aceitar a distro pessoal", () => {
    const output = [String.fromCharCode(0), "OpenBotRuntime", String.fromCharCode(0, 13, 10, 0), "Ubuntu-24.04", String.fromCharCode(0, 13, 10)].join("");
    expect(parseWslDistroList(output)).toEqual(["OpenBotRuntime", "Ubuntu-24.04"]);
    expect(probeWslAvailability({
      defaultVersion: 2,
      distros: ["Ubuntu"],
    })).toMatchObject({ supported: true, dedicatedDistroPresent: false });
  });

  it("recusa frame expirado e endpoint não local", () => {
    expect(() => parseRuntimeFrame(encodeRuntimeFrame(frame({ deadline: Date.now() - 1 })))).toThrow(/deadline/i);
    expect(() => parseRuntimeFrame(encodeRuntimeFrame(frame({ endpoint: "0.0.0.0" } as never)))).toThrow(/unsupported/i);
  });

  it("recusa runtimeBootId malformado antes de qualquer uso em shell", async () => {
    const runner: WslCommandRunner = {
      run: async () => ({
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({
          runtimeBootId: "boot; touch /tmp/openbot-boot-injection",
          runtimeVersion: "1.0.0",
          imageDigest: `sha256:${"a".repeat(64)}`,
        })),
        stderr: Buffer.alloc(0),
      }),
    };
    const client = new WslGuestClient({ runner });
    await expect(client.start()).rejects.toThrow(/boot identity/i);
  });
});

describe("WslRuntimeAdapter", () => {
  it("delega o ciclo de vida ao transport configurado e mantém a identidade da distro", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-runtime-adapter-"));
    roots.push(root);
    const transport = new FakeTransport();
    const adapter = new WslRuntimeAdapter({ runtimeRoot: root, transport });

    expect(adapter.distroName).toBe("OpenBotRuntime");
    const boot = await adapter.start();
    expect(boot.runtimeBootId).toBe("boot-1");
    expect(await adapter.health(boot)).toEqual({ ok: true });
    const lease = await adapter.acquire({
      leaseId: "lease-1",
      agentId: "agent-a",
      runtimeBootId: "boot-1",
      capability: { kind: "process.run", networkProfile: "none" },
      policyDigest: "a".repeat(64),
      expiresAt: Date.now() + 5_000,
    });
    await adapter.release({ ...lease, leaseId: "lease-1" });
    await adapter.stop("shutdown");
    expect(transport.releases).toEqual(["lease-1"]);
    expect(transport.stops).toEqual(["shutdown"]);
    expect(transport.calls).toEqual([
      { method: "start" },
      { method: "health", value: boot },
      { method: "acquire", value: expect.objectContaining({ runtimeBootId: boot.runtimeBootId, agentId: "agent-a" }) },
      { method: "release", value: { ...lease, leaseId: "lease-1" } },
      { method: "stop", value: "shutdown" },
    ]);
  });

  it("compensa acquire perdido usando a identidade determinística do lease", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
    ];
    const client = new WslGuestClient({ runner });
    await client.start();
    await client.compensateAcquire({
      leaseId: "lease-1",
      agentId: "agent-a",
      runtimeBootId: "boot-1",
      capability: { kind: "process.run", networkProfile: "none" },
      policyDigest: "a".repeat(64),
      expiresAt: Date.now() + 5_000,
    });

    const encoded = runner.calls[1]?.input?.toString("utf8") ?? "";
    expect(parseRuntimeFrame(encoded).payload).toMatchObject({ sandboxId: "sandbox-lease-1" });
  });

  it("rejeita sandbox retornado para uma identidade diferente do lease", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ sandboxId: "sandbox-another-lease" })), stderr: Buffer.alloc(0) },
    ];
    const client = new WslGuestClient({ runner });
    await client.start();

    await expect(client.acquire({
      leaseId: "lease-1",
      agentId: "agent-a",
      runtimeBootId: "boot-1",
      capability: { kind: "process.run", networkProfile: "none" },
      policyDigest: "a".repeat(64),
      expiresAt: Date.now() + 5_000,
    })).rejects.toMatchObject({ code: "runtime_protocol_error" });
  });

  it("não confirma release quando o supervisor rejeita a limpeza do lease", async () => {
    vi.useFakeTimers();
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false, code: "teardown_incomplete", message: "cleanup pending" })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false, code: "teardown_incomplete", message: "cleanup pending" })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false, code: "teardown_incomplete", message: "cleanup pending" })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false, code: "teardown_incomplete", message: "cleanup pending" })), stderr: Buffer.alloc(0) },
    ];
    const client = new WslGuestClient({ runner });
    try {
      await client.start();

      const releasing = expect(client.release({ leaseId: "lease-1", sandboxId: "sandbox-lease-1" }))
        .rejects.toThrow(/cleanup/i);
      await vi.advanceTimersByTimeAsync(850);
      await releasing;
    } finally {
      vi.useRealTimers();
    }
  });

  it("repete release quando o supervisor ainda está concluindo o teardown", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false, code: "teardown_incomplete", message: "cleanup pending" })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
    ];
    const client = new WslGuestClient({ runner });
    await client.start();

    await expect(client.release({ leaseId: "lease-1", sandboxId: "sandbox-lease-1" }))
      .resolves.toBeUndefined();
    expect(runner.calls).toHaveLength(3);
  });

  it("recusa construção apontando para a distro pessoal", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-runtime-personal-"));
    roots.push(root);
    expect(() => new WslRuntimeAdapter({ runtimeRoot: root, distroName: "Ubuntu", transport: new FakeTransport() })).toThrow(/managed/i);
  });
});

describe("WslRuntimeResourceReconciler", () => {
  const orphan = {
    leaseId: "lease-1",
    agentId: "agent-a",
    runtimeBootId: "boot-old",
    sandboxId: "sandbox-lease-1",
    temporaryId: "tmp-lease-1",
  };

  it("usa o boot já iniciado pelo manager sem iniciar o guest novamente", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-current", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
    ];
    const client = new WslGuestClient({ runner });
    const boot = await client.start();
    const reconciler = new WslRuntimeResourceReconciler({ client, runner });

    await expect(reconciler.reconcileLease(orphan, boot)).resolves.toBeUndefined();
    expect(runner.calls.filter((call) => call.args.at(-1) === "start")).toHaveLength(1);
  });

  it("permite repetir a recuperação quando a tentativa compartilhada falha", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("start failed") },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-retry", runtimeVersion: "1.0.0", imageDigest: `sha256:${"b".repeat(64)}` })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
    ];
    const client = new WslGuestClient({ runner });
    const reconciler = new WslRuntimeResourceReconciler({ client, runner });

    await expect(reconciler.reconcileLease(orphan)).rejects.toThrow(/could not be proved/i);
    await expect(reconciler.reconcileLease(orphan)).resolves.toBeUndefined();
    expect(runner.calls.filter((call) => call.args.at(-1) === "start")).toHaveLength(2);
  });
});

describe("WslGuestClient stop", () => {
  it("limita o tempo de wsl --terminate e permite que o fechamento prossiga", async () => {
    let terminateSignal: AbortSignal | undefined;
    const runner: WslCommandRunner = {
      run: async (args, signal) => {
        if (args[0] === "--terminate") {
          terminateSignal = signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        if (args.at(-1) === "start") {
          return {
            exitCode: 0,
            stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"c".repeat(64)}` })),
            stderr: Buffer.alloc(0),
          };
        }
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) };
      },
    };
    const client = new WslGuestClient({ runner, stopTimeoutMs: 20 });
    await client.start();

    await expect(client.stop("shutdown")).rejects.toThrow(/timed out/i);
    expect(terminateSignal?.aborted).toBe(true);
  });
});

describe("WslGuestClient start recovery", () => {
  it("repete de forma limitada quando um teardown abortado ainda está terminando", async () => {
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false, code: "teardown_incomplete", message: "cleanup pending" })), stderr: Buffer.alloc(0) },
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-recovered", runtimeVersion: "1.0.0", imageDigest: `sha256:${"d".repeat(64)}` })), stderr: Buffer.alloc(0) },
    ];
    const client = new WslGuestClient({ runner });

    await expect(client.start()).resolves.toMatchObject({ runtimeBootId: "boot-recovered" });
    expect(runner.calls.filter((call) => call.args.at(-1) === "start")).toHaveLength(2);
  });
});
