import { describe, expect, it } from "vitest";

import {
  applyOpenBotStateAcl,
  verifyOpenBotStateAcl,
  type StateAclCommandOptions,
  type StateAclCommandResult,
  type StateAclCommandRunner,
} from "../src/state-acl.js";

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

describe("OpenBot state ACL", () => {
  it("applies and verifies only the current account, SYSTEM, and Administrators", async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
    ]);

    const result = await applyOpenBotStateAcl("C:\\Temp\\OpenBot-state-test", {
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    expect(result).toMatchObject({ status: "verified", platform: "win32" });
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.file === "icacls.exe")).toBe(true);
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
    const { runner, calls } = fakeRunner([{ exitCode: 0 }]);

    const result = await verifyOpenBotStateAcl("C:\\Temp\\OpenBot-state-test", {
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    expect(result).toMatchObject({ status: "verified", platform: "win32" });
    expect(calls.map((call) => call.args)).toEqual([
      ["C:\\Temp\\OpenBot-state-test", "/verify", "/T", "/Q"],
    ]);
  });
});
