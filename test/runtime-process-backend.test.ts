import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentRuntimeManager,
  RuntimeCapability,
  RuntimeLease,
} from "../src/execution/runtime/contracts.js";
import { RuntimeManagerError } from "../src/execution/runtime/manager.js";
import { WslProcessBackend, type RuntimeProcessRunner } from "../src/execution/runtime/wsl/process-backend.js";
import { LocalFileExecutor } from "../src/execution/files.js";
import { WorkspaceQuota, WorkspaceQuotaError } from "../src/execution/quota.js";
import { WorkspaceSandbox } from "../src/execution/workspace.js";
import {
  MAX_PROCESS_OUTPUT_BYTES,
  type ExecutionRequest,
  type ExecutionResult,
} from "../src/execution/contracts.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const request = (overrides: Partial<Extract<ExecutionRequest, { operation: "process.run" }>> = {}): Extract<ExecutionRequest, { operation: "process.run" }> => ({
  operation: "process.run",
  executable: "node",
  argv: ["--version"],
  cwd: ".",
  timeoutMs: 1_000,
  networkProfile: "none",
  ...overrides,
});

const success = (overrides: Partial<Extract<ExecutionResult, { ok: true; operation: "process.run" }>> = {}): Extract<ExecutionResult, { ok: true; operation: "process.run" }> => ({
  ok: true,
  operation: "process.run",
  stdout: "v22.0.0",
  stderr: "",
  exitCode: 0,
  durationMs: 1,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const lease = (release = vi.fn(async () => undefined)): RuntimeLease => ({
  leaseId: "lease-1",
  agentId: "agent-a",
  runtimeBootId: "boot-1",
  sandboxId: "sandbox-1",
  capability: { kind: "process.run", networkProfile: "none" },
  expiresAt: Date.now() + 5_000,
  released: false,
  release,
});

const managerFor = (value: RuntimeLease | Error): AgentRuntimeManager => ({
  ensure: vi.fn(),
  acquire: vi.fn(async (_agentId: string, _capability: RuntimeCapability) => {
    if (value instanceof Error) throw value;
    return value;
  }),
  status: vi.fn(),
  stop: vi.fn(),
  repair: vi.fn(),
  close: vi.fn(),
});

describe("WslProcessBackend", () => {
  it("recusa process.run antes do lease quando o workspace já excedeu a quota", async () => {
    const held = lease();
    const manager = managerFor(held);
    const runner: RuntimeProcessRunner = { run: vi.fn(async () => success()) };
    const quota = { assertWithinQuota: vi.fn(async () => { throw new WorkspaceQuotaError(); }) };
    const backend = new WslProcessBackend({ agentId: "agent-a", manager, runner, quota });

    await expect(backend.execute(request())).resolves.toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(manager.acquire).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(held.release).not.toHaveBeenCalled();
  });

  it("does not start the runner when quota authority fails during queued lease acquisition", async () => {
    let failQuota!: (error: Error) => void;
    const close = vi.fn(async () => undefined);
    const quota = {
      assertWithinQuota: vi.fn(async () => undefined),
      observeProcesses: async (onError: (error: Error) => void) => {
        failQuota = onError;
        return { drain: async () => undefined, close };
      },
      markUsageDirty: vi.fn(),
    };
    const held = lease();
    const manager = managerFor(held);
    let acquiring!: () => void;
    const acquired = new Promise<void>((resolve) => { acquiring = resolve; });
    let admit!: () => void;
    const admission = new Promise<void>((resolve) => { admit = resolve; });
    vi.mocked(manager.acquire).mockImplementation(async () => {
      acquiring();
      await admission;
      return held;
    });
    const runner = { run: vi.fn(async () => success()) };
    const backend = new WslProcessBackend({ agentId: "agent-a", manager, runner, quota });
    const execution = backend.execute(request());
    await acquired;
    failQuota(new WorkspaceQuotaError());
    admit();
    await expect(execution).resolves.toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(runner.run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("checks scoped limits in the shared initial inventory before lease admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-process-quota-scope-"));
    roots.push(root);
    await mkdir(join(root, "Downloads"));
    await writeFile(join(root, "Downloads", "existing.txt"), "12345");
    const quota = new WorkspaceQuota(await WorkspaceSandbox.create(root), {
      maxBytes: 100, maxFiles: 10, maxEntries: 10,
      scopes: { downloads: { maxBytes: 4, maxFiles: 10 } },
    });
    const manager = managerFor(lease());
    const backend = new WslProcessBackend({ agentId: "agent-a", manager, runner: { run: vi.fn() }, quota });
    await expect(backend.execute(request())).resolves.toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(manager.acquire).not.toHaveBeenCalled();
    expect(quota.metrics()).toMatchObject({ scans: 1, activeObservers: 0, activeProcesses: 0 });
  });

  it("interrompe o lease quando o processo ultrapassa a quota durante a execução", async () => {
    const held = lease();
    const quota = {
      workspaceRoot: "C:\\quota-fixture",
      assertWithinQuota: vi.fn(async () => undefined),
      refreshUsage: vi.fn(async () => undefined),
      applyExternalDelta: vi.fn(async () => undefined),
      markUsageDirty: vi.fn(),
    };
    const runner: RuntimeProcessRunner = {
      run: vi.fn(async (_lease, _request, signal) => await new Promise<ExecutionResult>((resolve) => {
        signal.addEventListener("abort", () => resolve({ ok: false, operation: "process.run", code: "process_aborted", message: "aborted" }), { once: true });
      })),
    };
    const backend = new WslProcessBackend({
      agentId: "agent-a",
      manager: managerFor(held),
      runner,
      quota,
      quotaObserverFactory: ({ onError }) => ({
        start: async () => { setTimeout(() => onError(new WorkspaceQuotaError()), 0); },
        drain: async () => undefined,
        close: async () => undefined,
      }),
    });

    await expect(backend.execute(request({ timeoutMs: 1_000 }))).resolves.toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("expõe números da quota e recalcula uma vez antes do próximo write após abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-process-quota-dirty-"));
    roots.push(root);
    const workspace = await WorkspaceSandbox.create(root);
    const quota = new WorkspaceQuota(workspace, { maxBytes: 4, maxFiles: 10, maxEntries: 10 });
    const excess = join(root, "excess.bin");
    const runner: RuntimeProcessRunner = {
      run: vi.fn(async (_lease, _request, signal) => {
        await writeFile(excess, "12345");
        return await new Promise<ExecutionResult>((resolve) => {
          signal.addEventListener("abort", () => resolve({
            ok: false,
            operation: "process.run",
            code: "process_aborted",
            message: "aborted",
          }), { once: true });
        });
      }),
    };
    const backend = new WslProcessBackend({
      agentId: "agent-a",
      manager: managerFor(lease()),
      runner,
      quota,
    });

    const exceeded = await backend.execute(request());
    expect(exceeded).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(exceeded.ok ? "" : exceeded.message).toMatch(/5.*4|4.*5/u);
    expect(exceeded.ok ? "" : exceeded.message).toMatch(/delete|trash|apague|lixeira/iu);

    await unlink(excess);
    const files = LocalFileExecutor.fromWorkspace(workspace, quota);
    await expect(files.execute({ operation: "file.write", path: "recovered.txt", content: "1", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: true });
  });

  it("faz somente scan inicial e reconciliação final, independentemente da duração", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-process-quota-scans-"));
    roots.push(root);
    const workspace = await WorkspaceSandbox.create(root);
    const scan = vi.fn(async () => ({ bytes: 0, files: 0, directories: 0, entries: 0 }));
    const quota = new WorkspaceQuota(workspace, { maxBytes: 100, maxFiles: 10, maxEntries: 10 }, scan);
    const backend = new WslProcessBackend({
      agentId: "agent-a",
      manager: managerFor(lease()),
      runner: { run: vi.fn(async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
        return success();
      }) },
      quota,
      quotaPollIntervalMs: 1,
      quotaObserverFactory: () => ({
        start: async () => undefined,
        drain: async () => undefined,
        close: async () => undefined,
      }),
    });

    await expect(backend.execute(request())).resolves.toMatchObject({ ok: true });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("shares one observer across backend instances and scans only at group boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-process-quota-overlap-"));
    roots.push(root);
    const quota = new WorkspaceQuota(await WorkspaceSandbox.create(root), { maxBytes: 100, maxFiles: 10, maxEntries: 10, observationIdleMs: 0 });
    const finish: Array<() => void> = [];
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const runner: RuntimeProcessRunner = { run: async () => {
      await new Promise<void>((resolve) => {
        finish.push(resolve);
        if (finish.length === 2) bothStarted();
      });
      return success();
    } };
    const backends = [0, 1].map(() => new WslProcessBackend({ agentId: "agent-a", manager: managerFor(lease()), runner, quota }));
    const executions = backends.map((backend) => backend.execute(request()));
    await started;
    try {
      expect(quota.metrics()).toMatchObject({ scans: 1, observationStarts: 1, activeObservers: 1, activeProcesses: 2 });
      finish[0]!();
      await expect(executions[0]).resolves.toMatchObject({ ok: true });
      expect(quota.metrics()).toMatchObject({ scans: 1, activeObservers: 1, activeProcesses: 1 });
      finish[1]!();
      await expect(executions[1]).resolves.toMatchObject({ ok: true });
      expect(quota.metrics()).toMatchObject({ scans: 2, activeObservers: 0, activeProcesses: 0 });
    } finally {
      for (const resolve of finish) resolve();
      await Promise.all(executions);
    }
  });

  it("aborts all overlapping managed processes when the shared quota is exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-process-quota-shared-abort-"));
    roots.push(root);
    const quota = new WorkspaceQuota(await WorkspaceSandbox.create(root), { maxBytes: 4, maxFiles: 10, maxEntries: 10, observationIdleMs: 0 });
    let count = 0;
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const runner: RuntimeProcessRunner = { run: async (_lease, _request, signal) => {
      return await new Promise<ExecutionResult>((resolve) => {
        signal.addEventListener("abort", () => resolve({ ok: false, operation: "process.run", code: "process_aborted", message: "aborted" }), { once: true });
        count += 1;
        if (count === 2) bothStarted();
      });
    } };
    const backend = new WslProcessBackend({ agentId: "agent-a", manager: managerFor(lease()), runner, quota });
    const executions = [backend.execute(request()), backend.execute(request())];
    await started;
    await writeFile(join(root, "external.txt"), "12345");
    const results = await Promise.all(executions);
    expect(results).toHaveLength(2);
    for (const result of results) expect(result).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(quota.metrics()).toMatchObject({ observationStarts: 1, activeObservers: 0, activeProcesses: 0 });
  });

  it("aborta e marca uso dirty quando o observador perde autoridade", async () => {
    const markUsageDirty = vi.fn();
    const quota = {
      workspaceRoot: "C:\\quota-fixture",
      assertWithinQuota: vi.fn(async () => undefined),
      refreshUsage: vi.fn(async () => undefined),
      applyExternalDelta: vi.fn(async () => undefined),
      markUsageDirty,
    };
    const runner: RuntimeProcessRunner = {
      run: vi.fn(async (_lease, _request, signal) => await new Promise<ExecutionResult>((resolve) => {
        signal.addEventListener("abort", () => resolve({ ok: false, operation: "process.run", code: "process_aborted", message: "aborted" }), { once: true });
      })),
    };
    const backend = new WslProcessBackend({
      agentId: "agent-a",
      manager: managerFor(lease()),
      runner,
      quota,
      quotaObserverFactory: ({ onError }) => ({
        start: async () => { queueMicrotask(() => onError(new Error("watch overflow"))); },
        drain: async () => undefined,
        close: async () => undefined,
      }),
    });

    await expect(backend.execute(request())).resolves.toMatchObject({ ok: false, code: "runtime_unhealthy" });
    expect(markUsageDirty).toHaveBeenCalled();
  });

  it("executa somente process.run no lease do agente e sempre libera o lease", async () => {
    const held = lease();
    const runner: RuntimeProcessRunner = { run: vi.fn(async (activeLease) => {
      expect(activeLease.agentId).toBe("agent-a");
      return success();
    }) };
    const backend = new WslProcessBackend({ agentId: "agent-a", manager: managerFor(held), runner });

    await expect(backend.execute(request())).resolves.toMatchObject({ ok: true, exitCode: 0 });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("recusa operações não-processo e perfis de rede desconhecidos", async () => {
    const backend = new WslProcessBackend({ agentId: "agent-a", manager: managerFor(lease()), runner: { run: vi.fn() } });
    await expect(backend.execute({ operation: "file.list", path: "." })).resolves.toMatchObject({ ok: false, code: "unsupported" });
    await expect(backend.execute(request({ networkProfile: "web" as never }))).resolves.toMatchObject({ ok: false, code: "process_not_allowed" });
  });

  it("limita stdout e stderr antes de devolver o resultado ao provider", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(success({ stdout: "x".repeat(MAX_PROCESS_OUTPUT_BYTES + 1) }))
      .mockResolvedValueOnce(success({ stderr: "e".repeat(MAX_PROCESS_OUTPUT_BYTES + 1) }));
    const backend = new WslProcessBackend({
      agentId: "agent-a",
      manager: managerFor(lease()),
      runner: { run: runner },
    });
    await expect(backend.execute(request())).resolves.toMatchObject({ ok: false, code: "process_output_limit" });
    await expect(backend.execute(request())).resolves.toMatchObject({ ok: false, code: "process_output_limit" });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("converte timeout e cancelamento em erros estáveis e aborta o runner", async () => {
    const runner: RuntimeProcessRunner = {
      run: vi.fn(async (_lease, _request, signal) => await new Promise<ExecutionResult>((resolve) => {
        signal.addEventListener("abort", () => resolve({ ok: false, operation: "process.run", code: "process_aborted", message: "aborted" }), { once: true });
      })),
    };
    const backend = new WslProcessBackend({ agentId: "agent-a", manager: managerFor(lease()), runner });

    await expect(backend.execute(request({ timeoutMs: 5 }))).resolves.toMatchObject({ ok: false, code: "process_timeout" });
    const controller = new AbortController();
    const pending = backend.execute(request(), controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "process_aborted" });
  });

  it("sanitiza indisponibilidade do runtime", async () => {
    const backend = new WslProcessBackend({
      agentId: "agent-a",
      manager: managerFor(new RuntimeManagerError("runtime_unavailable", "private host detail")),
      runner: { run: vi.fn() },
    });
    await expect(backend.execute(request())).resolves.toEqual({
      ok: false,
      operation: "process.run",
      code: "runtime_unavailable",
      message: "Runtime is unavailable.",
    });
  });
});
