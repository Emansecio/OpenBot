import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { WslGuestClient } from "../src/execution/runtime/wsl/guest-runner.js";
import {
  GuestUserProvisioner,
  isValidGuestUserName,
  linuxUserNameFor,
} from "../src/execution/runtime/wsl/guest-users.js";
import type { RuntimeLease, RuntimeBoot } from "../src/execution/runtime/contracts.js";
import type { WslCommandResult, WslCommandRunner } from "../src/execution/runtime/wsl/provisioner.js";

const ok = (stdout = ""): WslCommandResult => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });
const managedRoots: string[] = [];

afterEach(async () => {
  await Promise.all(managedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("linuxUserNameFor", () => {
  it("derives a deterministic ob- name from the agent id", () => {
    expect(linuxUserNameFor("openbot-default")).toBe("ob-openbot-default");
    const lossy = linuxUserNameFor("Agent_01");
    expect(lossy).toMatch(/^ob-agent-01-[a-f0-9]{8}$/u);
    expect(lossy).toBe(linuxUserNameFor("Agent_01"));
  });

  it("caps the name at 32 characters and strips invalid edges", () => {
    const long = linuxUserNameFor(`.__---${"a".repeat(110)}---__.`);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^ob-[a-z0-9-]+$/u);
    expect(long).not.toMatch(/-$/u);
    expect(long).not.toContain("--");
    expect(isValidGuestUserName(long)).toBe(true);
    expect(isValidGuestUserName("root")).toBe(false);
    expect(isValidGuestUserName("ob-")).toBe(false);
  });

  it("keeps long ids distinct with a deterministic hash suffix", () => {
    const leftId = `shared-prefix-${"a".repeat(100)}`;
    const rightId = `shared-prefix-${"b".repeat(100)}`;
    const left = linuxUserNameFor(leftId);
    const right = linuxUserNameFor(rightId);

    expect(left).not.toBe(right);
    expect(left).toBe(linuxUserNameFor(leftId));
    expect(right).toBe(linuxUserNameFor(rightId));
    expect(left.length).toBeLessThanOrEqual(32);
    expect(right.length).toBeLessThanOrEqual(32);
    expect(isValidGuestUserName(left)).toBe(true);
    expect(isValidGuestUserName(right)).toBe(true);
  });

  it("keeps distinct ids separate when Linux sanitization is lossy", () => {
    expect(linuxUserNameFor("agent-a")).not.toBe(linuxUserNameFor("agent_a"));
    expect(linuxUserNameFor("agent.a")).not.toBe(linuxUserNameFor("agent_a"));
  });

  it("rejects invalid agent identities", () => {
    expect(() => linuxUserNameFor("")).toThrow();
    expect(() => linuxUserNameFor("x".repeat(200))).toThrow();
  });
});

describe("GuestUserProvisioner", () => {
  const makeRunner = (existingUsers: Set<string>, commands: string[] = []) => {
    const runner: WslCommandRunner = {
      async run(args): Promise<WslCommandResult> {
        commands.push(args.join(" "));
        const idIndex = args.indexOf("id");
        if (idIndex !== -1) {
          const user = args[idIndex + 2] ?? "";
          return existingUsers.has(user) ? ok("12345\n") : { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        if (args.includes("sh") && args.includes("command -v useradd >/dev/null 2>&1")) return ok();
        const useraddIndex = args.indexOf("useradd");
        if (useraddIndex !== -1) {
          const user = args[args.length - 1];
          if (args.includes("--system") && args.includes("--no-create-home") && args.includes("/usr/sbin/nologin")) {
            existingUsers.add(user!);
            return ok();
          }
          return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        return ok();
      },
    };
    return { runner, commands };
  };

  it("creates a missing account once and caches it (idempotent)", async () => {
    const users = new Set<string>();
    const { runner, commands } = makeRunner(users);
    const provisioner = new GuestUserProvisioner({ runner, distroName: "OpenBotRuntime" });
    await provisioner.ensure("agent-a");
    await provisioner.ensure("agent-a");
    const useraddCalls = commands.filter((command) => command.includes(" useradd --system"));
    expect(useraddCalls).toHaveLength(1);
    expect(users.has("ob-agent-a")).toBe(true);
    expect(useraddCalls[0]).toContain("--system");
    expect(useraddCalls[0]).toContain("--no-create-home");
    expect(useraddCalls[0]).toContain("/usr/sbin/nologin");
  });

  it("deduplicates concurrent provisioning for the same guest account", async () => {
    let releaseIdCheck!: () => void;
    let markIdCheckStarted!: () => void;
    const idCheckGate = new Promise<void>((resolve) => {
      releaseIdCheck = resolve;
    });
    const idCheckStarted = new Promise<void>((resolve) => {
      markIdCheckStarted = resolve;
    });
    let useraddCalls = 0;
    const runner: WslCommandRunner = {
      async run(args) {
        if (args.includes("id")) {
          markIdCheckStarted();
          await idCheckGate;
          return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        if (args.includes("command -v useradd >/dev/null 2>&1")) return ok();
        if (args.includes("useradd")) {
          useraddCalls += 1;
          return useraddCalls === 1
            ? ok()
            : { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("user already exists") };
        }
        return ok();
      },
    };
    const provisioner = new GuestUserProvisioner({ runner, distroName: "OpenBotRuntime" });

    const first = provisioner.ensure("agent-race");
    await idCheckStarted;
    const second = provisioner.ensure("agent-race");
    releaseIdCheck();

    await expect(Promise.all([first, second])).resolves.toEqual(["ob-agent-race", "ob-agent-race"]);
    expect(useraddCalls).toBe(1);
  });

  it("skips creation when the account already exists", async () => {
    const users = new Set<string>(["ob-agent-b"]);
    const { runner, commands } = makeRunner(users);
    const provisioner = new GuestUserProvisioner({ runner, distroName: "OpenBotRuntime" });
    await provisioner.ensure("agent-b");
    expect(commands.some((command) => command.includes("useradd"))).toBe(false);
  });

  it("uses Alpine adduser when useradd is unavailable", async () => {
    const users = new Set<string>();
    const commands: string[] = [];
    const runner: WslCommandRunner = {
      async run(args) {
        commands.push(args.join(" "));
        if (args.includes("id")) return users.has("ob-agent-alpine") ? ok("101\n") : { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        if (args.includes("command -v useradd >/dev/null 2>&1")) return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        if (args.includes("adduser") && args.includes("-S") && args.includes("-D") && args.includes("-H") && args.includes("/sbin/nologin")) {
          users.add("ob-agent-alpine");
          return ok();
        }
        return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    };
    const provisioner = new GuestUserProvisioner({ runner, distroName: "OpenBotRuntime" });
    await expect(provisioner.ensure("agent-alpine")).resolves.toBe("ob-agent-alpine");
    expect(commands.some((command) => command.includes("adduser -S -D -H -s /sbin/nologin"))).toBe(true);
    expect(commands.some((command) => command.includes("useradd --system"))).toBe(false);
  });

  it("fails closed when useradd fails instead of degrading", async () => {
    const runner: WslCommandRunner = {
      async run(args) {
        if (args.includes("command -v useradd >/dev/null 2>&1")) return ok();
        if (args.includes("useradd")) return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    };
    const provisioner = new GuestUserProvisioner({ runner, distroName: "OpenBotRuntime" });
    await expect(provisioner.ensure("agent-c")).rejects.toMatchObject({ code: "runtime_unhealthy" });
  });
});

describe("WslGuestClient.runProcess guest identity", () => {
  const boot: RuntimeBoot = {
    runtimeBootId: "boot-1",
    runtimeVersion: "1.0.0",
    imageDigest: `sha256:${"a".repeat(64)}`,
  };
  const lease = (agentId: string): RuntimeLease => ({
    runtimeBootId: "boot-1",
    leaseId: "lease-1",
    agentId,
    sandboxId: "sandbox-1",
    capability: { kind: "process.run", networkProfile: "none", expiresAt: Date.now() + 60_000 },
    expiresAt: Date.now() + 60_000,
  } as unknown as RuntimeLease);

  it("sends linuxUser in the run frame after provisioning", async () => {
    const { mkdtemp, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const managedRoot = await mkdtemp(join(tmpdir(), "openbot-guest-ws-"));
    managedRoots.push(managedRoot);
    await mkdir(join(managedRoot, "agent-x"), { recursive: true });
    const frames: Array<Record<string, unknown>> = [];
    const runner: WslCommandRunner = {
      async run(args, _signal, input) {
        if (args.includes("start")) {
          return {
            exitCode: 0,
            stdout: Buffer.from(JSON.stringify({ ok: true, runtimeBootId: "boot-1", runtimeVersion: "1", imageDigest: `sha256:${"a".repeat(64)}` })),
            stderr: Buffer.alloc(0),
          };
        }
        if (args.includes("frame") && input !== undefined) {
          const frame = JSON.parse(input.toString("utf8")) as Record<string, unknown>;
          frames.push(frame);
          return {
            exitCode: 0,
            stdout: Buffer.from(JSON.stringify({
              ok: true,
              operation: "process.run",
              stdout: "",
              stderr: "",
              exitCode: 0,
              durationMs: 1,
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
            stderr: Buffer.alloc(0),
          };
        }
        void args;
        return ok();
      },
    };
    const client = new WslGuestClient({
      runner,
      distroName: "OpenBotRuntime",
      managedWorkspacesRoot: managedRoot,
      guestUserProvisioner: {
        ensure: async (agentId) => linuxUserNameFor(agentId),
      },
    });
    await client.start();
    const request = {
      operation: "process.run",
      executable: "node",
      argv: ["-e", "1"],
      cwd: "Projects",
      env: undefined,
      stdin: undefined,
      timeoutMs: 5_000,
      networkProfile: "none",
    } as never;
    await client.runProcess(lease("agent-x"), request, join(managedRoot, "agent-x"), new AbortController().signal);
    const runFrame = frames.find((frame) => frame.type === "run");
    expect(runFrame).toBeDefined();
    expect((runFrame!.payload as Record<string, unknown>).linuxUser).toBe("ob-agent-x");
  });

  it("fails closed when provisioning fails", async () => {
    const { mkdtemp, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const managedRoot = await mkdtemp(join(tmpdir(), "openbot-guest-ws-fail-"));
    managedRoots.push(managedRoot);
    await mkdir(join(managedRoot, "agent-y"), { recursive: true });
    const runner: WslCommandRunner = {
      async run(args) {
        if (args.includes("start")) {
          return {
            exitCode: 0,
            stdout: Buffer.from(JSON.stringify({ ok: true, runtimeBootId: "boot-1", runtimeVersion: "1", imageDigest: `sha256:${"a".repeat(64)}` })),
            stderr: Buffer.alloc(0),
          };
        }
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    };
    const client = new WslGuestClient({
      runner,
      distroName: "OpenBotRuntime",
      managedWorkspacesRoot: managedRoot,
      guestUserProvisioner: {
        ensure: async () => {
          throw new Error("provision failed");
        },
      },
    });
    await client.start();
    const request = {
      operation: "process.run",
      executable: "node",
      argv: [],
      cwd: "Projects",
      env: undefined,
      stdin: undefined,
      timeoutMs: 5_000,
      networkProfile: "none",
    } as never;
    await expect(client.runProcess(lease("agent-y"), request, join(managedRoot, "agent-y"), new AbortController().signal))
      .rejects.toThrow(/provision failed/u);
  });
});
