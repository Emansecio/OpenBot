import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { WslCommandResult, WslCommandRunner } from "../src/execution/runtime/wsl/provisioner.js";
import { WslGuestClient, WslProcessRunner } from "../src/execution/runtime/wsl/guest-runner.js";
import type { RuntimeLease } from "../src/execution/runtime/contracts.js";

class FakeRunner implements WslCommandRunner {
  readonly calls: Array<{ args: string[]; input?: Buffer }> = [];
  responses: WslCommandResult[] = [];

  async run(args: readonly string[], _signal?: AbortSignal, input?: Buffer): Promise<WslCommandResult> {
    this.calls.push({ args: [...args], ...(input === undefined ? {} : { input }) });
    return this.responses.shift() ?? { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

const activeLease = (): RuntimeLease => ({
  leaseId: "lease-1",
  agentId: "agent-a",
  runtimeBootId: "boot-1",
  sandboxId: "sandbox-1",
  capability: { kind: "process.run", networkProfile: "none" },
  expiresAt: Date.now() + 10_000,
  released: false,
  release: async () => undefined,
});

describe("guest supervisor host client", () => {
  it("envia frames sensíveis por stdin, nunca por argv, e usa somente a distro gerenciada", async () => {
    const managedWorkspacesRoot = await mkdtemp(join(tmpdir(), "openbot-guest-host-"));
    await mkdir(join(managedWorkspacesRoot, "agent-a"));
    const runner = new FakeRunner();
    runner.responses = [
      { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` })), stderr: Buffer.alloc(0) },
      {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({
          ok: true,
          operation: "process.run",
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          durationMs: 3,
          stdoutTruncated: false,
          stderrTruncated: false,
        })),
        stderr: Buffer.alloc(0),
      },
    ];
    try {
      const client = new WslGuestClient({
        runner,
        managedWorkspacesRoot,
        // Guest identity is covered by runtime-guest-users.test.ts; here we
        // pin the frame transport contract exactly.
        guestUserProvisioner: { ensure: async (agentId) => `ob-${agentId}` },
      });
      await client.start();
      const processRunner = new WslProcessRunner({
        client,
        agentId: "agent-a",
        workspaceRoot: join(managedWorkspacesRoot, "agent-a"),
      });

      await expect(processRunner.run(activeLease(), {
        operation: "process.run",
        executable: "node",
        argv: ["script.js"],
        cwd: ".",
        timeoutMs: 10_000,
        networkProfile: "none",
        stdin: "secret-input",
      }, new AbortController().signal)).resolves.toMatchObject({ ok: true, stdout: "ok" });

      expect(runner.calls).toHaveLength(2);
      expect(runner.calls[1]?.args).toEqual([
        "-d", "OpenBotRuntime", "--user", "root", "--",
        "/usr/lib/openbot/supervisor", "--protocol-version", "1", "frame",
      ]);
      const encoded = runner.calls[1]?.input?.toString("utf8") ?? "";
      expect(encoded).toContain("secret-input");
      expect(runner.calls[1]?.args.join(" ")).not.toContain("secret-input");
      expect(encoded).toContain("workspaceWindowsPath");
    } finally {
      await rm(managedWorkspacesRoot, { recursive: true, force: true });
    }
  });

  it("recusa um home externo mesmo quando o basename coincide com o agentId", async () => {
    const managedWorkspacesRoot = await mkdtemp(join(tmpdir(), "openbot-guest-managed-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "openbot-guest-external-"));
    await mkdir(join(managedWorkspacesRoot, "agent-a"));
    await mkdir(join(externalRoot, "agent-a"));
    try {
      const runner = new FakeRunner();
      runner.responses = [
        { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` })), stderr: Buffer.alloc(0) },
      ];
      const client = new WslGuestClient({ runner, managedWorkspacesRoot });
      await client.start();

      await expect(client.runProcess(activeLease(), {
        operation: "process.run",
        executable: "node",
        argv: [],
        cwd: ".",
        timeoutMs: 10_000,
        networkProfile: "none",
      }, join(externalRoot, "agent-a"), new AbortController().signal)).rejects.toMatchObject({ code: "runtime_protocol_error" });
      expect(runner.calls).toHaveLength(1);
    } finally {
      await rm(managedWorkspacesRoot, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it("recusa home gerenciado que seja junction/reparse point", async () => {
    const managedWorkspacesRoot = await mkdtemp(join(tmpdir(), "openbot-guest-managed-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "openbot-guest-external-"));
    const externalHome = join(externalRoot, "agent-a");
    const junctionHome = join(managedWorkspacesRoot, "agent-a");
    await mkdir(externalHome);
    try {
      await symlink(externalHome, junctionHome, "junction");
      const runner = new FakeRunner();
      runner.responses = [
        { exitCode: 0, stdout: Buffer.from(JSON.stringify({ runtimeBootId: "boot-1", runtimeVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` })), stderr: Buffer.alloc(0) },
      ];
      const client = new WslGuestClient({ runner, managedWorkspacesRoot });
      await client.start();

      await expect(client.runProcess(activeLease(), {
        operation: "process.run",
        executable: "node",
        argv: [],
        cwd: ".",
        timeoutMs: 10_000,
        networkProfile: "none",
      }, junctionHome, new AbortController().signal)).rejects.toMatchObject({ code: "runtime_protocol_error" });
      expect(runner.calls).toHaveLength(1);
    } finally {
      await rm(managedWorkspacesRoot, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});
