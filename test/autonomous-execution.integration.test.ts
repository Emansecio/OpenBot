import { mkdtemp, readFile, rm,mkdir,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalExecutionBroker } from "../src/execution/broker.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";
import { AgentHomeStore } from "../src/execution/home.js";
import { createSharedTools } from "../src/integrations/shared-tools.js";
import { McpManager } from "../src/mcp/manager.js";
import { createProviderRegistry, type ProviderChatRequest, type ProviderToolCall } from "../src/providers/router.js";
import { createMemoryTranscriptStore, createTurnRunner } from "../src/rpc/send.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import { SKILL_TOOLS, createSkillDispatcher } from "../src/skills/dispatcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const providerTool = (name: string, parameters: Record<string, unknown> = { type: "object" }) => ({
  type: "function" as const,
  function: { name, parameters },
});

const call = (id: string, name: string, args: unknown): ProviderToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

class PracticalBackend implements ExecutionBackend {
  readonly calls: ExecutionRequest[] = [];
  private files = new Map<string, string>();

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.calls.push(request);
    if (request.operation === "browser.snapshot") {
      return {
        ok: true,
        operation: "browser.snapshot",
        command: "snapshot",
        tabId: "tab-1",
        url: "https://fixture.openbot.test/",
        title: "Fixture",
        snapshot: {
          url: "https://fixture.openbot.test/",
          title: "Fixture",
          text: "Visual value: VISUAL-42",
          screenshot: { mimeType: "image/png", dataBase64: "aGVsbG8=", width: 1280, height: 720 },
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        },
      };
    }
    if (request.operation === "file.write") {
      this.files.set(request.path, request.content);
      return { ok: true, operation: "file.write", bytes: Buffer.byteLength(request.content) };
    }
    if (request.operation === "file.read") {
      const content = this.files.get(request.path) ?? "";
      return { ok: true, operation: "file.read", content, encoding: "utf8", bytes: Buffer.byteLength(content) };
    }
    return { ok: false, operation: request.operation, code: "invalid_request", message: "unsupported fixture operation" };
  }
}

describe("autonomous practical execution", () => {
  it("completa Skill autônoma → browser → arquivo → resposta final sem persistir o corpo da Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-autonomous-skill-"));
    roots.push(root);
    const skillRoot = join(root, "skills");
    await mkdir(join(skillRoot, "research-web"), { recursive: true });
    await writeFile(
      join(skillRoot, "research-web", "SKILL.md"),
      "---\nname: Web Research\ndescription: Inspect visual pages and save findings\n---\nUse browser snapshots before writing findings.\n",
      "utf8",
    );
    const dispatcher = createSkillDispatcher({
      catalog: new SkillCatalog({ roots: [{ path: skillRoot, source: "test" }] }),
    });
    const backend = new PracticalBackend();
    const broker = new LocalExecutionBroker(backend, () => "always");
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(request, emit) {
        requests.push(request);
        const lastTool = [...request.messages].reverse().find((message) => message.role === "tool");
        switch (requests.length) {
          case 1:
            emit({ type: "tool-call", call: call("skill-search", "search_skills", { query: "research" }) });
            break;
          case 2:
            if (!lastTool?.content.includes("research-web")) throw new Error("Skill search result was not correlated");
            emit({ type: "tool-call", call: call("skill-use", "use_skill", { id: "research-web" }) });
            break;
          case 3:
            if (!lastTool?.content.includes("[[OPENBOT_SKILL_BEGIN:research-web]]")) throw new Error("Skill body was not returned to the same turn");
            emit({ type: "tool-call", call: call("visual-snapshot", "browser_snapshot", {}) });
            break;
          case 4:
            emit({ type: "tool-call", call: call("save-result", "file", { op: "write", path: "Documents/result.txt", content: "VISUAL-42" }) });
            break;
          case 5:
            emit({ type: "tool-call", call: call("read-result", "file", { op: "read", path: "Documents/result.txt", encoding: "utf8" }) });
            break;
          default:
            if (!lastTool?.content.includes("VISUAL-42")) throw new Error("Saved result was not returned");
            emit({ type: "delta", delta: "Concluído: VISUAL-42 foi verificado e salvo." });
        }
      },
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: broker,
      toolExecutor: dispatcher.executor(),
      tools: [
        ...SKILL_TOOLS,
        providerTool("browser_snapshot"),
        providerTool("file"),
      ],
      resolveProvider: () => ({ provider: "scripted", model: "grok-4.6" }),
    });

    runner.sendPrompt({ agentId: "bot", prompt: "Pesquise visualmente e salve o valor encontrado." });
    await runner.flush("bot");

    expect(requests).toHaveLength(6);
    expect(requests[3]?.messages.filter((message) => message.role === "tool").at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining("VISUAL-42"),
    });
    expect(requests[3]?.messages.find((message) => message.role === "user" && Array.isArray(message.content))).toMatchObject({
      role: "user",
      content: [{ type: "text" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
    });
    expect(backend.calls.map((request) => request.operation)).toEqual(["browser.snapshot", "file.write", "file.read"]);
    expect(store.getEntries("bot")).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      content: "Concluído: VISUAL-42 foi verificado e salvo.",
    }));
    expect(JSON.stringify(store.getEntries("bot"))).not.toContain("Use browser snapshots before writing findings");
  });

  it("mantém workspace, contexto e resultados isolados com dois bots concorrentes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-autonomous-multibot-"));
    roots.push(root);
    const homes = await AgentHomeStore.create(join(root, "workspaces"));
    const homeA = await homes.ensure("bot-a");
    const homeB = await homes.ensure("bot-b");
    const broker = new LocalExecutionBroker((agentId) => homes.backendFor(agentId), () => "always");
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(request, emit) {
        requests.push(request);
        const user = request.messages.find((message) => message.role === "user")?.content ?? "";
        const expected = typeof user === "string" && user.includes("ALPHA") ? "ALPHA" : "BETA";
        const toolResults = request.messages.filter((message) => message.role === "tool");
        if (toolResults.length === 0) {
          emit({ type: "tool-call", call: call("same-provider-id", "file", { op: "write", path: "Documents/result.txt", content: expected }) });
        } else if (toolResults.length === 1) {
          emit({ type: "tool-call", call: call("same-read-id", "file", { op: "read", path: "Documents/result.txt", encoding: "utf8" }) });
        } else {
          const readResult = JSON.parse(toolResults.at(-1)!.content) as { content?: string };
          emit({ type: "delta", delta: `final:${readResult.content}` });
        }
      },
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: broker,
      tools: [providerTool("file")],
      resolveProvider: () => ({ provider: "scripted", model: "fixture" }),
    });

    runner.sendPrompt({ agentId: "bot-a", prompt: "grave e confirme ALPHA", clientNonce: "a-1" });
    runner.sendPrompt({ agentId: "bot-b", prompt: "grave e confirme BETA", clientNonce: "b-1" });
    await Promise.all([runner.flush("bot-a"), runner.flush("bot-b")]);

    await expect(readFile(join(homeA.root, "Documents", "result.txt"), "utf8")).resolves.toBe("ALPHA");
    await expect(readFile(join(homeB.root, "Documents", "result.txt"), "utf8")).resolves.toBe("BETA");
    expect(JSON.stringify(store.getEntries("bot-a"))).toContain("final:ALPHA");
    expect(JSON.stringify(store.getEntries("bot-a"))).not.toContain("BETA");
    expect(JSON.stringify(store.getEntries("bot-b"))).toContain("final:BETA");
    expect(JSON.stringify(store.getEntries("bot-b"))).not.toContain("ALPHA");
    expect(requests).toHaveLength(6);
  });

  it("usa um MCP compartilhado sem misturar resultados entre bots", async () => {
    let connectorCalls = 0;
    let listCalls = 0;
    let toolCalls = 0;
    const manager = new McpManager({
      servers: [{ id: "shared", transport: "http", url: "http://127.0.0.1:8787/mcp" }],
      connector: async () => {
        connectorCalls += 1;
        return {
          async listTools() {
            listCalls += 1;
            return { tools: [{ name: "echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }] };
          },
          async callTool(params) {
            toolCalls += 1;
            return { content: [{ type: "text" as const, text: String((params.arguments as { value?: unknown } | undefined)?.value ?? "") }] };
          },
          async close() {},
        };
      },
    });
    try {
      const shared = createSharedTools({
        catalog: new SkillCatalog({ roots: [] }),
        mcpManager: manager,
        resolveAgentSkillPolicy: () => ({ enabled: false }),
        resolveAgentMcpPolicy: () => ({ enabled: true, serverAllowlist: ["shared"] }),
      });
      const requests: ProviderChatRequest[] = [];
      const registry = createProviderRegistry();
      registry.register({
        name: "scripted",
        async streamChat(request, emit) {
          requests.push(request);
          const user = request.messages.find((message) => message.role === "user")?.content ?? "";
          const expected = typeof user === "string" && user.includes("ALPHA") ? "ALPHA-MCP" : "BETA-MCP";
          const result = request.messages.find((message) => message.role === "tool");
          if (result === undefined) {
            emit({ type: "tool-call", call: call("same-mcp-id", "mcp__shared__echo", { value: expected }) });
          } else {
            if (!result.content.includes(expected)) throw new Error("MCP result crossed bot sessions");
            emit({ type: "delta", delta: `mcp-final:${expected}` });
          }
        },
      });
      const store = createMemoryTranscriptStore();
      const runner = createTurnRunner({
        registry,
        store,
        toolExecutor: shared.executor(),
        tools: (agentId, signal) => shared.providerTools(agentId, [], { signal }),
        resolveProvider: () => ({ provider: "scripted", model: "fixture" }),
      });

      runner.sendPrompt({ agentId: "mcp-a", prompt: "consulte ALPHA", clientNonce: "mcp-a-1" });
      runner.sendPrompt({ agentId: "mcp-b", prompt: "consulte BETA", clientNonce: "mcp-b-1" });
      await Promise.all([runner.flush("mcp-a"), runner.flush("mcp-b")]);

      expect(connectorCalls).toBe(1);
      expect(listCalls).toBe(1);
      expect(toolCalls).toBe(2);
      expect(JSON.stringify(store.getEntries("mcp-a"))).toContain("mcp-final:ALPHA-MCP");
      expect(JSON.stringify(store.getEntries("mcp-a"))).not.toContain("BETA-MCP");
      expect(JSON.stringify(store.getEntries("mcp-b"))).toContain("mcp-final:BETA-MCP");
      expect(JSON.stringify(store.getEntries("mcp-b"))).not.toContain("ALPHA-MCP");
      expect(requests).toHaveLength(4);
    } finally {
      await manager.close();
    }
  });

  it("explica ferramenta indisponível sem fingir sucesso", async () => {
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(request, emit) {
        requests.push(request);
        if (requests.length === 1) {
          emit({ type: "tool-call", call: call("missing-runtime", "process_run", {
            executable: "node",
            argv: ["--version"],
            cwd: ".",
            timeoutMs: 1_000,
            networkProfile: "none",
          }) });
          return;
        }
        const toolResult = request.messages.at(-1);
        if (toolResult?.role !== "tool" || !toolResult.content.includes("local execution broker is unavailable")) {
          throw new Error("Unavailable tool result was not returned to the provider");
        }
        emit({ type: "delta", delta: "Não consegui executar: a ferramenta local está indisponível." });
      },
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      toolExecutor: async () => ({ handled: false }),
      tools: [providerTool("process_run")],
      resolveProvider: () => ({ provider: "scripted", model: "fixture" }),
    });

    runner.sendPrompt({ agentId: "bot", prompt: "execute o comando" });
    await runner.flush("bot");

    expect(requests).toHaveLength(2);
    expect(store.getEntries("bot")).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      content: "Não consegui executar: a ferramenta local está indisponível.",
    }));
    expect(store.getEntries("bot")).toContainEqual(expect.objectContaining({ kind: "tool-call", status: "failed" }));
  });

  it("cancela tool cooperativa sem efeito tardio nem novo round do provider", async () => {
    let effectCount = 0;
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => { started = resolve; });
    let releaseEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const backend: ExecutionBackend = {
      async execute(request, signal) {
        started();
        const aborted = new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await Promise.race([effectGate, aborted]);
        if (signal?.aborted) {
          return { ok: false, operation: request.operation, code: "aborted", message: "Execution was aborted." };
        }
        effectCount += 1;
        return { ok: true, operation: "file.write", bytes: 1 };
      },
    };
    let modelCalls = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(_request, emit) {
        modelCalls += 1;
        emit({ type: "tool-call", call: call("slow-write", "file", { op: "write", path: "Documents/late.txt", content: "x" }) });
      },
    });
    const runner = createTurnRunner({
      registry,
      executionBroker: new LocalExecutionBroker(backend, () => "always"),
      tools: [providerTool("file")],
      resolveProvider: () => ({ provider: "scripted", model: "fixture" }),
    });

    runner.sendPrompt({ agentId: "bot", prompt: "execute uma vez" });
    await toolStarted;
    expect(runner.cancelPrompt("bot")).toMatchObject({ cancelled: true, agentIds: ["bot"] });
    await runner.flush("bot");
    releaseEffect();
    await effectGate;

    expect(effectCount).toBe(0);
    expect(modelCalls).toBe(1);
  });
});
