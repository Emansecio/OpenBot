import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  WindowsHomeAclAdapter,
  type HomeAclCommandOptions,
  type HomeAclCommandResult,
  type HomeAclCommandRunner,
} from "../src/execution/home-acl.js";

interface RecordedCall {
  file: string;
  args: readonly string[];
  options: HomeAclCommandOptions;
}

function fakeRunner(results: HomeAclCommandResult[]): { runner: HomeAclCommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: HomeAclCommandRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    return results.shift() ?? { exitCode: 0 };
  };
  return { runner, calls };
}

const POLICY_SDDL = "D:P(A;OICI;FA;;;CONTOSO\\alice)(A;;FA;;;CONTOSO\\alice)(A;OICI;FA;;;SY)(A;;FA;;;SY)(A;OICI;FA;;;BA)(A;;FA;;;BA)";

describe("WindowsHomeAclAdapter", () => {
  it("does nothing outside Windows", async () => {
    const { runner, calls } = fakeRunner([{ exitCode: 99 }]);
    const adapter = new WindowsHomeAclAdapter({ platform: "linux", runner });

    await expect(adapter.apply("not-a-real-path", { agentId: "a", operation: "create" })).resolves.toMatchObject({
      status: "not-applicable",
      platform: "linux",
    });
    expect(calls).toEqual([]);
  });

  it("uses literal icacls calls without a shell and runs canonical DACL verification", async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: 0, stdout: "reset" },
      { exitCode: 0, stdout: "inheritance removed" },
      { exitCode: 0, stdout: "granted" },
      { exitCode: 0, stdout: "Successfully processed 1 files" },
      { exitCode: 0, stdout: POLICY_SDDL },
    ]);
    const adapter = new WindowsHomeAclAdapter({
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    const result = await adapter.apply("C:\\OpenBot\\workspaces\\agent-a", {
      agentId: "agent-a",
      operation: "create",
    });

    expect(result).toMatchObject({ status: "verified", platform: "win32" });
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.file === "icacls.exe")).toBe(true);
    expect(calls.every((call) => ! call.options.shell &&  call.options.windowsHide)).toBe(true);
    expect(calls[0]?.args).toEqual(["C:\\OpenBot\\workspaces\\agent-a", "/reset", "/T", "/Q"]);
    expect(calls[1]?.args).toEqual([
      "C:\\OpenBot\\workspaces\\agent-a",
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
    expect(calls[2]?.args).toEqual(["C:\\OpenBot\\workspaces\\agent-a", "/inheritance:r", "/T", "/Q"]);
    expect(calls[3]?.args).toEqual(["C:\\OpenBot\\workspaces\\agent-a", "/verify", "/T", "/Q"]);
    expect(calls[4]?.args[0]).toBe("C:\\OpenBot\\workspaces\\agent-a");
    expect(calls[4]?.args.slice(1, 2)).toEqual(["/save"]);
    const joined = calls[1]?.args.join(" ") ?? "";
    expect(joined).not.toMatch(/(?:everyone|users)/iu);
  });

  it("limits an icacls runner that never returns", async () => {
    const adapter = new WindowsHomeAclAdapter({
      platform: "win32",
      currentUser: "CONTOSO\\alice",
      commandTimeoutMs: 10,
      runner: async () => await new Promise(() => undefined),
    });

    await expect(adapter.apply("C:\\OpenBot\\workspaces\\agent-a", {
      agentId: "agent-a",
      operation: "create",
    })).resolves.toMatchObject({ status: "failed", message: expect.stringMatching(/timed out/i) });
  });

  it("fails closed when an apply step fails and does not attempt verification", async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: 5, stderr: "Access is denied" },
      { exitCode: 0 },
    ]);
    const adapter = new WindowsHomeAclAdapter({
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    const result = await adapter.apply("C:\\OpenBot\\workspaces\\agent-a", {
      agentId: "agent-a",
      operation: "repair",
    });

    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/step 1 failed with exit 5/i);
    expect(calls).toHaveLength(1);
  });

  it("fails closed when verification exits non-zero", async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 2, stderr: "The ACL is not canonical" },
    ]);
    const adapter = new WindowsHomeAclAdapter({
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    const result = await adapter.apply("C:\\OpenBot\\workspaces\\agent-a", {
      agentId: "agent-a",
      operation: "restore",
    });

    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/verification failed with exit 2/i);
    expect(calls).toHaveLength(4);
  });

  it("rejects a canonical ACL that grants an unexpected principal", async () => {
    const { runner } = fakeRunner([
      { exitCode: 0 },
      { exitCode: 0, stdout: "D:P(A;;FA;;;CONTOSO\\alice)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-9-8-7-6)" },
    ]);
    const adapter = new WindowsHomeAclAdapter({
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    const result = await adapter.verify("C:\\OpenBot\\workspaces\\agent-a");

    expect(result).toMatchObject({ status: "failed", platform: "win32" });
    expect(result.message).toMatch(/unexpected principal|descriptor could not be read/i);
  });

  it("rejects an ACL that omits a required principal or enables inheritance", async () => {
    const { runner } = fakeRunner([
      { exitCode: 0 },
      { exitCode: 0, stdout: "D:(A;;FA;;;CONTOSO\\alice)(A;;FA;;;SY)" },
    ]);
    const adapter = new WindowsHomeAclAdapter({
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    const result = await adapter.verify("C:\\OpenBot\\workspaces\\agent-a");

    expect(result).toMatchObject({ status: "failed", platform: "win32" });
    expect(result.message).toMatch(/inheritance|missing/i);
  });

  it("matches a saved numeric user SID supplied by the host identity seam", async () => {
    const { runner } = fakeRunner([
      { exitCode: 0 },
      { exitCode: 0, stdout: "D:P(A;OICI;FA;;;S-1-5-21-100-200-300-400)(A;;FA;;;SY)(A;;FA;;;BA)" },
    ]);
    const adapter = new WindowsHomeAclAdapter({
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
      currentUserSid: "S-1-5-21-100-200-300-400",
    });

    await expect(adapter.verify("C:\\OpenBot\\workspaces\\agent-a")).resolves.toMatchObject({
      status: "verified",
      platform: "win32",
    });
  });

  it("resolves the current account SID without a shell when the descriptor uses SDDL", async () => {
    const { runner, calls } = fakeRunner([
      { exitCode: 0 },
      { exitCode: 0, stdout: "D:P(A;;FA;;;S-1-5-21-100-200-300-400)(A;;FA;;;SY)(A;;FA;;;BA)" },
      { exitCode: 0, stdout: "\"CONTOSO\\\\alice\",\"S-1-5-21-100-200-300-400\"" },
    ]);
    const adapter = new WindowsHomeAclAdapter({
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
    });

    await expect(adapter.verify("C:\\OpenBot\\workspaces\\agent-a")).resolves.toMatchObject({
      status: "verified",
      platform: "win32",
    });
    expect(calls[2]?.file).toBe("whoami.exe");
    expect(calls[2]?.options.shell).toBe(false);
  });

  it("accepts inherited Full Control entries on children created after apply", async () => {
    const { runner } = fakeRunner([
      { exitCode: 0 },
      { exitCode: 0, stdout: "D:AI(A;OICIID;FA;;;S-1-5-21-100-200-300-400)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)\nD:AI(A;ID;FA;;;S-1-5-21-100-200-300-400)(A;ID;FA;;;SY)(A;ID;FA;;;BA)" },
    ]);
    const adapter = new WindowsHomeAclAdapter({
      platform: "win32",
      runner,
      currentUser: "CONTOSO\\alice",
      currentUserSid: "S-1-5-21-100-200-300-400",
    });

    await expect(adapter.verify("C:\\OpenBot\\workspaces\\agent-a")).resolves.toMatchObject({
      status: "verified",
      platform: "win32",
    });
  });

  it("rejects broad or malformed current principals before invoking icacls", async () => {
    const { runner, calls } = fakeRunner([{ exitCode: 0 }]);
    for (const currentUser of ["Everyone", "CONTOSO\\alice\\unexpected", "CONTOSO/alice"]) {
      const adapter = new WindowsHomeAclAdapter({ platform: "win32", runner, currentUser });
      const result = await adapter.apply("C:\\OpenBot\\workspaces\\agent-a", {
        agentId: "agent-a",
        operation: "create",
      });
      expect(result.status, currentUser).toBe("failed");
      expect(result.message, currentUser).toMatch(/safe ACL principal/i);
    }
    expect(calls).toEqual([]);
  });

  it.skipIf(process.platform !== "win32" || process.env.OPENBOT_RUN_LIVE_ACL_TEST !== "1")(
    "live Windows gate keeps nested files writable and removable after DACL apply",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "openbot-acl-live-"));
      try {
        const nested = join(root, "Documents");
        await mkdir(nested);
        const file = join(nested, "probe.txt");
        await writeFile(file, "before\n");
        const result = await new WindowsHomeAclAdapter().apply(root, {
          agentId: "live-acl",
          operation: "create",
        });
        expect(result.status).toBe("verified");
        await appendFile(file, "after\n");
        await rm(file);
        const lateDirectory = join(root, "Late");
        const lateFile = join(lateDirectory, "created-after-acl.txt");
        await mkdir(lateDirectory);
        await writeFile(lateFile, "created-after-acl\n");
        await expect(new WindowsHomeAclAdapter().verify(root)).resolves.toMatchObject({
          status: "verified",
          platform: "win32",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
