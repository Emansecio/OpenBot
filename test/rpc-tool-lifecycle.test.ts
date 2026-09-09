import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalExecutionBroker } from "../src/execution/broker.js";
import type { ExecutionBackend } from "../src/execution/contracts.js";
import { HomeWorkspaceBackend } from "../src/execution/home-backend.js";
import { AgentHomeStore } from "../src/execution/home.js";
import { runToolLoop } from "../src/execution/tool-loop.js";
import { LocalProcessRunner } from "../src/execution/runtime/local/driver.js";
import type { RuntimeLease } from "../src/execution/runtime/contracts.js";
import { createProviderRegistry, type ProviderAdapter } from "../src/providers/router.js";
import { createMemoryTranscriptStore, createTurnRunner } from "../src/rpc/send.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const toolWrite = (id: string, path: string, content: string) => ({
  id,
  type: "function" as const,
  function: { name: "file", arguments: JSON.stringify({ op: "write", path, content, encoding: "utf8" }) },
});

async function bootHome() {
  const dir = await mkdtemp(join(tmpdir(), "openbot-life-"));
  dirs.push(dir);
  const homes = await AgentHomeStore.create(dir);
  const home = await homes.ensure("openbot-default");
  const backend = await HomeWorkspaceBackend.create(home.root);
  const broker = new LocalExecutionBroker(backend, () => "always", () => {});
  const events: { channel: string; payload: Record<string, unknown> }[] = [];
  const store = createMemoryTranscriptStore();
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: "scripted",
    async streamChat(_request, emit) {
      calls += 1;
      if (calls === 1) emit({ type: "tool-call", call: toolWrite("w1", "Documents/nota.md", "from-card") });
      else emit({ type: "delta", delta: "gravado" });
    },
  };
  const registry = createProviderRegistry();
  registry.register(adapter);
  const runner = createTurnRunner({
    registry,
    store,
    executionBroker: broker,
    tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
    resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    publish: (channel, payload) => events.push({ channel, payload: payload as Record<string, unknown> }),
  });
  return { runner, store, home, events };
}

describe("tool-call lifecycle", () => {
  it.each([
    { kind: "exit", tail: "process.exitCode=7", timeoutMs: 3000, code: "process_failed" },
    { kind: "timeout", tail: "setInterval(()=>{},1000)", timeoutMs: 600, code: "timed_out" },
  ])("reports native $kind failure and redacts partial output before provider delivery", async ({ kind, tail, timeoutMs, code }) => {
    const root = await mkdtemp(join(tmpdir(), "openbot-life-process-"));
    dirs.push(root);
    const native = new LocalProcessRunner("openbot-default", root);
    const lease = { agentId: "openbot-default", capability: { networkProfile: "host" } } as RuntimeLease;
    const broker = new LocalExecutionBroker({ execute: (request, signal) => {
      if (request.operation !== "process.run") throw new Error("unexpected operation");
      return native.run(lease, request, signal ?? new AbortController().signal);
    } }, () => "always");
    const secret = "synthetic-process-secret-829463";
    const store = createMemoryTranscriptStore();
    let calls = 0;
    let delivered = "";
    const registry = createProviderRegistry();
    registry.register({ name: "scripted", async streamChat(request, emit) {
      if (++calls === 1) emit({ type: "tool-call", call: {
        id: "native-failure", type: "function", function: { name: "process_run", arguments: JSON.stringify({
          executable: process.execPath, argv: ["-e", "require('fs').writeFileSync('effect.txt','done');process.stdout.write('partial '+process.env.AUDIT_SECRET);process.stderr.write(process.env.AUDIT_SECRET);" + tail],
          cwd: ".", timeoutMs, networkProfile: "host", env: { AUDIT_SECRET: secret },
        }) },
      } });
      else { delivered = JSON.stringify(request.messages.filter((message) => message.role === "tool")); emit({ type: "delta", delta: "falhou" }); }
    } });
    const runner = createTurnRunner({ registry, store, executionBroker: broker,
      tools: [{ type: "function", function: { name: "process_run", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });
    runner.sendPrompt({ agentId: "openbot-default", prompt: "execute local fixture" });
    await runner.flush("openbot-default");
    expect(store.getEntries("openbot-default").find((entry) => entry.kind === "tool-call"))
      .toMatchObject({ status: "failed", result: { ok: false, code, ...(kind === "exit" ? { exitCode: 7 } : {}) } });
    expect(delivered).toContain("partial");
    if (kind === "timeout") expect(delivered).toContain("partialOutput");
    expect(delivered).toContain("REDACTED");
    expect(delivered).not.toContain(secret);
    await expect(readFile(join(root, "effect.txt"), "utf8")).resolves.toBe("done");
  });

  it("publishes pending then running then one completed card with relative result", async () => {
    const { runner, store, home, events } = await bootHome();
    runner.sendPrompt({ agentId: "openbot-default", prompt: "escreve" });
    await runner.flush("openbot-default");

    const statuses = events
      .map((event) => event.payload.entry as TranscriptEntry | undefined)
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "tool-call" }> => entry?.kind === "tool-call")
      .map((entry) => entry.status);
    expect(statuses).toEqual(["pending", "running", "completed"]);

    const cards = store.getEntries("openbot-default").filter((entry) => entry.kind === "tool-call");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "w1",
      name: "file",
      summary: "write Documents/nota.md",
      status: "completed",
      result: { ok: true, operation: "file.write", path: "Documents/nota.md" },
    });
    await expect(readFile(join(home.root, "Documents", "nota.md"), "utf8")).resolves.toBe("from-card");
    expect(JSON.stringify(cards[0])).not.toMatch(/[A-Za-z]:\\/);
  });

  it("marks escape as a single failed card and leaves the outside file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-life-fail-"));
    dirs.push(dir);
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "safe");
    const homes = await AgentHomeStore.create(dir);
    const home = await homes.ensure("openbot-default");
    const backend = await HomeWorkspaceBackend.create(home.root);
    const store = createMemoryTranscriptStore();
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(_request, emit) {
        calls += 1;
        if (calls === 1) {
          emit({
            type: "tool-call",
            call: toolWrite("bad", "..\\outside.txt", "pwned"),
          });
        } else emit({ type: "delta", delta: "falhou" });
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: new LocalExecutionBroker(backend, () => "always", () => {}),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });
    runner.sendPrompt({ agentId: "openbot-default", prompt: "foge" });
    await runner.flush("openbot-default");
    const cards = store.getEntries("openbot-default").filter((entry) => entry.kind === "tool-call");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "bad",
      status: "failed",
      result: { ok: false, code: "outside_workspace" },
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("safe");
  });

  it("upserts a duplicate tool-call emit into a single card", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-life-dup-"));
    dirs.push(dir);
    const homes = await AgentHomeStore.create(dir);
    const home = await homes.ensure("openbot-default");
    const store = createMemoryTranscriptStore();
    let turns = 0;
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(_request, emit) {
        turns += 1;
        if (turns === 1) {
          const call = toolWrite("dup", "Documents/dup.md", "x");
          emit({ type: "tool-call", call });
          emit({ type: "tool-call", call });
          return;
        }
        emit({ type: "delta", delta: "ok" });
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: new LocalExecutionBroker(await HomeWorkspaceBackend.create(home.root), () => "always", () => {}),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });
    runner.sendPrompt({ agentId: "openbot-default", prompt: "dup" });
    await runner.flush("openbot-default");
    const cards = store.getEntries("openbot-default").filter((entry) => entry.kind === "tool-call");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: "dup", status: "completed" });
  });

  it("preserves a prior card when the provider reuses an id in a later turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-life-reused-id-"));
    dirs.push(dir);
    const homes = await AgentHomeStore.create(dir);
    const home = await homes.ensure("openbot-default");
    const store = createMemoryTranscriptStore();
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(_request, emit) {
        calls += 1;
        if (calls % 2 === 1) {
          emit({ type: "tool-call", call: toolWrite("reused", `Documents/turn-${calls}.md`, String(calls)) });
        } else {
          emit({ type: "delta", delta: `turn-${calls / 2} done` });
        }
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: new LocalExecutionBroker(await HomeWorkspaceBackend.create(home.root), () => "always", () => {}),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "openbot-default", prompt: "primeiro" });
    await runner.flush("openbot-default");
    runner.sendPrompt({ agentId: "openbot-default", prompt: "segundo" });
    await runner.flush("openbot-default");

    const cards = store.getEntries("openbot-default").filter((entry) => entry.kind === "tool-call");
    expect(cards).toHaveLength(2);
    expect(cards.map((entry) => entry.id)).toEqual(["reused", "reused"]);
    expect(cards.map((entry) => entry.summary)).toEqual(["write Documents/turn-1.md", "write Documents/turn-3.md"]);
    expect(cards.every((entry) => entry.status === "completed")).toBe(true);
  });

  it("usa identidade de aprovação diferente quando o provider reutiliza o id em outro turno", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-life-approval-id-"));
    dirs.push(dir);
    const homes = await AgentHomeStore.create(dir);
    const home = await homes.ensure("openbot-default");
    const approvals: string[] = [];
    let broker!: LocalExecutionBroker;
    broker = new LocalExecutionBroker(
      await HomeWorkspaceBackend.create(home.root),
      () => "ask",
      (approval) => {
        approvals.push(approval.requestId);
        broker.resolve(approval.requestId, "allow", approval.agentId);
      },
    );
    const store = createMemoryTranscriptStore();
    let calls = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(_request, emit) {
        calls += 1;
        if (calls % 2 === 1) emit({ type: "tool-call", call: toolWrite("reused", `Documents/approval-${calls}.md`, "ok") });
        else emit({ type: "delta", delta: "done" });
      },
    });
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: broker,
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "openbot-default", prompt: "primeiro" });
    await runner.flush("openbot-default");
    runner.sendPrompt({ agentId: "openbot-default", prompt: "segundo" });
    await runner.flush("openbot-default");

    expect(approvals).toHaveLength(2);
    expect(approvals[0]).not.toBe(approvals[1]);
    expect(approvals.every((id) => id.endsWith("\0reused"))).toBe(true);
    expect(store.getEntries("openbot-default").filter((entry) => entry.kind === "tool-call" && entry.status === "completed")).toHaveLength(2);
  });

  it("persiste completed quando cancelamento ocorre depois do commit da ação", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-life-post-commit-abort-"));
    dirs.push(dir);
    const homes = await AgentHomeStore.create(dir);
    const home = await homes.ensure("openbot-default");
    const actual = await HomeWorkspaceBackend.create(home.root);
    const controller = new AbortController();
    const backend: ExecutionBackend = {
      async execute(request, signal) {
        const result = await actual.execute(request, signal);
        controller.abort();
        return result;
      },
    };
    const statuses: string[] = [];
    let streams = 0;

    const result = await runToolLoop({
      agentId: "openbot-default",
      turnId: "turn-commit",
      broker: new LocalExecutionBroker(backend, () => "always"),
      request: { model: "fake", messages: [], signal: controller.signal },
      onEvent: () => undefined,
      onProgress: ({ entry }) => statuses.push(entry.status),
      async stream() {
        streams += 1;
        return {
          aborted: false,
          message: { role: "assistant", content: "", toolCalls: [toolWrite("write-1", "Documents/committed.md", "committed")] },
        };
      },
    });

    expect(result.aborted).toBe(true);
    expect(streams).toBe(1);
    expect(statuses).toEqual(["running", "completed"]);
    await expect(readFile(join(home.root, "Documents", "committed.md"), "utf8")).resolves.toBe("committed");
  });

  it("fails open cards when the provider stream dies after pending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-life-abort-"));
    dirs.push(dir);
    const homes = await AgentHomeStore.create(dir);
    const home = await homes.ensure("openbot-default");
    const store = createMemoryTranscriptStore();
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(_request, emit) {
        emit({ type: "tool-call", call: toolWrite("die", "Documents/x.md", "x") });
        throw new Error("stream died");
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: new LocalExecutionBroker(await HomeWorkspaceBackend.create(home.root), () => "always", () => {}),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });
    runner.sendPrompt({ agentId: "openbot-default", prompt: "morre" });
    await runner.flush("openbot-default");
    const cards = store.getEntries("openbot-default").filter((entry) => entry.kind === "tool-call");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: "die", status: "failed", result: { ok: false } });
  });
});
