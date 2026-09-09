import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HomeAuditLogger } from "../src/execution/audit.js";
import { LocalExecutionBroker, createAgentHomeBroker } from "../src/execution/broker.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";
import { DEFAULT_HOME_POLICY, PolicyEngine, PolicyError, extractRequestPaths, parsePolicy, readHomePolicy } from "../src/execution/policy.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
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

describe("policy engine", () => {
  it("ships a zero-friction default: everything allowed", async () => {
    const homeRoot = await tempDir("openbot-default-policy-");
    const policy = await readHomePolicy(homeRoot);
    expect(policy).toBe(DEFAULT_HOME_POLICY);
    const engine = new PolicyEngine(policy);
    expect(engine.evaluate("agent-a", "file.write", ["Documents/x.txt"]).effect).toBe("allow");
    expect(engine.evaluate("agent-a", "command.run", [".", "Projects"]).effect).toBe("allow");
    expect(engine.evaluate("agent-a", "browser.snapshot", []).effect).toBe("allow");
  });

  it("first matching rule wins and path globs filter matches", () => {
    const engine = new PolicyEngine(parsePolicy({
      rules: [
        { match: { tool: "file.write", path: "Desktop/**" }, effect: "ask" },
        { match: { tool: "file.*", path: "**" }, effect: "allow" },
      ],
      default: "deny",
    }));
    expect(engine.evaluate("a", "file.write", ["Desktop/x.txt"]).effect).toBe("ask");
    expect(engine.evaluate("a", "file.write", ["Documents/x.txt"]).effect).toBe("allow");
    expect(engine.evaluate("a", "process.run", []).effect).toBe("deny");
  });

  it("rate-limited rules degrade to ask when the window is full", () => {
    const engine = new PolicyEngine(parsePolicy({
      rules: [{ match: { tool: "file.write", path: "**" }, effect: "allow", rateLimit: "2/minute" }],
      default: "allow",
    }));
    const now = 1_000_000;
    expect(engine.evaluate("a", "file.write", ["x"], now).effect).toBe("allow");
    expect(engine.evaluate("a", "file.write", ["x"], now + 1).effect).toBe("allow");
    expect(engine.evaluate("a", "file.write", ["x"], now + 2).effect).toBe("ask");
    expect(engine.evaluate("a", "file.write", ["x"], now + 61_000).effect).toBe("allow");
  });

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

  it("rejects invalid policy documents", () => {
    expect(() => parsePolicy({ rules: [{ match: { tool: "file.*" }, effect: "maybe" }], default: "allow" })).toThrow(PolicyError);
    expect(() => parsePolicy({ rules: "nope", default: "allow" })).toThrow(PolicyError);
  });
});

const PolicyErrorName = "PolicyError";
void PolicyErrorName;

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe("broker audit + policy", () => {
  it("records a decision entry before execution and an outcome after", async () => {
    const entries: Array<Record<string, unknown>> = [];
    let entryKindsAtExecution: unknown[] = [];
    const backend: ExecutionBackend = {
      execute: async () => {
        entryKindsAtExecution = entries.map((entry) => entry.kind);
        return { ok: true, operation: "file.write", bytes: 4 };
      },
    };
    const broker = new LocalExecutionBroker(backend, () => "always", undefined, 5 * 60_000, {
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

  it("policy ask forces the approval flow even in always mode", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const broker = new LocalExecutionBroker(okBackend(), () => "always", undefined, 5 * 60_000, {
      decidePolicy: () => ({ effect: "ask", ruleIndex: 0 }),
      audit: (entry) => {
        entries.push({ ...entry });
      },
    });
    let requested: unknown;
    broker.setApprovalListener((approval) => {
      requested = approval;
    });
    const pending = broker.execute("agent-a", "req-2", writeRequest("Desktop/x.txt"));
    await tick();
    expect(requested).toMatchObject({ requestId: "req-2" });
    expect(broker.pendingCount).toBe(1);
    expect(broker.resolve("req-2", "allow")).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(entries[0]).toMatchObject({ kind: "decision", decision: "ask", source: "policy", ruleIndex: 0 });
    expect(entries.at(-1)).toMatchObject({ kind: "outcome", outcome: "ok" });
  });

  it("policy deny blocks execution and audits the outcome", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const broker = new LocalExecutionBroker(okBackend(), () => "always", undefined, 5 * 60_000, {
      decidePolicy: () => ({ effect: "deny" }),
      audit: (entry) => {
        entries.push({ ...entry });
      },
    });
    await expect(broker.execute("agent-a", "req-3", writeRequest("x"))).resolves.toMatchObject({ ok: false, code: "permission_denied" });
    expect(entries[0]).toMatchObject({ kind: "decision", decision: "deny", source: "policy" });
    expect(entries[1]).toMatchObject({ kind: "outcome", outcome: "error", code: "permission_denied" });
  });

  it("policy evaluation failure fails closed", async () => {
    const broker = new LocalExecutionBroker(okBackend(), () => "always", undefined, 5 * 60_000, {
      decidePolicy: () => {
        throw new Error("boom");
      },
    });
    await expect(broker.execute("agent-a", "req-4", writeRequest("x"))).resolves.toMatchObject({ ok: false, code: "permission_denied" });
  });
});

describe("home broker hooks wiring", () => {
  it("writes the audit trail into .openbot/audit and enforces policy.json", async () => {
    const root = await tempDir("openbot-audit-store-");
    const homes = {
      pathFor: (agentId: string): string => join(root, agentId),
      backendFor: async (): Promise<ExecutionBackend> => okBackend(),
    };
    await writeFile(join(root, "agent-a", ".openbot", "policy.json"), `${JSON.stringify({
      rules: [{ match: { tool: "file.write", path: "Desktop/**" }, effect: "deny" }],
      default: "allow",
    }, null, 2)}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return import("node:fs/promises").then(async ({ mkdir }) => {
        await mkdir(join(root, "agent-a", ".openbot"), { recursive: true });
        await writeFile(join(root, "agent-a", ".openbot", "policy.json"), `${JSON.stringify({
          rules: [{ match: { tool: "file.write", path: "Desktop/**" }, effect: "deny" }],
          default: "allow",
        }, null, 2)}\n`, { flag: "wx" });
      });
    });
    const broker = createAgentHomeBroker(homes, { permission: () => "always", allowedAgentIds: () => ["agent-a"] });
    await expect(broker.execute("agent-a", "req-5", writeRequest("Desktop/x.txt")))
      .resolves.toMatchObject({ ok: false, code: "permission_denied" });
    await expect(broker.execute("agent-a", "req-6", writeRequest("Documents/x.txt")))
      .resolves.toMatchObject({ ok: true });

    const lines = await readAuditLines(join(root, "agent-a"));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ kind: "decision", decision: "deny", agentId: "agent-a" });
    expect(lines[2]).toMatchObject({ kind: "decision", decision: "allow", source: "global" });
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
