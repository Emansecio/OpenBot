import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();
afterEach(async () => {
  await temp.cleanup();
});

const fileProviderTool = { type: "function" as const, function: { name: "file", parameters: { type: "object" } } };

const toolWrite = (id: string, path: string, content: string) => ({
  id,
  type: "function" as const,
  function: { name: "file", arguments: JSON.stringify({ op: "write", path, content, encoding: "utf8" }) },
});

async function bootHome() {
  const dir = await temp.makeAsync("openbot-life-");
  const homes = await AgentHomeStore.create(dir);
  const home = await homes.ensure("openbot-default");
  const backend = await HomeWorkspaceBackend.create(home.root);
  const broker = new LocalExecutionBroker(backend);
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
    const root = await temp.makeAsync("openbot-life-process-");
    const native = new LocalProcessRunner("openbot-default", root);
    const lease = { agentId: "openbot-default", capability: { networkProfile: "host" } } as RuntimeLease;
    const broker = new LocalExecutionBroker({ execute: (request, signal) => {
      if (request.operation !== "process.run") throw new Error("unexpected operation");
      return native.run(lease, request, signal ?? new AbortController().signal);
    } });
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
    const dir = await temp.makeAsync("openbot-life-fail-");
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
      executionBroker: new LocalExecutionBroker(backend),
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
    const dir = await temp.makeAsync("openbot-life-dup-");
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
      executionBroker: new LocalExecutionBroker(await HomeWorkspaceBackend.create(home.root)),
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
    const dir = await temp.makeAsync("openbot-life-reused-id-");
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
      executionBroker: new LocalExecutionBroker(await HomeWorkspaceBackend.create(home.root)),
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

  it("usa identidade de execução diferente quando o provider reutiliza o id em outro turno", async () => {
    const dir = await temp.makeAsync("openbot-life-execution-id-");
    const homes = await AgentHomeStore.create(dir);
    const home = await homes.ensure("openbot-default");
    const requestIds: string[] = [];
    const broker = new LocalExecutionBroker(await HomeWorkspaceBackend.create(home.root), {
      audit: (entry) => { if (entry.kind === "decision") requestIds.push(entry.requestId); },
    });
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

    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(requestIds.every((id) => id.endsWith("\0reused"))).toBe(true);
    expect(store.getEntries("openbot-default").filter((entry) => entry.kind === "tool-call" && entry.status === "completed")).toHaveLength(2);
  });

  it("persiste completed quando cancelamento ocorre depois do commit da ação", async () => {
    const dir = await temp.makeAsync("openbot-life-post-commit-abort-");
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
      broker: new LocalExecutionBroker(backend),
      request: { model: "fake", messages: [], tools: [fileProviderTool], signal: controller.signal },
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
    const dir = await temp.makeAsync("openbot-life-abort-");
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
      executionBroker: new LocalExecutionBroker(await HomeWorkspaceBackend.create(home.root)),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });
    runner.sendPrompt({ agentId: "openbot-default", prompt: "morre" });
    await runner.flush("openbot-default");
    const cards = store.getEntries("openbot-default").filter((entry) => entry.kind === "tool-call");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: "die", status: "failed", result: { ok: false } });
  });

  it("records sibling outcomes when one parallel read-only call throws", async () => {
    const dir = await temp.makeAsync("openbot-life-parallel-");
    const homes = await AgentHomeStore.create(dir);
    const home = await homes.ensure("openbot-default");
    await writeFile(join(home.root, "Documents", "ok.md"), "content");
    const broker = new LocalExecutionBroker(await HomeWorkspaceBackend.create(home.root));
    const realExecute = broker.execute.bind(broker);
    vi.spyOn(broker, "execute").mockImplementation(async (agentId, requestId, request, signal) => {
      if ((request as { path?: string }).path === "Documents/fail.md") throw new Error("broker blew up");
      return realExecute(agentId, requestId, request, signal);
    });
    const statuses = new Map<string, string>();
    const toolRead = (id: string, path: string) => ({
      id,
      type: "function" as const,
      function: { name: "file", arguments: JSON.stringify({ op: "read", path }) },
    });
    await expect(runToolLoop({
      agentId: "openbot-default",
      turnId: "turn-parallel",
      broker,
      request: { model: "fake", messages: [], tools: [fileProviderTool] },
      onEvent: () => undefined,
      onProgress: ({ entry }) => { if (entry.id !== undefined) statuses.set(entry.id, entry.status); },
      async stream() {
        return {
          aborted: false,
          message: {
            role: "assistant",
            content: "",
            toolCalls: [toolRead("r-ok", "Documents/ok.md"), toolRead("r-boom", "Documents/fail.md")],
          },
        };
      },
    })).rejects.toThrow("broker blew up");
    // The failing call must not discard the sibling's recorded outcome.
    expect(statuses.get("r-ok")).toBe("completed");
  });

  it("re-executes a read after a write instead of reusing the pre-write observation", async () => {
    const dir = await temp.makeAsync("openbot-life-rwr-");
    const homes = await AgentHomeStore.create(dir);
    const home = await homes.ensure("openbot-default");
    await writeFile(join(home.root, "Documents", "estado.md"), "v1");
    const scope = { agentId: "openbot-default", conversationId: "conversation-a", turnId: "turn-rwr" } as const;
    const broker = new LocalExecutionBroker(await HomeWorkspaceBackend.create(home.root));
    const toolRead = (id: string, path: string) => ({
      id,
      type: "function" as const,
      function: { name: "file", arguments: JSON.stringify({ op: "read", path }) },
    });
    let deliveredToolJson = "";
    let round = 0;
    const result = await runToolLoop({
      agentId: scope.agentId,
      turnId: scope.turnId,
      broker,
      request: { model: "fake", messages: [], tools: [fileProviderTool] },
      onEvent: () => undefined,
      async stream(request) {
        round += 1;
        deliveredToolJson = JSON.stringify(request.messages.filter((message) => message.role === "tool"));
        const calls = round === 1 ? [toolRead("r1", "Documents/estado.md")]
          : round === 2 ? [toolWrite("w1", "Documents/estado.md", "v2")]
          : round === 3 ? [toolRead("r2", "Documents/estado.md")]
          : undefined;
        if (calls === undefined) return { aborted: false, message: { role: "assistant", content: "done" } };
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: calls } };
      },
    });
    expect(result.error).toBeUndefined();
    // The second read ran after the write and delivered the new content.
    expect(deliveredToolJson).toContain("v2");
  });
});
