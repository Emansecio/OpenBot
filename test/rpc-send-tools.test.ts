import { describe, expect, it } from "vitest";
import { LocalExecutionBroker } from "../src/execution/broker.js";
import { runToolLoop, MAX_TOOL_CALLS_PER_ROUND, maskStaleToolResults, isReadOnlyToolCall } from "../src/execution/tool-loop.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";
import { createProviderRegistry, type ProviderAdapter, type ProviderChatRequest } from "../src/providers/router.js";
import { createMemoryTranscriptStore, createTurnRunner } from "../src/rpc/send.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";

class Backend implements ExecutionBackend {
  readonly calls: ExecutionRequest[] = [];
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.calls.push(request);
    return { ok: true, operation: "file.list", entries: [{ name: "a.txt", kind: "file" }] };
  }
}
const TEST_TOOL_NAMES = [
  "browser_navigate",
  "browser_scroll",
  "browser_snapshot",
  "file",
  "memory_remember",
  "memory_search",
  "process_run",
  "save_skill",
  "search_files",
  "search_skills",
  "search_text",
  "shell",
  "use_skill",
] as const;
const base: ProviderChatRequest = {
  model: "fake",
  messages: [{ role: "user", content: "liste" }],
  tools: TEST_TOOL_NAMES.map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } })),
};
const tool = (id: string, name = "file", args = '{"op":"list","path":"."}') => ({ id, type: "function" as const, function: { name, arguments: args } });
const broker = (backend: Backend) => new LocalExecutionBroker(backend);



describe("TurnRunner tools integration", () => {
  it("persiste falha de tool seguida de texto como conclusão parcial", async () => {
    let round = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(_request, emit) {
        round += 1;
        if (round === 1) emit({ type: "tool-call", call: tool("failed-tool", "use_skill", '{"id":"missing"}') });
        else emit({ type: "delta", delta: "Não consegui concluir a ferramenta." });
      },
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      tools: [{ type: "function", function: { name: "use_skill", parameters: { type: "object" } } }],
      toolExecutor: async () => ({ handled: true, ok: false, content: "falhou", error: "falhou" }),
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "execute", clientNonce: "nonce:partial-tool" });
    await runner.flush("a");

    expect(runner.promptStatus("a").lastTurn?.outcome).toBe("partial");
    expect(runner.promptOutcome("a", "nonce:partial-tool")).toBe("partial");
    expect(runner.isPromptCompleted("a", "nonce:partial-tool")).toBe(true);
  });

  it("aguarda descoberta assíncrona de tools antes de iniciar o provider", async () => {
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(request, emit) { requests.push(request); emit({ type: "delta", delta: "ok" }); },
    };
    const registry = createProviderRegistry(); registry.register(adapter);
    const runner = createTurnRunner({
      registry,
      tools: async () => [{ type: "function", function: { name: "search_skills", parameters: { type: "object" } } }],
      toolExecutor: async () => ({ handled: false }),
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });
    runner.sendPrompt({ agentId: "a", prompt: "pesquise" });
    await runner.flush("a");
    expect(requests[0]?.tools?.map((entry) => entry.function.name)).toEqual(["search_skills"]);
  });

  it("publica notice não fatal quando MCP fica indisponível no turno", async () => {
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(_request, emit) { emit({ type: "delta", delta: "chat continua" }); },
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      tools: async () => [],
      toolDiscoveryNotice: () => "MCP indisponível neste turno.",
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "continue" });
    await runner.flush("a");

    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "notice",
      level: "info",
      text: "MCP indisponível neste turno.",
    }));
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      content: "chat continua",
    }));
  });

  it("cancelPrompt durante descoberta MCP cria retry oficial sem duplicar o eco", async () => {
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(request, emit) {
        requests.push(request);
        emit({ type: "delta", delta: "recuperado" });
      },
    });
    const store = createMemoryTranscriptStore();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let discoveryAttempts = 0;
    const runner = createTurnRunner({
      registry,
      store,
      tools: async (_agentId, signal) => {
        discoveryAttempts += 1;
        if (discoveryAttempts > 1) return [];
        markStarted();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return [];
      },
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });
    const prompt = { agentId: "a", prompt: "descobrir", clientNonce: "nonce:mcp-abort" };

    runner.sendPrompt(prompt);
    await started;
    expect(runner.cancelPrompt("a")).toMatchObject({ cancelled: true, agentIds: ["a"] });
    await runner.flush("a");

    const entriesAfterAbort = store.getEntries("a");
    expect(entriesAfterAbort).toContainEqual(expect.objectContaining({
      kind: "notice",
      level: "error",
      retryable: true,
      provider: "scripted",
      model: "fake",
      clientNonce: prompt.clientNonce,
    }));
    expect(await runner.sendPrompt(prompt)).toEqual({ accepted: true });
    await runner.flush("a");
    expect(store.getEntries("a").filter((entry) => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
    expect(requests).toHaveLength(0);

    expect(await runner.retryPrompt("a")).toEqual({ accepted: true });
    await runner.flush("a");
    expect(requests).toHaveLength(1);
  });

  it("falha inesperada de tools depois do eco cria retry oficial", async () => {
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(_request, emit) { emit({ type: "delta", delta: "recuperado" }); },
    });
    const store = createMemoryTranscriptStore();
    let attempts = 0;
    const runner = createTurnRunner({
      registry,
      store,
      tools: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("MCP indisponível");
        return [];
      },
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "descobrir", clientNonce: "nonce:mcp-error" });
    await runner.flush("a");
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "notice",
      level: "error",
      retryable: true,
      provider: "scripted",
      model: "fake",
      clientNonce: "nonce:mcp-error",
      text: "Falha ao processar o turno: MCP indisponível",
    }));

    expect(await runner.retryPrompt("a")).toEqual({ accepted: true });
    await runner.flush("a");
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      content: "recuperado",
    }));
  });

  it("injeta contexto explícito resolvido somente no request atual, sem poluir o transcript", async () => {
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(request, emit) { requests.push(request); emit({ type: "delta", delta: "ok" }); },
    };
    const registry = createProviderRegistry(); registry.register(adapter);
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      resolveTurnContext: async (_agentId, args) => args.richText?.includes("skill:tdd") ? "[Skill tdd]\nUse TDD." : "",
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });
    runner.sendPrompt({ agentId: "a", prompt: "faça", richText: '<span data-type="workflowReference" data-id="skill:tdd">TDD</span> faça' });
    await runner.flush("a");

    expect(requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "faça\n\n[Skill tdd]\nUse TDD." });
    const persistedUser = store.getEntries("a").find((entry) => entry.kind === "message" && entry.role === "user");
    expect(persistedUser).toMatchObject({ content: "faça" });
  });

  it("falha uma Skill referenciada que excede o orçamento antes do provider e da mensagem do usuário", async () => {
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(request, emit) {
        requests.push(request);
        emit({ type: "delta", delta: "não deveria executar" });
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      resolveTurnContext: async () => ({
        source: "reference",
        context: "",
        error: "skill context exceeds the injection limit",
      }),
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "use a Skill" });
    await runner.flush("a");

    expect(requests).toHaveLength(0);
    expect(store.getEntries("a").some((entry) => entry.kind === "message" && entry.role === "user")).toBe(false);
    const notice = store.getEntries("a").find((entry): entry is Extract<TranscriptEntry, { kind: "notice" }> => (
      entry.kind === "notice" && entry.level === "error"
    ));
    expect(notice?.text).toContain("skill context exceeds");
  });

  it("não remove um comando /skill inválido mesmo que a resolução retorne contexto", async () => {
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(request, emit) { requests.push(request); emit({ type: "delta", delta: "ok" }); },
    };
    const registry = createProviderRegistry(); registry.register(adapter);
    const originalPrompt = "/skill ../outside pedido";
    const runner = createTurnRunner({
      registry,
      resolveTurnContext: async () => "[resolver diagnostic]",
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: originalPrompt });
    await runner.flush("a");

    expect(requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: `${originalPrompt}\n\n[resolver diagnostic]`,
    });
  });

  it("não normaliza /skill quando o contexto resolvido veio de um workflowReference", async () => {
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(request, emit) { requests.push(request); emit({ type: "delta", delta: "ok" }); },
    };
    const registry = createProviderRegistry(); registry.register(adapter);
    const originalPrompt = "/skill browser pesquise o site";
    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "workflowReference", attrs: { id: "skill:tdd" } }],
    });
    const runner = createTurnRunner({
      registry,
      resolveTurnContext: async (_agentId, args) => args.richText === richText
        ? { source: "reference" as const, context: "[Skill tdd]\nUse TDD." }
        : { source: "other" as const, context: "" },
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: originalPrompt, richText });
    await runner.flush("a");

    expect(requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: `${originalPrompt}\n\n[Skill tdd]\nUse TDD.`,
    });
  });

  it("preserva o comando /skill no transcript, mas envia somente a tarefa normalizada ao provider", async () => {
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(request, emit) { requests.push(request); emit({ type: "delta", delta: "ok" }); },
    };
    const registry = createProviderRegistry(); registry.register(adapter);
    const store = createMemoryTranscriptStore();
    const originalPrompt = "/skill browser pesquise o site";
    const runner = createTurnRunner({
      registry,
      store,
      resolveTurnContext: async (_agentId, args) => args.prompt === originalPrompt
        ? { source: "text-command" as const, context: "[Skill browser]\nUse o navegador.", normalizedPrompt: "pesquise o site" }
        : { source: "other" as const, context: "" },
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: originalPrompt });
    await runner.flush("a");

    expect(requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: "pesquise o site\n\n[Skill browser]\nUse o navegador.",
    });
    const persistedUser = store.getEntries("a").find((entry) => entry.kind === "message" && entry.role === "user");
    expect(persistedUser).toMatchObject({ content: originalPrompt });
  });

  it("executa Skills/MCP pelo runner mesmo sem broker de workspace", async () => {
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(request, emit) {
        requests.push(request);
        if (requests.length === 1) emit({ type: "tool-call", call: tool("skill-runner", "use_skill", '{"id":"tdd"}') });
        else emit({ type: "delta", delta: "usada" });
      },
    };
    const registry = createProviderRegistry(); registry.register(adapter);
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      tools: [{ type: "function", function: { name: "use_skill", parameters: { type: "object" } } }],
      toolExecutor: async () => ({ handled: true, ok: true, content: "skill body" }),
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "use uma skill" });
    await runner.flush("a");

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "skill body" });
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({ kind: "tool-call", name: "use_skill", status: "completed" }));
  });

  it("continua após texto com tool-call e persiste a resposta final", async () => {
    const backend = new Backend();
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat(request, emit) {
        requests.push(request);
        if (requests.length === 1) {
          emit({ type: "delta", delta: "Vou consultar o arquivo." });
          emit({ type: "tool-call", call: tool("runner-call") });
        } else {
          emit({ type: "delta", delta: "feito" });
        }
      },
    };
    const registry = createProviderRegistry();
    registry.register(adapter);
    const store = createMemoryTranscriptStore();
    const events: { channel: string; payload: unknown }[] = [];
    const runner = createTurnRunner({
      registry,
      store,
      publish: (channel, payload) => events.push({ channel, payload }),
      executionBroker: broker(backend),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "liste" });
    await runner.flush("a");

    expect(backend.calls).toEqual([{ operation: "file.list", path: "." }]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(-2)).toMatchObject([
      { role: "assistant", toolCalls: [{ id: "runner-call" }] },
      { role: "tool", toolCallId: "runner-call" },
    ]);
    const messages = store.getEntries("a").filter((entry) => entry.kind === "message" && entry.role === "assistant");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ content: "feito" });
    const tools = store.getEntries("a").filter((entry) => entry.kind === "tool-call");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "runner-call",
      status: "completed",
      summary: "list file",
      result: { ok: true, operation: "file.list", path: "." },
    });
    expect(JSON.stringify(tools[0])).not.toContain('"summary":"list ."');
    expect(JSON.stringify(tools[0])).not.toContain('"op":"list"');

    const snapshots = events
      .filter((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot")
      .map((event) => event.payload as {
        type: "snapshot";
        agentId: string;
        activeAgentId: string;
        entries: TranscriptEntry[];
      });
    const finalized = snapshots.find((snapshot) => snapshot.entries.some((entry) => (
      entry.kind === "tool-call" && entry.status === "completed" && typeof entry.localToolCallId === "string"
    )));
    expect(finalized).toBeDefined();
    expect(finalized?.agentId).toBe("a");
    expect(finalized?.activeAgentId).toBe("a");
    expect(finalized?.activeAgentId).toBe(finalized?.agentId);
  });

  it("mostra o erro do provider sem persistir narração intermediária da ferramenta", async () => {
    let rounds = 0;
    const backend = new Backend();
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(_request, emit) {
        if (++rounds === 1) {
          emit({ type: "delta", delta: "Vou consultar o arquivo." });
          emit({ type: "tool-call", call: tool("before-error") });
        } else {
          throw Object.assign(new Error("provider rejected continuation"), { status: 400 });
        }
      },
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry, store, executionBroker: broker(backend),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });
    runner.sendPrompt({ agentId: "a", prompt: "liste" });
    await runner.flush("a");
    expect(rounds).toBe(2);
    expect(backend.calls).toHaveLength(1);
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "notice", level: "error", providerErrorKind: "validation", status: 400,
      text: "O provedor rejeitou a solicitação ou o modelo selecionado. Revise as configurações.",
    }));
    expect(store.getEntries("a")).not.toContainEqual(expect.objectContaining({
      kind: "message", role: "assistant", content: "Vou consultar o arquivo.",
    }));
  });

  it("reduz contexto e retenta overflow após tool-call sem repetir a execução", async () => {
    const registry = createProviderRegistry();
    const requests: ProviderChatRequest[] = [];
    const adapter: ProviderAdapter = {
      name: "overflow-after-tool",
      async streamChat(request, emit) {
        requests.push(request);
        if (requests.length === 1) {
          emit({ type: "tool-call", call: tool("overflow-call") });
          throw Object.assign(new Error("context length exceeded"), { code: "context_length_exceeded", status: 400 });
        }
        if (requests.length === 2) {
          emit({ type: "tool-call", call: tool("overflow-call") });
          return;
        }
        emit({ type: "delta", delta: "feito" });
      },
    };
    registry.register(adapter);
    const backend = new Backend();
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: broker(backend),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: adapter.name, model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "liste" });
    await runner.flush("a");

    expect(requests).toHaveLength(3);
    expect(backend.calls).toHaveLength(1);
    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      content: "feito",
    }));
    expect(store.getEntries("a")).not.toContainEqual(expect.objectContaining({
      kind: "notice",
      level: "error",
    }));
  });

  it("persiste relatório parcial quando o modelo excede o limite seguro de tools", async () => {
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted",
      async streamChat(_request, emit) {
        for (let index = 0; index <= MAX_TOOL_CALLS_PER_ROUND; index += 1) {
          emit({ type: "tool-call", call: tool(`bulk-${index}`) });
        }
      },
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: broker(new Backend()),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "exceda", clientNonce: "nonce:tool-limit" });
    await runner.flush("a");

    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      content: expect.stringContaining("A resposta é parcial"),
      provider: "scripted",
      model: "fake",
      turnId: expect.any(String),
    }));
    expect(store.getEntries("a")).not.toContainEqual(expect.objectContaining({
      kind: "notice",
      text: "Não foi possível concluir: o modelo excedeu o limite seguro de ferramentas.",
    }));
    expect(store.getEntries("a").filter((entry) => entry.kind === "message" && entry.role === "user")).toHaveLength(1);
    expect(store.getEntries("a").filter((entry) => entry.kind === "message" && entry.role === "assistant" && entry.content.includes("A resposta é parcial"))).toHaveLength(1);
  });

  it("entrega a resposta final sem notice quando o fechamento do loop é possível", async () => {
    const registry = createProviderRegistry();
    registry.register({
      name: "scripted-finalizer",
      async streamChat(request, emit) {
        if (request.tools?.length === 0) {
          emit({ type: "delta", delta: "feito sem novas ferramentas" });
          return;
        }
        emit({
          type: "tool-call",
          call: tool(`loop-${request.messages.length}`, "file", JSON.stringify({ op: "list", path: `round-${request.messages.length}` })),
        });
      },
    });
    const store = createMemoryTranscriptStore();
    const runner = createTurnRunner({
      registry,
      store,
      executionBroker: broker(new Backend()),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted-finalizer", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "conclua" });
    await runner.flush("a");

    expect(store.getEntries("a")).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      content: "feito sem novas ferramentas",
    }));
    expect(store.getEntries("a")).not.toContainEqual(expect.objectContaining({
      kind: "notice",
      text: "Não foi possível concluir: o modelo excedeu o limite seguro de ferramentas.",
    }));
  });

  it("fallback legado sem localToolCallId substitui por id e emite snapshot com identidade", async () => {
    const backend = new Backend();
    const registry = createProviderRegistry();
    const adapter: ProviderAdapter = {
      name: "scripted",
      async streamChat() {
        throw new Error("provider indisponível");
      },
    };
    registry.register(adapter);
    const store = createMemoryTranscriptStore();
    store.append("a", [{
      kind: "tool-call",
      id: "legacy-call",
      name: "file",
      summary: "list .",
      status: "running",
    }]);
    const events: { channel: string; payload: unknown }[] = [];
    const runner = createTurnRunner({
      registry,
      store,
      publish: (channel, payload) => events.push({ channel, payload }),
      executionBroker: broker(backend),
      tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      resolveProvider: () => ({ provider: "scripted", model: "fake" }),
    });

    runner.sendPrompt({ agentId: "a", prompt: "retomar" });
    await runner.flush("a");

    const snapshots = events
      .filter((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot")
      .map((event) => event.payload as {
        type: "snapshot";
        agentId: string;
        activeAgentId: string;
        entries: TranscriptEntry[];
      });
    const fallbackSnapshot = snapshots.find((snapshot) => snapshot.entries.some((entry) => (
      entry.kind === "tool-call" && entry.id === "legacy-call" && entry.status === "failed" && entry.localToolCallId === undefined
    )));
    expect(fallbackSnapshot).toBeDefined();
    const legacyTool = fallbackSnapshot?.entries.find((entry) => entry.kind === "tool-call" && entry.id === "legacy-call");
    expect(legacyTool).toMatchObject({ summary: "list ." });
    expect(fallbackSnapshot?.agentId).toBe("a");
    expect(fallbackSnapshot?.activeAgentId).toBe("a");
    expect(fallbackSnapshot?.activeAgentId).toBe(fallbackSnapshot?.agentId);
  });
});


describe("in-turn tool result masking and read-only parallel", () => {
  it("mantém resultado de ação mutável grande mesmo quando o id se repete em uma leitura", () => {
    const actionOutput = "ACTION_EFFECT_ALREADY_APPLIED\n".repeat(2048);
    const messages = maskStaleToolResults([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [tool("shared-id", "file", '{"op":"write","path":"out.txt","content":"done"}')] },
      { role: "tool", toolCallId: "shared-id", content: actionOutput },
      { role: "assistant", content: "", toolCalls: [tool("shared-id", "search_files", "{}")] },
      { role: "tool", toolCallId: "shared-id", content: "READ_OBSERVATION" },
    ]);
    const action = messages.find((message) => message.role === "tool" && message.toolCallId === "shared-id");
    expect(action?.role === "tool" && action.content).toBe(actionOutput);
  });

  it("masks earlier tool rounds and keeps the latest round intact", () => {
    const largeFirstRound = "FIRST_ROUND_SECRET_OUTPUT".repeat(1024);
    const messages = maskStaleToolResults([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "search_files", arguments: "{}" } }] },
      { role: "tool", toolCallId: "c1", content: largeFirstRound },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", type: "function", function: { name: "search_text", arguments: "{}" } }] },
      { role: "tool", toolCallId: "c2", content: "SECOND_ROUND_FULL_OUTPUT" },
    ]);
    const first = messages.find((message) => message.role === "tool" && message.toolCallId === "c1");
    const second = messages.find((message) => message.role === "tool" && message.toolCallId === "c2");
    expect(first?.role === "tool" && first.content).toContain("openbotOmitted");
    expect(first?.role === "tool" && first.content).toContain('"toolCallId":"c1"');
    expect(first?.role === "tool" && first.content).not.toContain(largeFirstRound);
    expect(second).toEqual(expect.objectContaining({ content: "SECOND_ROUND_FULL_OUTPUT" }));
  });

  it("não repete uma ação cujo resultado antigo foi mantido no contexto", async () => {
    const actionOutput = "ACTION_EFFECT_ALREADY_APPLIED\n".repeat(2048);
    const readOutput = "READ_OBSERVATION\n".repeat(2048);
    const requests: ProviderChatRequest[] = [];
    let streams = 0;
    let actionExecutions = 0;
    let readExecutions = 0;
    const executeTool = Object.assign(
      async ({ call }: { call: { function: { name: string } } }) => {
        if (call.function.name === "save_skill") {
          actionExecutions += 1;
          return { handled: true, ok: true, content: actionOutput, result: { ok: true, operation: "save_skill" } } as const;
        }
        if (call.function.name === "search_text") {
          readExecutions += 1;
          return { handled: true, ok: true, content: readOutput, result: { ok: true, operation: "search.files" } } as const;
        }
        return { handled: false } as const;
      },
      { canHandle: (name: string) => name === "save_skill" || name === "search_text" },
    );
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        streams += 1;
        if (streams === 1) {
          return {
            aborted: false,
            message: {
              role: "assistant",
              content: "",
              toolCalls: [
                tool("action", "save_skill", '{"id":"publish"}'),
                tool("read-before", "search_text", '{"pattern":"before"}'),
              ],
            },
          };
        }
        if (streams === 2) {
          return {
            aborted: false,
            message: {
              role: "assistant",
              content: "",
              toolCalls: [tool("read-after", "search_text", '{"pattern":"after"}')],
            },
          };
        }
        const action = request.messages.find((message) => message.role === "tool" && message.toolCallId === "action");
        if (action?.role === "tool" && action.content.includes('"openbotOmitted":true')) {
          return {
            aborted: false,
            message: { role: "assistant", content: "", toolCalls: [tool("action-retry", "save_skill", '{"id":"publish"}')] },
          };
        }
        return { aborted: false, message: { role: "assistant", content: "done" } };
      },
      onEvent: () => {},
      executeTool,
    });

    expect(result.message?.content).toBe("done");
    expect(actionExecutions).toBe(1);
    expect(readExecutions).toBe(2);
    expect(requests[2]?.messages.find((message) => message.role === "tool" && message.toolCallId === "action")).toEqual(expect.objectContaining({ content: actionOutput }));
  });

  it("keeps small stale tool results verbatim when there is no byte pressure", () => {
    const messages = maskStaleToolResults([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "search_files", arguments: "{}" } }] },
      { role: "tool", toolCallId: "c1", content: "SMALL_FIRST_ROUND_OBSERVATION" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", type: "function", function: { name: "search_text", arguments: "{}" } }] },
      { role: "tool", toolCallId: "c2", content: "SECOND_ROUND_FULL_OUTPUT" },
    ]);
    const first = messages.find((message) => message.role === "tool" && message.toolCallId === "c1");
    expect(first).toEqual(expect.objectContaining({ content: "SMALL_FIRST_ROUND_OBSERVATION" }));
  });

  it("keeps small stale tool results verbatim even under byte pressure", () => {
    const messages = maskStaleToolResults([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", type: "function", function: { name: "search_files", arguments: "{}" } },
        { id: "c1b", type: "function", function: { name: "search_text", arguments: '{"pattern":"large"}' } },
      ] },
      { role: "tool", toolCallId: "c1", content: "SMALL_OBSERVATION_STAYS" },
      { role: "tool", toolCallId: "c1b", content: "LARGE_STALE_OUTPUT".repeat(1200) },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", type: "function", function: { name: "search_text", arguments: "{}" } }] },
      { role: "tool", toolCallId: "c2", content: "SECOND_ROUND_FULL_OUTPUT" },
    ]);
    const small = messages.find((message) => message.role === "tool" && message.toolCallId === "c1");
    const large = messages.find((message) => message.role === "tool" && message.toolCallId === "c1b");
    expect(small).toEqual(expect.objectContaining({ content: "SMALL_OBSERVATION_STAYS" }));
    expect(large?.role === "tool" && large.content).toContain("openbotOmitted");
  });

  it("runs independent read-only tools concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const executeTool = Object.assign(
      async ({ call }: { call: { function: { name: string } } }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { handled: true, ok: true, content: call.function.name } as const;
      },
      { canHandle: (name: string) => name === "search_files" || name === "search_text" },
    );
    let streams = 0;
    await runToolLoop({
      agentId: "a",
      request: base,
      stream: async () => {
        streams += 1;
        return streams === 1
          ? {
            aborted: false,
            message: {
              role: "assistant",
              content: "",
              toolCalls: [tool("a", "search_files", "{}"), tool("b", "search_text", '{"pattern":"x"}')],
            },
          }
          : { aborted: false, message: { role: "assistant", content: "ok" } };
      },
      onEvent: () => {},
      executeTool,
    });
    expect(maxActive).toBe(2);
    expect(isReadOnlyToolCall(tool("x", "file", '{"op":"read","path":"a.txt"}'))).toBe(true);
    expect(isReadOnlyToolCall(tool("x", "file", '{"op":"write","path":"a.txt"}'))).toBe(false);
    expect(isReadOnlyToolCall(tool("x", "process_run", "{}"))).toBe(false);
  });

  it("reexecuta leitura compartilhada após mutação incerta na mesma rodada", async () => {
    const requests: ProviderChatRequest[] = [];
    let streams = 0;
    let readExecutions = 0;
    let state = "before";
    const observed: string[] = [];
    const executeTool = Object.assign(
      async ({ call }: { call: { function: { name: string } } }) => {
        if (call.function.name === "memory_search") {
          readExecutions += 1;
          observed.push(state);
          return { handled: true, ok: true, content: state, result: { ok: true, operation: "memory.search" } } as const;
        }
        if (call.function.name === "memory_remember") {
          state = "after";
          return {
            handled: true,
            ok: false,
            content: "",
            error: "memory write failed after commit",
            result: { ok: false, code: "io_error", message: "memory write failed after commit" },
          } as const;
        }
        return { handled: false } as const;
      },
      { canHandle: (name: string) => name === "memory_search" || name === "memory_remember" },
    );
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(structuredClone(request));
        streams += 1;
        return streams === 1
          ? {
            aborted: false,
            message: {
              role: "assistant",
              content: "",
              toolCalls: [
                tool("read-before", "memory_search", '{"query":"status"}'),
                tool("remember", "memory_remember", '{"canonicalKey":"status"}'),
                tool("read-after", "memory_search", '{"query":"status"}'),
              ],
            },
          }
          : { aborted: false, message: { role: "assistant", content: "done" } };
      },
      onEvent: () => {},
      executeTool,
    });

    expect(result.message?.content).toBe("done");
    expect(readExecutions).toBe(2);
    expect(observed).toEqual(["before", "after"]);
    const toolResults = requests[1]?.messages.filter((message) => message.role === "tool");
    expect(toolResults?.find((message) => message.toolCallId === "read-before")?.content).toBe("before");
    expect(toolResults?.find((message) => message.toolCallId === "read-after")?.content).toBe("after");
  });
});
