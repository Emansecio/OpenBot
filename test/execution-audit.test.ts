import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HomeAuditLogger } from "../src/execution/audit.js";
import { LocalExecutionBroker, createAgentHomeBroker } from "../src/execution/broker.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";
import { extractRequestPaths } from "../src/execution/request-paths.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();
afterEach(async () => {
  await temp.cleanup();
});

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temp.track(dir);
  return dir;
};

const okBackend = (): ExecutionBackend => ({
  execute: async (request: ExecutionRequest): Promise<ExecutionResult> => {
    if (request.operation === "file.write") {
      return { ok: true, operation: "file.write", bytes: 4 };
    }
    return { ok: true, operation: request.operation } as ExecutionResult;
  },
});

const writeRequest = (path: string): ExecutionRequest => ({
  operation: "file.write",
  path,
  content: "data",
  encoding: "utf8",
});

async function readAuditLines(homeRoot: string): Promise<Array<Record<string, unknown>>> {
  const dir = join(homeRoot, ".openbot", "audit");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  const lines: string[] = [];
  for (const name of names) lines.push(await readFile(join(dir, name), "utf8"));
  return lines.join("\n").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("request paths", () => {
  it("extracts paths from every file operation shape", () => {
    const cases: Array<{ request: ExecutionRequest; paths: string[] }> = [
      { request: { operation: "file.list", path: "list" }, paths: ["list"] },
      { request: { operation: "file.stat", path: "stat" }, paths: ["stat"] },
      { request: { operation: "file.mkdir", path: "mkdir" }, paths: ["mkdir"] },
      { request: { operation: "file.copy", source: "copy-source", destination: "copy-destination" }, paths: ["copy-source", "copy-destination"] },
      { request: { operation: "file.move", source: "move-source", destination: "move-destination" }, paths: ["move-source", "move-destination"] },
      { request: { operation: "file.trash", path: "trash" }, paths: ["trash"] },
      { request: { operation: "file.restore", trashId: "trash-id", path: "restore" }, paths: ["restore"] },
      { request: { operation: "file.restore", trashId: "trash-id" }, paths: [""] },
      { request: { operation: "file.read", path: "read", encoding: "utf8" }, paths: ["read"] },
      { request: writeRequest("write"), paths: ["write"] },
    ];
    for (const testCase of cases) expect(extractRequestPaths(testCase.request)).toEqual(testCase.paths);
    expect(extractRequestPaths({
      operation: "command.run",
      command: "search.text",
      cwd: ".",
      params: { pattern: "x", mode: "fixed", paths: ["Projects"] },
    })).toEqual([".", "Projects"]);
    expect(extractRequestPaths({ operation: "browser.snapshot" })).toEqual([]);
  });
});

describe("broker audit", () => {
  it("records a decision entry before execution and an outcome after", async () => {
    const entries: Array<Record<string, unknown>> = [];
    let entryKindsAtExecution: unknown[] = [];
    const backend: ExecutionBackend = {
      execute: async () => {
        entryKindsAtExecution = entries.map((entry) => entry.kind);
        return { ok: true, operation: "file.write", bytes: 4 };
      },
    };
    const broker = new LocalExecutionBroker(backend, {
      audit: (entry) => {
        entries.push({ ...entry });
      },
    });
    const result = await broker.execute("agent-a", "req-1", writeRequest("Documents/x.txt"));
    expect(result).toMatchObject({ ok: true });
    expect(entryKindsAtExecution).toEqual(["decision"]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "decision", agentId: "agent-a", requestId: "req-1", decision: "allow", source: "global" });
    expect((entries[0] as { paths: string[] }).paths).toEqual(["Documents/x.txt"]);
    expect(entries[1]).toMatchObject({ kind: "outcome", outcome: "ok" });
  });

  it("writes the audit trail into .openbot/audit only for existing registered homes", async () => {
    const root = await tempDir("openbot-audit-store-");
    await mkdir(join(root, "agent-a", ".openbot"), { recursive: true });
    const homes = {
      pathFor: (agentId: string): string => join(root, agentId),
      backendFor: async (): Promise<ExecutionBackend> => okBackend(),
    };
    const broker = createAgentHomeBroker(homes, { allowedAgentIds: () => ["agent-a"] });
    await expect(broker.execute("agent-a", "req-6", writeRequest("Documents/x.txt"))).resolves.toMatchObject({ ok: true });
    await expect(broker.execute("agent-b", "req-7", writeRequest("Documents/x.txt")))
      .resolves.toMatchObject({ ok: false, code: "permission_denied" });

    const lines = await readAuditLines(join(root, "agent-a"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "decision", decision: "allow", source: "global", agentId: "agent-a" });
    expect(lines[1]).toMatchObject({ kind: "outcome", outcome: "ok" });
    await expect(readdir(join(root, "agent-b"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("HomeAuditLogger", () => {
  it("appends JSONL entries and counts failures without throwing", async () => {
    const homeRoot = await tempDir("openbot-audit-logger-");
    const logger = new HomeAuditLogger(homeRoot, "agent-a");
    await logger.record({ kind: "decision", requestId: "r1", operation: "file.write", paths: ["x"], decision: "allow", source: "global" });
    const lines = await readAuditLines(homeRoot);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agentId: "agent-a", kind: "decision", decision: "allow" });

    // A file where the audit directory should be makes every write fail.
    const blocker = join(homeRoot, "blocker");
    await writeFile(blocker, "not-a-dir");
    const broken = new HomeAuditLogger(join(blocker, "nested"), "agent-b");
    await broken.record({ kind: "outcome", requestId: "r2", operation: "file.write", outcome: "ok", durationMs: 1 });
    expect(broken.failedWrites).toBe(1);
  });
});
