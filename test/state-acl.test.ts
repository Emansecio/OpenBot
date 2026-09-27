import { describe, expect, it, afterEach } from "vitest";

import {
  applyOpenBotStateAcl,
  verifyOpenBotStateAcl,
  type StateAclCommandOptions,
  type StateAclCommandResult,
  type StateAclCommandRunner,
} from "../src/state-acl.js";
import { systemToolPath } from "../src/shared/windows-tools.js";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, stopServer } from "../src/main.js";
import { TempRoots } from "./helpers/temp-roots.js";

interface RecordedCall {
  file: string;
  args: readonly string[];
  options: StateAclCommandOptions;
}

function fakeRunner(results: StateAclCommandResult[]): { runner: StateAclCommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: StateAclCommandRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    return results.shift() ?? { exitCode: 0 };
  };
  return { runner, calls };
}

const POLICY_SDDL = "D:P(A;OICI;FA;;;CONTOSO\\alice)(A;;FA;;;CONTOSO\\alice)(A;OICI;FA;;;SY)(A;;FA;;;SY)(A;OICI;FA;;;BA)(A;;FA;;;BA)";

describe("OpenBot state ACL", () => {
  it("applies and verifies only the current account, SYSTEM, and Administrators", async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: POLICY_SDDL },
    ]);

    const result = await applyOpenBotStateAcl("C:\\Temp\\OpenBot-state-test", {
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    expect(result).toMatchObject({ status: "verified", platform: "win32" });
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.file === systemToolPath("icacls.exe"))).toBe(true);
    expect(calls.every((call) => ! call.options.shell &&  call.options.windowsHide)).toBe(true);
    expect(calls[0]?.args).toEqual(["C:\\Temp\\OpenBot-state-test", "/reset", "/T", "/Q"]);
    expect(calls[1]?.args).toEqual([
      "C:\\Temp\\OpenBot-state-test",
      "/grant:r",
      "CONTOSO\\alice:(OI)(CI)F",
      "CONTOSO\\alice:F",
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-18:F",
      "*S-1-5-32-544:(OI)(CI)F",
      "*S-1-5-32-544:F",
      "/T",
      "/Q",
    ]);
    expect(calls[2]?.args).toEqual(["C:\\Temp\\OpenBot-state-test", "/inheritance:r", "/T", "/Q"]);
    expect(calls[3]?.args).toEqual(["C:\\Temp\\OpenBot-state-test", "/verify", "/T", "/Q"]);
    expect(calls[4]?.args[0]).toBe("C:\\Temp\\OpenBot-state-test");
    expect(calls[4]?.args[1]).toBe("/save");
  });

  it("fails closed without verification when an ACL step fails", async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: 5, stderr: "Access is denied" },
      { exitCode: 0 },
    ]);

    const result = await applyOpenBotStateAcl("C:\\Temp\\OpenBot-state-test", {
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    expect(result).toMatchObject({ status: "failed", platform: "win32" });
    expect(result.message).toMatch(/step 1 failed with exit 5/i);
    expect(calls).toHaveLength(1);
  });

  it("verifies an already protected tree without mutating its ACL", async () => {
    const { runner, calls } = fakeRunner([{ exitCode: 0 }, { exitCode: 0, stdout: POLICY_SDDL }]);

    const result = await verifyOpenBotStateAcl("C:\\Temp\\OpenBot-state-test", {
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    expect(result).toMatchObject({ status: "verified", platform: "win32" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(["C:\\Temp\\OpenBot-state-test", "/verify", "/T", "/Q"]);
    expect(calls[1]?.args[0]).toBe("C:\\Temp\\OpenBot-state-test");
    expect(calls[1]?.args[1]).toBe("/save");
  });
});

describe("state root ACL during bootstrap", () => {
  const temp = new TempRoots();
  const STATE_ACL_SDDL = "D:P(A;OICI;FA;;;CONTOSO\\alice)(A;;FA;;;CONTOSO\\alice)(A;OICI;FA;;;SY)(A;;FA;;;SY)(A;OICI;FA;;;BA)(A;;FA;;;BA)";
  const stateAclFixture = (calls: string[], onCall?: () => void): StateAclCommandRunner => async (_file, args) => {
    calls.push(args[1] ?? "");
    onCall?.();
    if (args[1] === "/save") {
      const aclPath = args[2];
      if (aclPath === undefined) throw new Error("ACL fixture save path is missing");
      writeFileSync(aclPath, STATE_ACL_SDDL, "utf8");
    }
    return { exitCode: 0 };
  };
  afterEach(async () => {
    await temp.cleanup();
  });

  it("protects an injected state root before creating standalone state files", async () => {
    const root = temp.make("openbot-state-acl-");
    const calls: string[] = [];
    const tokenPath = join(root, "gateway.token");
    const storePath = join(root, "store.db");
    const runner = stateAclFixture(calls, () => {
      if (!existsSync(tokenPath)) expect(existsSync(tokenPath)).toBe(false);
    });

    const handle = await startServer(0, {
      stateRoot: root,
      stateAcl: { platform: "win32", runner, currentUser: "CONTOSO\\alice" },
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    });
    try {
      expect(calls).toEqual(["/reset", "/grant:r", "/inheritance:r", "/verify", "/save"]);
      expect(existsSync(tokenPath)).toBe(false);
      expect(existsSync(storePath)).toBe(true);
    } finally {
      await stopServer(handle);
    }
  });

  it("uses verification-only ACL work on a recurring boot with a valid protected stamp", async () => {
    const root = temp.make("openbot-state-acl-recurring-");
    const calls: string[] = [];
    const runner = stateAclFixture(calls);
    const options = {
      stateRoot: root,
      stateAcl: { platform: "win32" as const, runner, currentUser: "CONTOSO\\alice" },
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    };

    const first = await startServer(0, options);
    await stopServer(first);
    expect(calls).toEqual(["/reset", "/grant:r", "/inheritance:r", "/verify", "/save"]);

    calls.length = 0;
    const second = await startServer(0, options);
    await stopServer(second);
    expect(calls).toEqual(["/verify", "/save"]);
  });

  it("reapplies the ACL and replaces a corrupted recurring-boot stamp", async () => {
    const root = temp.make("openbot-state-acl-corrupt-stamp-");
    const calls: string[] = [];
    const runner = stateAclFixture(calls);
    const options = {
      stateRoot: root,
      stateAcl: { platform: "win32" as const, runner, currentUser: "CONTOSO\\alice" },
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    };
    const first = await startServer(0, options);
    await stopServer(first);
    writeFileSync(join(root, ".openbot-acl-v1.json"), "corrupted", "utf8");

    calls.length = 0;
    const second = await startServer(0, options);
    await stopServer(second);
    expect(calls).toEqual(["/reset", "/grant:r", "/inheritance:r", "/verify", "/save"]);
  });

  it("fails closed before opening config/store when state ACL setup fails", async () => {
    const root = temp.make("openbot-state-acl-fail-");
    const configPath = join(root, "config.json");
    const storePath = join(root, "store.db");
    const tokenPath = join(root, "gateway.token");
    const runner: StateAclCommandRunner = async () => ({ exitCode: 5, stderr: "denied" });

    await expect(startServer(0, {
      stateRoot: root,
      stateAcl: { platform: "win32", runner, currentUser: "CONTOSO\\alice" },
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    })).rejects.toThrow(/ACL/i);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(tokenPath)).toBe(false);
  });

  it("rejects partially injected test state without touching the default AppData root", async () => {
    const root = temp.make("openbot-state-partial-");
    await expect(startServer(0, {
      configPath: join(root, "config.json"),
      storePath: join(root, "store.db"),
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    })).rejects.toThrow(/explicit OpenBot state paths/i);
    expect(existsSync(join(root, "config.json"))).toBe(false);
    expect(existsSync(join(root, "store.db"))).toBe(false);
  });
});
