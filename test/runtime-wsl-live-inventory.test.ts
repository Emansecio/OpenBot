import { describe, expect, it } from "vitest";

describe("WSL live inventory", () => {
  it("fails closed when an expected inventory root is a symbolic link", async () => {
    // @ts-expect-error executable live-gate helper has no declaration file.
    const { listGuestInventoryRoot } = await import("../scripts/runtime-wsl-live-inventory.mjs");
    const run = async (args: string[]) => {
      if (args[0] === "test" && args[1] === "-L") return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (args[0] === "test" && (args[1] === "-e" || args[1] === "-d")) {
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (args[0] === "find") return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };

    await expect(listGuestInventoryRoot(run, "/run/openbot/leases"))
      .rejects.toThrow(/symbolic link/iu);
  });

  it("fails closed when an expected inventory root exists as a regular file", async () => {
    // @ts-expect-error executable live-gate helper has no declaration file.
    const { listGuestInventoryRoot } = await import("../scripts/runtime-wsl-live-inventory.mjs");
    const run = async (args: string[]) => {
      if (args[0] === "test" && args[1] === "-L") return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (args[0] === "test" && args[1] === "-e") return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (args[0] === "test" && args[1] === "-d") return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };

    await expect(listGuestInventoryRoot(run, "/run/openbot/leases"))
      .rejects.toThrow(/not a directory/iu);
  });

  it("detects every process owned by a managed guest user regardless of executable", async () => {
    // @ts-expect-error executable live-gate helper has no declaration file.
    const { selectActiveGuestUserProcesses } = await import("../scripts/runtime-wsl-live-inventory.mjs");
    const sleeper = "123 ob-agent 0:00 sleep 600";
    const processTable = [
      "PID USER TIME COMMAND",
      "1 root 0:00 /sbin/init",
      sleeper,
      "124 root 0:00 node system-helper.js",
    ].join("\n");

    expect(selectActiveGuestUserProcesses(processTable)).toEqual([sleeper]);
  });

  it("fails when the post-execution socket inventory contains an entry outside the baseline", async () => {
    // @ts-expect-error executable live-gate helper has no declaration file.
    const { assertNoResidualGuestSockets, parseGuestSocketEntries } = await import("../scripts/runtime-wsl-live-inventory.mjs");
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
    const baseline = parseGuestSocketEntries([
      header,
      "   0: 0100007F:0538 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1001 1",
    ].join("\n"));
    const after = parseGuestSocketEntries([
      header,
      "   0: 0100007F:0538 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1001 1",
      "   1: 0100007F:0538 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 2002 1",
    ].join("\n"));

    expect(() => assertNoResidualGuestSockets(baseline, after, "post-execution inventory"))
      .toThrow(/residual guest sockets/iu);
  });
});
