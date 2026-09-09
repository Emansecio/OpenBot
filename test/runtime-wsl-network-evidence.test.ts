import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- executable scripts do not emit declaration files
import { validateBlockedNetworkProbe } from "../scripts/runtime-wsl-network-evidence.mjs";

describe("WSL live network evidence", () => {
  it("uses process-owned descriptor evidence instead of a global socket-table digest", () => {
    const liveHarness = readFileSync(fileURLToPath(new URL("../scripts/run-runtime-wsl-live.mjs", import.meta.url)), "utf8");
    const probeSection = liveHarness.slice(
      liveHarness.indexOf("const tcpScript = ["),
      liveHarness.indexOf("const timeout =", liveHarness.indexOf("const tcpScript = [")),
    );
    expect(probeSection.match(/fs\.readdirSync\('\/proc\/self\/fd'\)/gu)).toHaveLength(2);
    expect(probeSection.match(/fs\.readlinkSync\('\/proc\/self\/fd\/'\+fd\)/gu)).toHaveLength(2);
    expect(probeSection).not.toMatch(/\/proc\/net\/(?:tcp|udp)|socketDigest|createHash/u);

    expect(validateBlockedNetworkProbe('{"status":"blocked","code":"EPERM","socketFds":[]}', "tcp"))
      .toEqual({ status: "blocked", code: "EPERM", socketFds: [] });
    expect(validateBlockedNetworkProbe('{"status":"blocked","code":"EAI_AGAIN","socketFds":[]}', "dns"))
      .toEqual({ status: "blocked", code: "EAI_AGAIN", socketFds: [] });
  });

  it("rejects successful egress, timeout-only evidence and a retained socket", () => {
    expect(() => validateBlockedNetworkProbe('{"status":"connected","code":"CONNECTED","socketFds":[]}', "tcp")).toThrow(/not fail-closed/u);
    expect(() => validateBlockedNetworkProbe('{"status":"blocked","code":"TIMEOUT","socketFds":[]}', "tcp")).toThrow(/not fail-closed/u);
    expect(() => validateBlockedNetworkProbe('{"status":"blocked","code":"EPERM","socketFds":["socket:[42]"]}', "tcp")).toThrow(/retained socket/u);
  });
});
