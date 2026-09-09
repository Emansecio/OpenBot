import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixturePath = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runFixture(name: string, mode: string): string {
  return execFileSync(process.execPath, [fixturePath(name), "--mode", mode], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000,
  });
}

describe("P2.5 RED — versioned offline CLI fixture protocols", () => {
  it.each([
    ["codex-cli-v1.mjs", "codex-cli.v1"],
    ["claude-code-v1.mjs", "claude-code.v1"],
  ])("defines ordered session/delta/usage/done frames for %s", (fixture, protocol) => {
    const frames = runFixture(fixture, "stream").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(frames.map((frame) => frame.type)).toEqual(["session", "delta", "usage", "done"]);
    expect(frames.every((frame) => frame.protocol === protocol)).toBe(true);
    expect(frames.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4]);
  });

  it.each([
    ["codex-cli-v1.mjs", "codex-cli.v1"],
    ["claude-code-v1.mjs", "claude-code.v1"],
  ])("includes malformed, EOF, unknown, duplicate-terminal and byte-cap fixtures for %s", (fixture, protocol) => {
    expect(runFixture(fixture, "malformed")).toContain("{not-json");
    const eof = runFixture(fixture, "eof").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(eof.at(-1)?.type).not.toBe("done");
    const unknown = runFixture(fixture, "unknown").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(unknown.at(-1)).toMatchObject({ protocol, type: "future.event" });
    const duplicate = runFixture(fixture, "duplicate-terminal").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(duplicate.filter((frame) => frame.type === "done")).toHaveLength(2);
    expect(Buffer.byteLength(runFixture(fixture, "oversized"), "utf8")).toBeGreaterThan(32_000);
  });
});
