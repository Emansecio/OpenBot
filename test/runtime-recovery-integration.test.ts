import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RuntimeBoot,
  RuntimeDriver,
  RuntimeDriverLease,
  RuntimeHealth,
  RuntimeLeaseRequest,
} from "../src/execution/runtime/contracts.js";
import { ConfigStore } from "../src/config/store.js";
import { AgentHomeStore } from "../src/execution/home.js";
import { RuntimeManager } from "../src/execution/runtime/manager.js";
import {
  FileRuntimeLeaseJournal,
  type RuntimeResourceReconciler,
} from "../src/execution/runtime/recovery.js";
import { WslProcessBackend } from "../src/execution/runtime/wsl/process-backend.js";
import type { WslCommandRunner } from "../src/execution/runtime/wsl/provisioner.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { createProviderRegistry } from "../src/providers/router.js";
import { createFakeAdapter } from "./mocks/fake-provider-adapter.js";

const roots: string[] = [];

beforeEach(() => {
  vi.stubEnv("OPENBOT_RUNTIME_DRIVER", "wsl");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeDriver implements RuntimeDriver {
  starts = 0;
  stops = 0;

  async start(): Promise<RuntimeBoot> {
    this.starts += 1;
    return {
      runtimeBootId: "boot-current",
      runtimeVersion: "test",
      imageDigest: `sha256:${"a".repeat(64)}`,
    };
  }

  async health(_boot: RuntimeBoot): Promise<RuntimeHealth> {
    return { ok: true };
  }

  async acquire(request: RuntimeLeaseRequest): Promise<RuntimeDriverLease> {
    return { leaseId: request.leaseId, sandboxId: `sandbox-${request.leaseId}` };
  }

  async release(_lease: RuntimeDriverLease): Promise<void> {}

  async stop(): Promise<void> {
    this.stops += 1;
  }
}

class FakeWslCommandRunner implements WslCommandRunner {
  readonly calls: string[][] = [];
  proofExitCode = 0;
  startError: unknown;
  private bootNumber = 0;

  async run(args: readonly string[]): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
    this.calls.push([...args]);
    if (args.includes("start")) {
      if (this.startError !== undefined) throw this.startError;
      this.bootNumber += 1;
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({
          runtimeBootId: `guest-boot-${this.bootNumber}`,
          runtimeVersion: "test",
          imageDigest: `sha256:${"a".repeat(64)}`,
        })),
        stderr: Buffer.alloc(0),
      };
    }
    if (args.includes("health")) {
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true })), stderr: Buffer.alloc(0) };
    }
    if (args.includes("test")) {
      return { exitCode: this.proofExitCode, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    throw new Error(`unexpected WSL command: ${args.join(" ")}`);
  }
}

const staleRecord = {
  leaseId: "lease-stale",
  agentId: "agent-a",
  runtimeBootId: "boot-old",
  sandboxId: "sandbox-stale",
  temporaryId: "tmp-stale",
};

const wslStaleRecord = {
  leaseId: "lease-wsl-stale",
  agentId: "agent-a",
  runtimeBootId: "boot-old",
  sandboxId: "sandbox-lease-wsl-stale",
  temporaryId: "tmp-lease-wsl-stale",
};

const wslPendingRecord = {
  leaseId: "lease-wsl-pending",
  agentId: "agent-a",
  runtimeBootId: "boot-old",
  temporaryId: "tmp-lease-wsl-pending",
  pending: true as const,
};

function isolatedOptions(root: string) {
  return {
    configPath: join(root, "config.json"),
    storePath: join(root, "store.db"),
    keystoreDir: join(root, "keys"),
    workspacesRoot: join(root, "workspaces"),
    disableAgentHome: true,
    allowUnauthenticatedLocalGateway: true,
  } as const;
}

async function post(handle: ServerHandle, method: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as { ok: boolean; value?: unknown; failure?: string } };
}

describe("runtime recovery integration", () => {
  it("injeta o reconciliador WSL quando esse runtime de teste é selecionado", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-runtime-default-recovery-"));
    roots.push(root);
    const stateRoot = join(root, "runtime", "state");
    const journal = new FileRuntimeLeaseJournal(stateRoot);
    await journal.put(wslStaleRecord);
    const runner = new FakeWslCommandRunner();

    const handle = await startServer(0, {
      ...isolatedOptions(root),
      runtimeRoot: join(root, "runtime"),
      runtimeJournal: journal,
      runtimeCommandRunner: runner,
    });
    try {
      expect(handle.server.listening).toBe(true);
      expect(runner.calls.some((args) => args.includes("start"))).toBe(true);
      const proofCalls = runner.calls.filter((args) => args.includes("test"));
      expect(proofCalls).toHaveLength(2);
      expect(proofCalls.some((args) => args.includes(`/run/openbot/sandboxes/${wslStaleRecord.leaseId}`))).toBe(true);
      expect(proofCalls.some((args) => args.includes(`/sys/fs/cgroup/openbot/${wslStaleRecord.runtimeBootId}/${wslStaleRecord.leaseId}`))).toBe(true);
      expect(runner.calls.flat()).not.toContain("/bin/sh");
      await expect(journal.list()).resolves.toEqual([]);
    } finally {
      await stopServer(handle);
    }
  });

  it("abre o gateway e compensa pending sem sandboxId pelo leaseId persistido", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-runtime-pending-recovery-"));
    roots.push(root);
    const journal = new FileRuntimeLeaseJournal(join(root, "runtime", "state"));
    await journal.put(wslPendingRecord);
    const runner = new FakeWslCommandRunner();

    const handle = await startServer(0, {
      ...isolatedOptions(root),
      runtimeRoot: join(root, "runtime"),
      runtimeJournal: journal,
      runtimeCommandRunner: runner,
    });
    try {
      expect(handle.server.listening).toBe(true);
      expect(runner.calls.some((args) => args.includes(`/run/openbot/sandboxes/${wslPendingRecord.leaseId}`))).toBe(true);
      await expect(journal.list()).resolves.toEqual([]);
    } finally {
      await stopServer(handle);
    }
  });

  it("mantém gateway e chat ativos, mas fecha Developer quando a prova guest não passa", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-runtime-default-recovery-red-"));
    roots.push(root);
    const journal = new FileRuntimeLeaseJournal(join(root, "runtime", "state"));
    await journal.put(wslStaleRecord);
    const runner = new FakeWslCommandRunner();
    runner.proofExitCode = 1;
    const registry = createProviderRegistry();
    registry.register(createFakeAdapter("xai", { deltas: ["ok"] }));

    const handle = await startServer(0, {
      ...isolatedOptions(root),
      runtimeRoot: join(root, "runtime"),
      runtimeJournal: journal,
      runtimeCommandRunner: runner,
      registry,
    });
    try {
      expect(handle.server.listening).toBe(true);
      await expect(journal.list()).resolves.toEqual([wslStaleRecord]);
      expect((await post(handle, "createAgent", { id: "agent-a", name: "Agent A", runtimeMode: "developer" })).status).toBe(200);

      const status = await post(handle, "getLocalRuntimeStatus", { agentId: "agent-a" });
      expect(status.json.value).toMatchObject({
        agentId: "agent-a",
        mode: "developer",
        state: "repair-required",
        lastError: { code: "runtime_unhealthy", message: "Runtime recovery requires repair." },
      });

      expect((await post(handle, "sendPrompt", { agentId: "agent-a", prompt: "chat sem tools", clientNonce: "recovery:chat" })).status).toBe(200);
      await handle.runner.flush("agent-a");

      const processBackend = new WslProcessBackend({
        agentId: "agent-a",
        manager: handle.runtimeManager,
        runner: { run: async () => { throw new Error("process runner must not start"); } },
      });
      await expect(handle.runtimeManager.acquire("agent-a", { kind: "process.run", networkProfile: "none" }))
        .rejects.toMatchObject({ code: "runtime_unhealthy", message: "Runtime recovery requires repair." });
      await expect(processBackend.execute({
        operation: "process.run",
        executable: "node",
        argv: ["--version"],
        cwd: ".",
        timeoutMs: 1_000,
        networkProfile: "none",
      })).resolves.toMatchObject({ ok: false, operation: "process.run", code: "runtime_unhealthy" });
      expect(runner.calls.filter((args) => args.includes("start"))).toHaveLength(1);
    } finally {
      await stopServer(handle);
    }
  });

  it("mantém gateway ativo quando a infraestrutura WSL não pode provar o teardown", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-runtime-default-recovery-infra-red-"));
    roots.push(root);
    const journal = new FileRuntimeLeaseJournal(join(root, "runtime", "state"));
    await journal.put(wslStaleRecord);
    const runner = new FakeWslCommandRunner();
    runner.startError = Object.assign(new Error("wsl.exe not found"), { code: "ENOENT" });

    const handle = await startServer(0, {
      ...isolatedOptions(root),
      runtimeRoot: join(root, "runtime"),
      runtimeJournal: journal,
      runtimeCommandRunner: runner,
    });
    try {
      expect(handle.server.listening).toBe(true);
      // ENOENT from the WSL host is not treated as an already-absent guest
      // resource; the identity remains for a later repair attempt.
      await expect(journal.list()).resolves.toEqual([wslStaleRecord]);
    } finally {
      await stopServer(handle);
    }
  });

  it("recupera o lease órfão novamente após restart do bootstrap", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-runtime-default-restart-"));
    roots.push(root);
    const journal = new FileRuntimeLeaseJournal(join(root, "runtime", "state"));
    const runner = new FakeWslCommandRunner();
    await journal.put(wslStaleRecord);

    const first = await startServer(0, {
      ...isolatedOptions(root),
      runtimeRoot: join(root, "runtime"),
      runtimeJournal: journal,
      runtimeCommandRunner: runner,
    });
    await stopServer(first);
    await journal.put(wslStaleRecord);

    const second = await startServer(0, {
      ...isolatedOptions(root),
      runtimeRoot: join(root, "runtime"),
      runtimeJournal: journal,
      runtimeCommandRunner: runner,
    });
    try {
      expect(runner.calls.filter((args) => args.includes("start"))).toHaveLength(2);
      expect(runner.calls.filter((args) => args.includes("test"))).toHaveLength(4);
      expect(runner.calls.flat()).not.toContain("/bin/sh");
      await expect(journal.list()).resolves.toEqual([]);
    } finally {
      await stopServer(second);
    }
  });

  it("reconcilia o journal antes do listen e não inicia WSL nem toca workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-runtime-recovery-"));
    roots.push(root);
    const stateRoot = join(root, "runtime", "state");
    const journal = new FileRuntimeLeaseJournal(stateRoot);
    await journal.put(staleRecord);
    const driver = new FakeDriver();
    const cleaned: string[] = [];
    const reconciler: RuntimeResourceReconciler = {
      killSandbox: async (sandboxId) => { cleaned.push(`sandbox:${sandboxId}`); },
      removeTemporary: async (temporaryId) => { cleaned.push(`temporary:${temporaryId}`); },
    };
    const manager = new RuntimeManager({ driver, journal, reconciler });

    const handle = await startServer(0, {
      ...isolatedOptions(root),
      runtimeManager: manager,
    });
    try {
      expect(handle.server.listening).toBe(true);
      expect(cleaned).toEqual(["sandbox:sandbox-stale", "temporary:tmp-stale"]);
      expect(driver.starts).toBe(0);
      expect(existsSync(join(root, "workspaces"))).toBe(false);
      await expect(journal.list()).resolves.toEqual([]);
    } finally {
      await stopServer(handle);
    }
    expect(driver.stops).toBe(0);
  });

  it("sobe como repair-required sem reconciliador e preserva o journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-runtime-repair-"));
    roots.push(root);
    const journal = new FileRuntimeLeaseJournal(join(root, "runtime", "state"));
    await journal.put(staleRecord);
    const driver = new FakeDriver();
    const manager = new RuntimeManager({ driver, journal });

    const handle = await startServer(0, {
      ...isolatedOptions(root),
      runtimeManager: manager,
    });
    try {
      expect(handle.server.listening).toBe(true);
      await expect(journal.list()).resolves.toEqual([staleRecord]);
      expect(existsSync(join(root, "workspaces"))).toBe(false);
      expect((await manager.status("agent-a")).state).toBe("lite-ready");
      expect((await manager.status("agent-a", "developer")).state).toBe("repair-required");
      expect((await manager.ensure("agent-a", "developer")).state).toBe("repair-required");
      expect(driver.starts).toBe(0);
    } finally {
      await stopServer(handle);
    }
  });

  it("mantém home pendente isolada e preserva os dados enquanto outra home segue utilizável", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-home-pending-"));
    roots.push(root);
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    const now = Date.now();
    config.update({ agents: [
      { id: "broken", name: "Broken", avatarId: "broken", runtimeMode: "developer", createdAt: now, updatedAt: now },
      { id: "healthy", name: "Healthy", avatarId: "healthy", runtimeMode: "developer", createdAt: now, updatedAt: now },
    ] });
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const broken = await homes.ensure("broken");
    const healthy = await homes.ensure("healthy");
    writeFileSync(join(broken.root, "Documents", "evidence.txt"), "preserve-me");
    writeFileSync(join(broken.root, ".openbot", "home.json"), "{not-json");
    writeFileSync(join(healthy.root, "Documents", "ok.txt"), "healthy-data");
    const manager = new RuntimeManager({ driver: new FakeDriver() });

    const handle = await startServer(0, {
      ...isolatedOptions(root),
      disableAgentHome: false,
      config,
      homes,
      runtimeManager: manager,
      browserRoot: join(root, "browser"),
    });
    try {
      expect(handle.server.listening).toBe(true);
      expect((await post(handle, "getLocalRuntimeStatus", { agentId: "broken" })).json.value)
        .toMatchObject({ state: "repair-required", lastError: { code: "runtime_unhealthy" } });
      expect((await post(handle, "getLocalRuntimeStatus", { agentId: "healthy" })).json.value)
        .toMatchObject({ state: "stopped", lastError: null });
      await expect(handle.executionBroker!.execute("healthy", "healthy-read", {
        operation: "file.read",
        path: "Documents/ok.txt",
        encoding: "utf8",
      })).resolves.toMatchObject({ ok: true, content: "healthy-data" });
      await expect(handle.executionBroker!.execute("broken", "broken-read", {
        operation: "file.read",
        path: "Documents/evidence.txt",
        encoding: "utf8",
      })).resolves.toMatchObject({ ok: false });
      expect(readFileSync(join(broken.root, "Documents", "evidence.txt"), "utf8")).toBe("preserve-me");
      expect(readFileSync(join(broken.root, ".openbot", "home.json"), "utf8")).toBe("{not-json");
    } finally {
      await stopServer(handle);
    }
  });

  it("bloqueia file e browser para múltiplas quarantines sem materializar home vazia", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-home-multiple-quarantines-"));
    roots.push(root);
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    const now = Date.now();
    config.update({ agents: [
      { id: "broken", name: "Broken", avatarId: "broken", runtimeMode: "developer", createdAt: now, updatedAt: now },
      { id: "healthy", name: "Healthy", avatarId: "healthy", runtimeMode: "developer", createdAt: now, updatedAt: now },
    ] });
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const broken = await homes.ensure("broken");
    const healthy = await homes.ensure("healthy");
    writeFileSync(join(broken.root, "Documents", "evidence.txt"), "preserve-me");
    writeFileSync(join(healthy.root, "Documents", "ok.txt"), "healthy-data");
    await homes.remove("broken");
    const firstId = readdirSync(homes.quarantineRoot)[0];
    const secondId = "broken-9999999999999-00000000-0000-4000-8000-000000000000";
    const secondRoot = join(homes.quarantineRoot, secondId);
    cpSync(join(homes.quarantineRoot, firstId!), secondRoot, { recursive: true });
    const secondMarkerPath = join(secondRoot, ".openbot", "quarantine.json");
    const secondMarker = JSON.parse(readFileSync(secondMarkerPath, "utf8")) as Record<string, unknown>;
    writeFileSync(secondMarkerPath, `${JSON.stringify({ ...secondMarker, quarantineId: secondId }, null, 2)}\n`);

    const handle = await startServer(0, {
      ...isolatedOptions(root),
      disableAgentHome: false,
      config,
      homes,
      runtimeManager: new RuntimeManager({ driver: new FakeDriver() }),
      browserRoot: join(root, "browser"),
    });
    try {
      for (const request of [
        { operation: "file.read" as const, path: "Documents/evidence.txt", encoding: "utf8" as const },
        { operation: "browser.open" as const },
      ]) {
        await expect(handle.executionBroker!.execute("broken", `blocked-${request.operation}`, request))
          .resolves.toMatchObject({ ok: false, operation: request.operation, code: "io_error" });
      }
      await expect(handle.executionBroker!.execute("healthy", "healthy-read", {
        operation: "file.read",
        path: "Documents/ok.txt",
        encoding: "utf8",
      })).resolves.toMatchObject({ ok: true, content: "healthy-data" });
      expect(existsSync(homes.pathFor("broken"))).toBe(false);
      expect(readdirSync(homes.quarantineRoot)).toHaveLength(2);
      expect(readFileSync(join(homes.quarantineRoot, firstId!, "Documents", "evidence.txt"), "utf8")).toBe("preserve-me");
      expect(readFileSync(join(secondRoot, "Documents", "evidence.txt"), "utf8")).toBe("preserve-me");
    } finally {
      await stopServer(handle);
    }
  });

  it("reconcilia novamente no primeiro boot real do manager", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-runtime-manager-recovery-"));
    roots.push(root);
    const journal = new FileRuntimeLeaseJournal(join(root, "state"));
    await journal.put(staleRecord);
    const driver = new FakeDriver();
    const calls: string[] = [];
    const manager = new RuntimeManager({
      driver,
      journal,
      reconciler: {
        killSandbox: async (id) => { calls.push(`sandbox:${id}`); },
        removeTemporary: async (id) => { calls.push(`temporary:${id}`); },
      },
    });

    const status = await manager.ensure("agent-a", "developer");
    expect(status.state).toBe("ready");
    expect(driver.starts).toBe(1);
    expect(calls).toEqual(["sandbox:sandbox-stale", "temporary:tmp-stale"]);
    await manager.close();
    expect(driver.stops).toBe(1);
    expect(readFileSync(join(root, "state", "runtime-leases.json"), "utf8")).toContain("leases");
  });
});
