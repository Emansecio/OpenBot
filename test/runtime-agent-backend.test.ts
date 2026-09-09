import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import type { AgentRuntimeManager, RuntimeLease } from "../src/execution/runtime/contracts.js";
import type { RuntimeProcessRunner } from "../src/execution/runtime/wsl/process-backend.js";
import { AgentRuntimeBackend } from "../src/execution/runtime/agent-backend.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const lease = (): RuntimeLease => ({
  leaseId: "lease-1",
  agentId: "agent-a",
  runtimeBootId: "boot-1",
  sandboxId: "sandbox-1",
  capability: { kind: "process.run", networkProfile: "host" },
  expiresAt: Date.now() + 5_000,
  released: false,
  release: vi.fn(async () => undefined),
});

describe("AgentRuntimeBackend", () => {
  it("propaga o override de quota para a home do agente", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-agent-backend-quota-"));
    roots.push(root);
    await mkdir(join(root, "Documents"));

    const backend = await AgentRuntimeBackend.create({
      agentId: "agent-a",
      homeRoot: root,
      manager: {
        ensure: vi.fn(),
        acquire: vi.fn(async () => lease()),
        status: vi.fn(),
        stop: vi.fn(),
        repair: vi.fn(),
        close: vi.fn(),
      },
      runner: { run: vi.fn() },
      quota: { maxBytes: 4, maxFiles: 100, maxEntries: 100 },
    });

    await expect(backend.execute({
      operation: "file.write",
      path: "Documents/too-large.txt",
      content: "12345",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: false, operation: "file.write", code: "quota_exceeded" });
  });

  it("roteia arquivos para a home e process.run para o sandbox do mesmo agente", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-agent-backend-"));
    roots.push(root);
    const homes = await AgentHomeStore.create(root);
    const home = await homes.ensure("agent-a");
    const activeLease = lease();
    const manager: AgentRuntimeManager = {
      ensure: vi.fn(),
      acquire: vi.fn(async () => activeLease),
      status: vi.fn(),
      stop: vi.fn(),
      repair: vi.fn(),
      close: vi.fn(),
    };
    const runner: RuntimeProcessRunner = {
      run: vi.fn<RuntimeProcessRunner["run"]>(async (receivedLease) => {
        expect(receivedLease).toBe(activeLease);
        return {
          ok: true as const,
          operation: "process.run" as const,
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
    };
    const backend = await AgentRuntimeBackend.create({ agentId: "agent-a", homeRoot: home.root, manager, runner });

    await expect(backend.execute({ operation: "file.write", path: "Documents/note.txt", content: "home", encoding: "utf8" })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(home.root, "Documents", "note.txt"), "utf8")).resolves.toBe("home");
    const hostDirectory = await mkdtemp(join(tmpdir(), "openbot-agent-host-"));
    roots.push(hostDirectory);
    const hostFile = join(hostDirectory, "note.txt");
    await expect(backend.execute({ operation: "file.write", path: hostFile, content: "host", encoding: "utf8" })).resolves.toMatchObject({ ok: true });
    await expect(readFile(hostFile, "utf8")).resolves.toBe("host");
    await expect(backend.execute({ operation: "process.run", executable: "node", argv: [], cwd: ".", timeoutMs: 1_000, networkProfile: "host" })).resolves.toMatchObject({ ok: true, stdout: "ok" });
    expect(manager.acquire).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("com shareUserFiles redireciona por bot; grant alcança o perfil real", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-agent-overlay-"));
    roots.push(root);
    const profile = join(root, "profile");
    await mkdir(join(profile, "Documents"), { recursive: true });
    const homes = await AgentHomeStore.create(join(root, "homes"));
    const home = await homes.ensure("agent-a");
    const backend = await AgentRuntimeBackend.create({
      agentId: "agent-a",
      homeRoot: home.root,
      manager: {
        ensure: vi.fn(),
        acquire: vi.fn(async () => lease()),
        status: vi.fn(),
        stop: vi.fn(),
        repair: vi.fn(),
        close: vi.fn(),
      },
      runner: { run: vi.fn() },
      shareUserFiles: true,
      userProfile: profile,
    });

    // Sem grant: a escrita cai no redirect privado do bot.
    await expect(backend.execute({
      operation: "file.write",
      path: "Documents/note.txt",
      content: "shared",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(profile, "Documents", "OpenBot", "agent-a", "Documents", "note.txt"), "utf8")).resolves.toBe("shared");
    await expect(readFile(join(profile, "Documents", "note.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home.root, "Documents", "note.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // Com grant de escrita, a pasta real é montada.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(home.root, ".openbot", "grants.json"), `${JSON.stringify({
      version: 1,
      grants: { Documents: { access: "write" } },
    }, null, 2)}\n`);
    const granted = await AgentRuntimeBackend.create({
      agentId: "agent-a",
      homeRoot: home.root,
      manager: {
        ensure: vi.fn(),
        acquire: vi.fn(async () => lease()),
        status: vi.fn(),
        stop: vi.fn(),
        repair: vi.fn(),
        close: vi.fn(),
      },
      runner: { run: vi.fn() },
      shareUserFiles: true,
      userProfile: profile,
    });
    await expect(granted.execute({
      operation: "file.write",
      path: "Documents/granted.txt",
      content: "real",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(profile, "Documents", "granted.txt"), "utf8")).resolves.toBe("real");
  });
});
