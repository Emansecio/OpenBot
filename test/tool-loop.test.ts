import { describe, expect, it, vi } from "vitest";
import { LocalExecutionBroker } from "../src/execution/broker.js";
import { runToolLoop, resolveToolLoopBudget, MAX_TOOL_CALLS_PER_ROUND, MAX_TOOL_RESULT_BYTES_PER_ROUND, MAX_TOOL_ROUNDS, MAX_TOOL_TOTAL_CALLS, MAX_TOOL_TOTAL_ROUNDS, type ToolExecutionResult } from "../src/execution/tool-loop.js";
import { stableToolCallId } from "../src/execution/tool-card.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";
import { createProviderRegistry, ProviderError, type ProviderChatMessage, type ProviderChatRequest, type ProviderStreamEvent, type StreamChatResult } from "../src/providers/router.js";
import { MAX_LIVE_RESPONSE_BYTES } from "../src/rpc/stream-state.js";
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
const broker = (backend: Backend) => new LocalExecutionBroker(backend, () => "always", () => {});


describe("runToolLoop", () => {
  it("logs one preparation and one logical result for a deduplicated tool-enabled turn", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const registry = createProviderRegistry();
    const stream = vi.fn(async (_req: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) => emit({ type: "delta", delta: "done" }));
    registry.register({ name: "xai", streamChat: stream });
    try {
      const runner = createTurnRunner({ registry, tools: [{ type: "function", function: { name: "file" } }],
        toolExecutor: async () => ({ handled: true, ok: true, content: "ok" }) });
      const args = { agentId: "agent-a", prompt: "private prompt", clientNonce: "nonce" };
      runner.sendPrompt(args);
      await runner.flush("agent-a");
      runner.sendPrompt(args);
      await runner.flush("agent-a");
      expect(stream).toHaveBeenCalledTimes(1);
      const lines = log.mock.calls.map(call => String(call[0]));
      expect(lines.filter(line => line.startsWith("[openbot][context]"))).toHaveLength(1);
      expect(lines.filter(line => line.startsWith("[openbot][turn-result]"))).toHaveLength(1);
      const context = JSON.parse(lines.find(line => line.startsWith("[openbot][context]"))!.slice("[openbot][context] ".length));
      expect(context.requestId).toBe(stream.mock.calls[0]![0].requestId);
      expect(context.operationId).toBe(stream.mock.calls[0]![0].operationId);
      expect(lines.join("\n")).not.toContain("private prompt");
    } finally { log.mockRestore(); vi.unstubAllEnvs(); }
  });
  it("adapta o orçamento para modelos com janela grande", () => {
    const budget = resolveToolLoopBudget({ modelResolution: {
      entry: { id: "grok-4.6", provider: "xai", displayName: "Grok", contextWindow: 500_000, maxRequestBytes: 1_048_576 },
    } as never });
    expect(budget).toEqual({
      maxRounds: 32,
      maxCallsPerRound: 64,
      maxResultBytes: MAX_TOOL_RESULT_BYTES_PER_ROUND,
      maxTotalRounds: 128,
      maxTotalCalls: 128,
    });
  });

  it("mantém override de rounds estrito e expõe os tetos agregados", () => {
    const budget = resolveToolLoopBudget({ modelResolution: undefined }, { maxRounds: 3 });
    expect(budget.maxRounds).toBe(3);
    expect(budget.maxTotalRounds).toBe(3);
    expect(budget.maxTotalCalls).toBe(MAX_TOOL_TOTAL_CALLS);
    expect(MAX_TOOL_TOTAL_ROUNDS).toBe(128);
  });

  it("estende a janela soft somente após observar saída bem-sucedida nova", async () => {
    let executions = 0;
    let providerRounds = 0;
    const backend: ExecutionBackend = {
      async execute(request) {
        if (request.operation !== "file.list") throw new Error(`Unexpected fixture operation: ${request.operation}`);
        executions += 1;
        return { ok: true, operation: request.operation, entries: [{ name: `item-${executions}`, kind: "file" }] };
      },
    };
    const result = await runToolLoop({
      agentId: "a",
      request: {
        ...base,
        modelResolution: {
          entry: { id: "wide", provider: "fake", displayName: "wide", contextWindow: 128_000, maxRequestBytes: 1_048_576 },
        } as never,
      },
      broker: new LocalExecutionBroker(backend, () => "always"),
      stream: async (request) => {
        if (request.tools?.length === 0) return { aborted: false, message: { role: "assistant", content: "fechado" } };
        providerRounds += 1;
        return providerRounds <= 25
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool(`progress-${providerRounds}`, "file", JSON.stringify({ op: "list", path: `item-${providerRounds}` }))] } }
          : { aborted: false, message: { role: "assistant", content: "fechado" } };
      },
      onEvent: () => {},
    });
    expect(result.message?.content).toBe("fechado");
    expect(executions).toBe(25);
  });

  it("não renova a janela com resultados read-only vazios", async () => {
    let providerRounds = 0;
    let executions = 0;
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      executeTool: async () => {
        executions += 1;
        return { handled: true, ok: true, content: "" };
      },
      stream: async (request) => {
        if (request.tools?.length === 0) return { aborted: false, message: { role: "assistant", content: "vazio encerrado" } };
        providerRounds += 1;
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool(`empty-${providerRounds}`, "search_text", JSON.stringify({ query: `q-${providerRounds}` }))] } };
      },
      onEvent: () => {},
    });
    expect(result.message?.content).toBe("vazio encerrado");
    expect(executions).toBe(MAX_TOOL_ROUNDS);
  });

  it("também reconhece saída nova de ação bem-sucedida como progresso", async () => {
    let providerRounds = 0;
    let executions = 0;
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      executeTool: async () => {
        executions += 1;
        return { handled: true, ok: true, content: `ação-confirmada-${executions}` };
      },
      stream: async (request) => {
        if (request.tools?.length === 0) return { aborted: false, message: { role: "assistant", content: "ações encerradas" } };
        providerRounds += 1;
        return providerRounds <= MAX_TOOL_ROUNDS + 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool(`action-${providerRounds}`, "use_skill", JSON.stringify({ id: `skill-${providerRounds}` }))] } }
          : { aborted: false, message: { role: "assistant", content: "ações encerradas" } };
      },
      onEvent: () => {},
    });
    expect(result.message?.content).toBe("ações encerradas");
    expect(executions).toBe(MAX_TOOL_ROUNDS + 1);
  });

  it("permite polling read-only quando a observação muda", async () => {
    let providerRounds = 0;
    let executions = 0;
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      executeTool: async () => {
        executions += 1;
        return { handled: true, ok: true, content: executions === 1 ? "status: running" : "status: done" };
      },
      stream: async (request) => {
        if (request.tools?.length === 0) return { aborted: false, message: { role: "assistant", content: "poll concluído" } };
        providerRounds += 1;
        return providerRounds <= 2
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool(`poll-${providerRounds}`, "search_text", '{"query":"job"}')] } }
          : { aborted: false, message: { role: "assistant", content: "poll concluído" } };
      },
      onEvent: () => {},
    });
    expect(result.message?.content).toBe("poll concluído");
    expect(executions).toBe(2);
    expect(providerRounds).toBe(3);
  });

  it("fecha polling read-only após três resultados consecutivos sem mudança", async () => {
    let providerRounds = 0;
    let executions = 0;
    const requests: ProviderChatRequest[] = [];
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      executeTool: async () => {
        executions += 1;
        return { handled: true, ok: true, content: "status: running" };
      },
      stream: async (request) => {
        requests.push(request);
        if (request.tools?.length === 0) return { aborted: false, message: { role: "assistant", content: "poll encerrado" } };
        providerRounds += 1;
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool(`poll-${providerRounds}`, "search_text", '{"query":"job"}')] } };
      },
      onEvent: () => {},
    });
    expect(result.message?.content).toBe("poll encerrado");
    expect(executions).toBe(3);
    expect(requests.at(-1)?.tools).toEqual([]);
  });

  it("fecha um lote paralelo quando o teto agregado não comporta todos os reads", async () => {
    let providerRounds = 0;
    let executions = 0;
    const requests: ProviderChatRequest[] = [];
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      executeTool: async ({ call }) => {
        executions += 1;
        return { handled: true, ok: true, content: `observation-${call.function.arguments}` };
      },
      stream: async (request) => {
        requests.push(request);
        if (request.tools?.length === 0) return { aborted: false, message: { role: "assistant", content: "lote encerrado" } };
        providerRounds += 1;
        if (providerRounds <= MAX_TOOL_TOTAL_CALLS - 3) {
          return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool(`single-${providerRounds}`, "search_text", JSON.stringify({ query: `q-${providerRounds}` }))] } };
        }
        return {
          aborted: false,
          message: {
            role: "assistant",
            content: "",
            toolCalls: [1, 2, 3, 4].map((index) => tool(`batch-${index}`, "search_text", JSON.stringify({ query: `batch-${index}` }))),
          },
        };
      },
      onEvent: () => {},
    });
    expect(result.message?.content).toBe("lote encerrado");
    expect(executions).toBe(MAX_TOOL_TOTAL_CALLS - 3);
    const finalRequest = requests.at(-1);
    expect(finalRequest?.tools).toEqual([]);
    expect(finalRequest?.messages.filter((message) => message.role === "tool").slice(-4)).toHaveLength(4);
  });

  it("publica running antes de aguardar um executor compartilhado conhecido", async () => {
    const states: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const executeTool = Object.assign(
      async () => {
        await blocked;
        return { handled: true, ok: true, content: "ok" } as const;
      },
      { canHandle: (name: string) => name === "use_skill" },
    );
    let streams = 0;
    const pending = runToolLoop({
      agentId: "a",
      request: base,
      stream: async () => ++streams === 1
        ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("skill-progress", "use_skill", '{"id":"tdd"}')] } }
        : { aborted: false, message: { role: "assistant", content: "ok" } },
      onEvent: () => {},
      onProgress: ({ entry }) => states.push(entry.status),
      executeTool,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toEqual(["running"]);
    release();
    await pending;
    expect(states).toEqual(["running", "completed"]);
  });

  it("não inicia novo stream depois de abortar durante uma tool", async () => {
    const controller = new AbortController();
    let streams = 0;
    const executeTool = Object.assign(
      async () => {
        controller.abort();
        return { handled: true, ok: false, content: "", error: "MCP tool execution failed" } as const;
      },
      { canHandle: (name: string) => name === "use_skill" },
    );

    const result = await runToolLoop({
      agentId: "a",
      request: { ...base, signal: controller.signal },
      stream: async () => {
        streams += 1;
        return streams === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("abort-tool", "use_skill", '{"id":"tdd"}')] } }
          : { aborted: false, message: { role: "assistant", content: "UNEXPECTED_PROVIDER_SUCCESS" } };
      },
      onEvent: () => {},
      executeTool,
    });

    expect(result).toMatchObject({ aborted: true, error: { kind: "aborted" } });
    expect(streams).toBe(1);
  });

  it("não inicia uma tool emitida pelo provider depois do aborto", async () => {
    const controller = new AbortController();
    let executions = 0;
    const result = await runToolLoop({
      agentId: "a",
      request: { ...base, signal: controller.signal },
      stream: async () => {
        controller.abort();
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("late-tool", "use_skill", '{"id":"tdd"}')] } };
      },
      onEvent: () => {},
      executeTool: async () => {
        executions += 1;
        return { handled: true, ok: true, content: "unexpected" };
      },
    });

    expect(result).toMatchObject({ aborted: true, error: { kind: "aborted" } });
    expect(executions).toBe(0);
  });

  it("despacha uma tool compartilhada pelo executor adicional sem passar pelo broker local", async () => {
    const backend = new Backend(); const requests: ProviderChatRequest[] = [];
    const stream = async (request: ProviderChatRequest): Promise<StreamChatResult> => {
      requests.push(request);
      return requests.length === 1
        ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("skill-1", "use_skill", '{"id":"tdd"}')] } }
        : { aborted: false, message: { role: "assistant", content: "feito" } };
    };

    const result = await runToolLoop({
      agentId: "a",
      request: { ...base, tools: [{ type: "function", function: { name: "use_skill" } }] },
      broker: broker(backend),
      stream,
      onEvent: () => {},
      executeTool: async ({ call, agentId }) => call.function.name === "use_skill"
        ? { handled: true, ok: true, content: "skill body", result: { ok: true, operation: "skill.use" } }
        : { handled: false },
    });

    expect(result.message?.content).toBe("feito");
    expect(backend.calls).toHaveLength(0);
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "skill body", toolCallId: "skill-1" });
  });

  it("reprepara o budget antes do segundo round depois de anexar tool result", async () => {
    const prepared: ProviderChatRequest[] = [];
    let streams = 0;
    const result = await runToolLoop({
      agentId: "a",
      request: { ...base, messages: [{ role: "user", content: "u" }] },
      stream: async (request) => {
        prepared.push(request);
        streams += 1;
        return streams === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("round-1", "use_skill", '{"id":"x"}')] } }
          : { aborted: false, message: { role: "assistant", content: "done" } };
      },
      prepareRequest: (messages) => ({ ...base, messages: [...messages].slice(-3), maxTokens: 7 }),
      onEvent: () => {},
      executeTool: async () => ({ handled: true, ok: true, content: "result" }),
    });
    expect(result.message?.content).toBe("done");
    expect(prepared[1]?.maxTokens).toBe(7);
    expect(prepared[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "result" });
  });

  it("trunca resultado de tools por rodada em um limite UTF-8 seguro", async () => {
    const requests: ProviderChatRequest[] = [];
    const huge = "😀".repeat(Math.ceil((MAX_TOOL_RESULT_BYTES_PER_ROUND + 1024) / 4));
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("large", "use_skill", '{"id":"large"}')] } }
          : { aborted: false, message: { role: "assistant", content: "done" } };
      },
      onEvent: () => {},
      executeTool: async () => ({ handled: true, ok: true, content: huge }),
    });

    const content = String(requests[1]?.messages.at(-1)?.content ?? "");
    expect(result.message?.content).toBe("done");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES_PER_ROUND);
    expect(content).toContain("[output truncated by OpenBot]");
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
  });

  it("mantém JSON válido quando um resultado estruturado excede o limite", async () => {
    const requests: ProviderChatRequest[] = [];
    const structured = JSON.stringify({ ok: true, content: "x".repeat(MAX_TOOL_RESULT_BYTES_PER_ROUND + 2048), tail: "preserve" });
    await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("large-json", "use_skill", '{"id":"large"}')] } }
          : { aborted: false, message: { role: "assistant", content: "done" } };
      },
      onEvent: () => {},
      executeTool: async () => ({ handled: true, ok: true, content: structured }),
    });

    const content = String(requests[1]?.messages.at(-1)?.content ?? "");
    expect(() => JSON.parse(content)).not.toThrow();
    expect(JSON.parse(content)).toMatchObject({ openbotTruncated: true, originalBytes: Buffer.byteLength(structured) });
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES_PER_ROUND);
  });

  it("limita erro Unicode no wire mesmo quando o executor fornece mensagem maior", async () => {
    const requests: ProviderChatRequest[] = [];
    const hugeError = "😀".repeat(Math.ceil((MAX_TOOL_RESULT_BYTES_PER_ROUND + 1024) / 4));
    await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("failed-error", "use_skill", '{"id":"error"}')] } }
          : { aborted: false, message: { role: "assistant", content: "done" } };
      },
      onEvent: () => {},
      executeTool: async () => ({ handled: true, ok: false, content: "short", error: hugeError }),
    });

    const content = String(requests[1]?.messages.at(-1)?.content ?? "");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES_PER_ROUND);
    expect(content).toContain("[output truncated by OpenBot]");
  });

  it("preserva o fallback de falha vazia quando ainda há orçamento", async () => {
    const requests: ProviderChatRequest[] = [];
    await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("empty-error", "use_skill", '{"id":"empty"}')] } }
          : { aborted: false, message: { role: "assistant", content: "done" } };
      },
      onEvent: () => {},
      executeTool: async () => ({ handled: true, ok: false, content: "", error: "" }),
    });

    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "erro desconhecido na execução" });
  });

  it("mantém o orçamento agregado para exceções e falhas múltiplas", async () => {
    const requests: ProviderChatRequest[] = [];
    const hugeError = "E".repeat(MAX_TOOL_RESULT_BYTES_PER_ROUND + 2048);
    await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? {
            aborted: false,
            message: {
              role: "assistant",
              content: "",
              toolCalls: [tool("failed-exception", "use_skill", '{"id":"exception"}'), tool("failed-second", "use_skill", '{"id":"second"}')],
            },
          }
          : { aborted: false, message: { role: "assistant", content: "done" } };
      },
      onEvent: () => {},
      executeTool: async ({ call }) => {
        if (call.id === "failed-exception") throw new Error(hugeError);
        return { handled: true, ok: false, content: "", error: "" };
      },
    });

    const toolMessages = requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
    const totalBytes = toolMessages.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES_PER_ROUND);
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain("[output truncated by OpenBot]");
    expect(toolMessages[1]?.content).toBe("");
  });

  it("transporta screenshot como imagem multimodal e remove o base64 do JSON textual", async () => {
    const requests: ProviderChatRequest[] = [];
    const imageBackend: ExecutionBackend = {
      async execute(request) {
        if (request.operation !== "browser.snapshot") throw new Error("unexpected request");
        return {
          ok: true,
          operation: "browser.snapshot",
          command: "snapshot",
          tabId: "tab-1",
          snapshot: {
            url: "https://example.com/",
            title: "Example",
            text: "visible text",
            screenshot: { mimeType: "image/png", dataBase64: "aGVsbG8=", width: 10, height: 8 },
            viewport: { width: 10, height: 8, deviceScaleFactor: 1 },
          },
        };
      },
    };
    await runToolLoop({
      agentId: "a",
      request: { ...base, acceptsImages: true },
      broker: new LocalExecutionBroker(imageBackend, () => "always"),
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("visual", "browser_snapshot", "{}")] } }
          : { aborted: false, message: { role: "assistant", content: "done" } };
      },
      onEvent: () => {},
    });

    const next = requests[1]?.messages ?? [];
    const toolMessage = next.find((message) => message.role === "tool");
    expect(toolMessage?.content).not.toContain("aGVsbG8=");
    expect(JSON.parse(String(toolMessage?.content))).toMatchObject({ ok: true, visualAvailable: true });
    expect(next.at(-1)).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "image_url" }] });
  });

  it("observa a página novamente após scroll, inclusive dentro da mesma rodada", async () => {
    const operations: string[] = [];
    const requests: ProviderChatRequest[] = [];
    const backend: ExecutionBackend = {
      async execute(request) {
        operations.push(request.operation);
        if (request.operation === "browser.scroll") {
          return { ok: true, operation: "browser.scroll", command: "scroll", tabId: "tab-1" };
        }
        if (request.operation !== "browser.snapshot") throw new Error("unexpected request");
        return {
          ok: true, operation: "browser.snapshot", command: "snapshot", tabId: "tab-1",
          snapshot: {
            url: "https://example.invalid/", title: "Example", text: `observation-${operations.length}`,
            screenshot: { mimeType: "image/png", dataBase64: "aGVsbG8=", width: 10, height: 8 },
            viewport: { width: 10, height: 8, deviceScaleFactor: 1 },
          },
        };
      },
    };
    const result = await runToolLoop({
      agentId: "a", request: base, broker: new LocalExecutionBroker(backend, () => "always"),
      stream: async (request) => {
        requests.push(structuredClone(request));
        const calls = requests.length === 1 ? [tool("before", "browser_snapshot", "{}")]
          : requests.length === 2 ? [
            tool("scroll", "browser_scroll", '{"deltaX":0,"deltaY":300}'),
            tool("after", "browser_snapshot", "{}"),
            tool("scroll-again", "browser_scroll", '{"deltaX":0,"deltaY":600}'),
            tool("after-again", "browser_snapshot", "{}"),
          ] : [];
        return { aborted: false, message: { role: "assistant", content: calls.length ? "" : "done", toolCalls: calls } };
      },
      onEvent: () => {},
    });
    expect(result).toMatchObject({ message: { content: "done" } });
    expect(operations).toEqual(["browser.snapshot", "browser.scroll", "browser.snapshot", "browser.scroll", "browser.snapshot"]);
    const results = requests[2]!.messages.filter((message) => message.role === "tool");
    expect(results.find((message) => message.toolCallId === "after")?.content).toContain("observation-3");
    expect(results.find((message) => message.toolCallId === "after-again")?.content).toContain("observation-5");
  });

  it("permite executar apenas tools compartilhadas quando não há broker local", async () => {
    let calls = 0;
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      stream: async () => ++calls === 1
        ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("search-1", "search_skills", '{"query":"test"}')] } }
        : { aborted: false, message: { role: "assistant", content: "ok" } },
      onEvent: () => {},
      executeTool: async () => ({ handled: true, ok: true, content: "[]" }),
    });
    expect(result.message?.content).toBe("ok");
    expect(calls).toBe(2);
  });

  it("executa tool e envia assistant.tool_calls + resultado no segundo request", async () => {
    const backend = new Backend(); const requests: ProviderChatRequest[] = [];
    const stream = async (request: ProviderChatRequest): Promise<StreamChatResult> => {
      requests.push(request);
      if (requests.length === 1) return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("call-1")] } };
      return { aborted: false, message: { role: "assistant", content: "feito" } };
    };
    const result = await runToolLoop({ agentId: "a", request: base, broker: broker(backend), stream, onEvent: () => {} });
    expect(result.message?.content).toBe("feito");
    expect(backend.calls).toEqual([{ operation: "file.list", path: "." }]);
    expect(requests[1]?.messages.slice(-2)).toMatchObject([
      { role: "assistant", toolCalls: [{ id: "call-1" }] },
      { role: "tool", toolCallId: "call-1" },
    ]);
  });

  it("executa uma vez chamadas semanticamente iguais com ids diferentes na mesma rodada", async () => {
    const backend = new Backend(); const requests: ProviderChatRequest[] = [];
    const stream = async (request: ProviderChatRequest): Promise<StreamChatResult> => {
      requests.push(request);
      return requests.length === 1
        ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("duplicate-a"), tool("duplicate-b")] } }
        : { aborted: false, message: { role: "assistant", content: "feito" } };
    };

    const result = await runToolLoop({ agentId: "a", request: base, broker: broker(backend), stream, onEvent: () => {} });

    expect(result.message?.content).toBe("feito");
    expect(backend.calls).toHaveLength(1);
    expect(requests[1]?.messages.find((message) => message.role === "assistant")?.toolCalls).toHaveLength(2);
    expect(requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("deduplica variantes sintáticas que normalizam para a mesma ação", async () => {
    const backend = new Backend(); const requests: ProviderChatRequest[] = [];
    const first = tool("normalized-a", "file", '{"op":"write","path":"Documents/x.txt","content":"x"}');
    const second = tool("normalized-b", "file", '{"content":"x","encoding":"utf8","path":"Documents/x.txt","op":"write"}');
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(backend),
      onEvent: () => {},
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [first, second] } }
          : { aborted: false, message: { role: "assistant", content: "normalizado" } };
      },
    });

    expect(result.message?.content).toBe("normalizado");
    expect(backend.calls).toHaveLength(1);
  });

  it("não reexecuta chamada idêntica na rodada consecutiva e permite conclusão", async () => {
    const backend = new Backend(); const requests: ProviderChatRequest[] = [];
    const stream = async (request: ProviderChatRequest): Promise<StreamChatResult> => {
      requests.push(request);
      if (requests.length <= 2) {
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool(`repeat-${requests.length}`, "file", '{"op":"write","path":"repeat.txt","content":"x"}')] } };
      }
      return { aborted: false, message: { role: "assistant", content: "feito sem repetir" } };
    };

    const result = await runToolLoop({ agentId: "a", request: base, broker: broker(backend), stream, onEvent: () => {} });

    expect(result.message?.content).toBe("feito sem repetir");
    expect(backend.calls).toHaveLength(1);
    expect(requests[2]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining("repeated tool call blocked"),
    });
  });

  it("não reexecuta mutação idêntica após uma chamada intermediária", async () => {
    const executed: string[] = [];
    const requests: ProviderChatRequest[] = [];
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        if (requests.length === 1) return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("mutation-a", "save_skill", '{"id":"publish"}')] } };
        if (requests.length === 2) return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("mutation-b", "save_skill", '{"id":"other"}')] } };
        if (requests.length === 3) return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("mutation-a-replay", "save_skill", '{"id":"publish"}')] } };
        return { aborted: false, message: { role: "assistant", content: "feito" } };
      },
      onEvent: () => {},
      executeTool: async ({ call }) => {
        executed.push((JSON.parse(call.function.arguments) as { id: string }).id);
        return { handled: true, ok: true, content: "ok" };
      },
    });

    expect(result.message?.content).toBe("feito");
    expect(executed).toEqual(["publish", "other"]);
    expect(requests[3]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining("repeated tool call blocked"),
    });
  });

  it("transforma resultado inválido do executor compartilhado em falha de tool", async () => {
    const requests: ProviderChatRequest[] = [];
    const entries: TranscriptEntry[] = [];
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
        ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("invalid-extension", "use_skill", '{"id":"tdd"}')] } }
          : { aborted: false, message: { role: "assistant", content: "falha explicada" } };
      },
      onEvent: () => {},
      onProgress: ({ entry }) => entries.push(entry),
      executeTool: async () => undefined as unknown as ToolExecutionResult,
    });

    expect(result.message?.content).toBe("falha explicada");
    expect(result.taskOutcome).toBe("partial");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "invalid-extension",
      content: "shared tool returned an invalid result",
      toolResult: { ok: false, error: "shared tool returned an invalid result", code: "io_error" },
    });
    expect(entries.at(-1)).toMatchObject({
      status: "failed",
      result: { ok: false, code: "io_error", message: "Shared tool returned an invalid result." },
    });
  });

  it("preserva saída parcial e código estruturado em falha de tool", async () => {
    const requests: ProviderChatRequest[] = [];
    await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("partial-failure", "use_skill", '{"id":"write"}')] } }
          : { aborted: false, message: { role: "assistant", content: "falha explicada" } };
      },
      onEvent: () => {},
      executeTool: async () => ({
        handled: true,
        ok: false,
        content: "2 de 3 itens gravados",
        error: "disco cheio",
        result: { ok: false, operation: "skill.write", code: "io_error", message: "disco cheio" },
      }),
    });

    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "disco cheio",
      toolResult: {
        ok: false,
        error: "disco cheio",
        code: "io_error",
        operation: "skill.write",
        partialContent: "2 de 3 itens gravados",
      },
    });
  });

  it("continua para uma resposta final após resultado vazio válido de tool", async () => {
    const requests: ProviderChatRequest[] = [];
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("empty-result", "use_skill", '{"id":"empty"}')] } }
          : { aborted: false, message: { role: "assistant", content: "resultado vazio tratado" } };
      },
      onEvent: () => {},
      executeTool: async () => ({ handled: true, ok: true, content: "" }),
    });

    expect(result.message?.content).toBe("resultado vazio tratado");
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "" });
  });

  it("normaliza tool call sem id para o mesmo stableToolCallId e executa", async () => {
    const backend = new Backend(); const requests: ProviderChatRequest[] = [];
    const call = tool("");
    const expectedId = stableToolCallId(call.id, call.function.name, call.function.arguments);
    const stream = async (request: ProviderChatRequest): Promise<StreamChatResult> => {
      requests.push(request);
      return requests.length === 1
        ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [call] } }
        : { aborted: false, message: { role: "assistant", content: "feito" } };
    };

    const result = await runToolLoop({ agentId: "a", request: base, broker: broker(backend), stream, onEvent: () => {} });

    expect(result.message?.content).toBe("feito");
    expect(backend.calls).toEqual([{ operation: "file.list", path: "." }]);
    expect(requests[1]?.messages.slice(-2)).toMatchObject([
      { role: "assistant", toolCalls: [{ id: expectedId }] },
      { role: "tool", toolCallId: expectedId },
    ]);
  });

  it("atribui identidades locais distintas a ids repetidos na rodada e entre rodadas", async () => {
    const sameRoundBackend = new Backend();
    let sameRoundRequests = 0;
    const sameRound = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(sameRoundBackend),
      stream: async () => {
        sameRoundRequests += 1;
        return sameRoundRequests === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("duplicate"), tool("duplicate")] } }
          : { aborted: false, message: { role: "assistant", content: "feito" } };
      },
      onEvent: () => undefined,
    });
    expect(sameRound.error).toBeUndefined();
    expect(sameRound.message?.content).toBe("feito");
    expect(sameRoundBackend.calls).toHaveLength(1);

    const crossRoundBackend = new Backend();
    const requests: ProviderChatRequest[] = [];
    const crossRound = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(crossRoundBackend),
      stream: async (providerRequest) => {
        requests.push(providerRequest);
        if (requests.length <= 2) {
          return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("reused", "file", '{"op":"list","path":"."}')] } };
        }
        return { aborted: false, message: { role: "assistant", content: "feito" } };
      },
      onEvent: () => undefined,
    });
    expect(crossRound.error).toBeUndefined();
    expect(crossRound.message?.content).toBe("feito");
    expect(crossRoundBackend.calls).toHaveLength(2);
    const ids = requests[2]?.messages
      .filter((message): message is Extract<ProviderChatMessage, { role: "assistant" }> => message.role === "assistant")
      .flatMap(message => message.toolCalls?.map(call => call.id) ?? []);
    expect(new Set(ids).size).toBe(ids?.length);
  });

  it("não executa tool ausente do catálogo anunciado no round", async () => {
    const backend = new Backend();
    const requests: ProviderChatRequest[] = [];
    const result = await runToolLoop({
      agentId: "a",
      request: {
        ...base,
        tools: [{ type: "function", function: { name: "file", parameters: { type: "object" } } }],
      },
      broker: broker(backend),
      stream: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("hidden-browser", "browser_navigate", '{"url":"https://example.com"}')] } }
          : { aborted: false, message: { role: "assistant", content: "bloqueada" } };
      },
      onEvent: () => {},
    });

    expect(result.message?.content).toBe("bloqueada");
    expect(backend.calls).toHaveLength(0);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "hidden-browser",
      content: "tool is unavailable in this turn",
    });
  });

  it("shell é recusado sem executar backend", async () => {
    const backend = new Backend(); const requests: ProviderChatRequest[] = [];
    const stream = async (request: ProviderChatRequest): Promise<StreamChatResult> => {
      requests.push(request);
      return requests.length === 1
        ? { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("shell-1", "shell", '{"cmd":"whoami"}')] } }
        : { aborted: false, message: { role: "assistant", content: "bloqueado" } };
    };
    await runToolLoop({ agentId: "a", request: base, broker: broker(backend), stream, onEvent: () => {} });
    expect(backend.calls).toHaveLength(0);
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "shell-1", content: expect.stringContaining("shell is disabled") });
  });

  it("rejeita excesso de tool calls antes de executar o backend", async () => {
    const backend = new Backend();
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_ROUND + 1 }, (_, index) => tool(`bulk-${index}`));
    const result = await runToolLoop({ agentId: "a", request: base, broker: broker(backend), stream: async () => ({ aborted: false, message: { role: "assistant", content: "", toolCalls: calls } }), onEvent: () => {} });
    expect(result.message?.content).toContain("resposta é parcial");
    expect(result.taskOutcome).toBe("partial");
    expect(result.message?.content).toContain("file");
    expect(backend.calls).toHaveLength(0);
  });

  it("interrompe provider que ignora o aviso de chamada repetida", async () => {
    const backend = new Backend(); let calls = 0;
    const requests: ProviderChatRequest[] = [];
    const stream = async (request: ProviderChatRequest): Promise<StreamChatResult> => {
      requests.push(request);
      if (request.tools?.length === 0) return { aborted: false, message: { role: "assistant", content: "repetição bloqueada; fechamento concluído" } };
      return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool(`call-${++calls}`, "file", '{"op":"write","path":"repeat.txt","content":"x"}')] } };
    };
    const result = await runToolLoop({ agentId: "a", request: base, broker: broker(backend), stream, onEvent: (_event: ProviderStreamEvent) => {} });
    expect(result.message?.content).toBe("repetição bloqueada; fechamento concluído");
    expect(calls).toBe(3);
    expect(backend.calls).toHaveLength(1);
    const finalRequest = requests.at(-1);
    expect(finalRequest?.tools).toEqual([]);
    const finalAssistantCalls = finalRequest?.messages
      .filter((message): message is Extract<ProviderChatMessage, { role: "assistant" }> => message.role === "assistant")
      .flatMap((message) => message.toolCalls ?? []);
    const finalToolIds = new Set(finalRequest?.messages
      .filter((message): message is Extract<ProviderChatMessage, { role: "tool" }> => message.role === "tool")
      .map((message) => message.toolCallId));
    for (const call of finalAssistantCalls ?? []) expect(finalToolIds.has(call.id)).toBe(true);
  });

  it("marca as tool calls do teto de rodadas como failed", async () => {
    const store = createMemoryTranscriptStore();
    const entries: TranscriptEntry[] = [];
    let calls = 0;
    const stream = async (): Promise<StreamChatResult> => {
      calls += 1;
      return {
        aborted: false,
        message: {
          role: "assistant",
          content: "",
          toolCalls: [tool(`call-${calls}`, "file", JSON.stringify({ op: "list", path: `round-${calls}` }))],
        },
      };
    };
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(new Backend()),
      stream,
      onEvent: () => {},
      onProgress: ({ entry }) => {
        entries.push(entry);
      },
    });
    expect(result.message?.content).toContain("resposta é parcial");
    expect(result.message?.content).toContain("file");
    const last = [...entries].reverse().find(
      (entry) => entry.kind === "tool-call" && entry.status === "failed",
    );
    expect(last).toMatchObject({ status: "failed", result: { message: "tool round limit exceeded" } });
  });

  it("fecha com resposta sem tools quando o teto de rodadas é atingido", async () => {
    const requests: ProviderChatRequest[] = [];
    const backend = new Backend();
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(backend),
      stream: async (request) => {
        requests.push(request);
        if (request.tools?.length === 0) {
          return { aborted: false, message: { role: "assistant", content: "feito com o que foi possível" } };
        }
        const round = requests.length;
        return {
          aborted: false,
          message: {
            role: "assistant",
            content: "",
            toolCalls: [tool(`round-${round}`, "file", JSON.stringify({ op: "list", path: `round-${round}` }))],
          },
        };
      },
      onEvent: () => {},
    });

    expect(result).toMatchObject({ message: { content: "feito com o que foi possível" } });
    expect(result.taskOutcome).toBe("partial");
    expect(requests.at(-1)?.tools).toEqual([]);
    expect(backend.calls).toHaveLength(MAX_TOOL_ROUNDS);
  });

  it("fecha com resposta sem tools quando o provider excede calls por rodada", async () => {
    const requests: ProviderChatRequest[] = [];
    const entries: TranscriptEntry[] = [];
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(new Backend()),
      stream: async (request) => {
        requests.push(request);
        if (request.tools?.length === 0) {
          return { aborted: false, message: { role: "assistant", content: "resposta final" } };
        }
        const calls = Array.from({ length: MAX_TOOL_CALLS_PER_ROUND + 1 }, (_, index) => tool(`bulk-${index}`));
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: calls } };
      },
      onEvent: () => {},
      onProgress: ({ entry }) => entries.push(entry),
    });

    expect(result).toMatchObject({ message: { content: "resposta final" } });
    expect(result.taskOutcome).toBe("partial");
    expect(requests.at(-1)?.tools).toEqual([]);
    expect(entries.filter((entry) => entry.kind === "tool-call" && entry.status === "failed")).toHaveLength(MAX_TOOL_CALLS_PER_ROUND + 1);
  });

  it("remove tools antes do preparo do fechamento e preserva pares de ids", async () => {
    const requests: ProviderChatRequest[] = [];
    const overrides: Array<ProviderChatRequest | undefined> = [];
    const backend = new Backend();
    const requestWithTools: ProviderChatRequest = {
      ...base,
      tools: [{ type: "function", function: { name: "file", parameters: {} } }],
    };
    const result = await runToolLoop({
      agentId: "a",
      request: requestWithTools,
      broker: broker(backend),
      toolLoopBudget: { maxRounds: 1 },
      prepareRequest: (messages, override) => {
        overrides.push(override);
        return { ...(override ?? requestWithTools), messages: [...messages] };
      },
      stream: async (request) => {
        requests.push(request);
        return request.tools?.length === 0
          ? { aborted: false, message: { role: "assistant", content: "fechamento preparado" } }
          : { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("bounded-call")] } };
      },
      onEvent: () => {},
    });

    expect(result.message?.content).toBe("fechamento preparado");
    const finalRequest = requests.at(-1);
    expect(finalRequest?.tools).toEqual([]);
    const finalOverride = overrides.find((override) => override !== undefined);
    expect(finalOverride?.tools).toEqual([]);
    expect(finalOverride?.system).toContain("Não chame nenhuma ferramenta");
    const assistantCall = finalRequest?.messages.find((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.id === "bounded-call"));
    expect(assistantCall?.role).toBe("assistant");
    expect(finalRequest?.messages).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "bounded-call" }));
    expect(backend.calls).toHaveLength(1);
  });

  it("emite relatório parcial bounded quando o preparo do fechamento não cabe", async () => {
    let streams = 0;
    const backend = new Backend();
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(backend),
      toolLoopBudget: { maxRounds: 1 },
      prepareRequest: (_messages, override) => {
        if (override?.tools?.length === 0) throw new Error("provider context budget exhausted");
        return { ...(override ?? base), messages: [..._messages] };
      },
      stream: async (request) => {
        streams += 1;
        if (request.tools?.length === 0) throw new Error("rescue must not run after prepare failure");
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("prepare-failure")] } };
      },
      onEvent: () => {},
    });

    expect(result.aborted).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.message?.content).toContain("A resposta é parcial");
    expect(result.message?.content).toContain("file");
    expect(result.message?.content.length).toBeLessThan(1_000);
    expect(streams).toBe(2);
    expect(backend.calls).toHaveLength(1);
  });

  it("emite relatório parcial quando o provider falha no fechamento", async () => {
    const requests: ProviderChatRequest[] = [];
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(new Backend()),
      toolLoopBudget: { maxRounds: 1 },
      stream: async (request) => {
        requests.push(request);
        return request.tools?.length === 0
          ? { aborted: false, error: new ProviderError("rescue failed", { kind: "network" }), message: { role: "assistant", content: "o provider fechou parcialmente" } }
          : { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("error-call")] } };
      },
      onEvent: () => {},
    });

    expect(result).toMatchObject({ aborted: false, message: { content: expect.stringContaining("A resposta é parcial") } });
    expect(result.error).toBeUndefined();
    expect(requests.at(-1)?.tools).toEqual([]);
  });

  it("fecha graciosamente quando o preparo normal falha após uma tool concluída", async () => {
    let prepares = 0;
    const requests: ProviderChatRequest[] = [];
    const backend = new Backend();
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(backend),
      prepareRequest: (messages, override) => {
        if (override?.tools?.length === 0) return { ...(override ?? base), messages: [...messages] };
        prepares += 1;
        if (prepares > 1) throw new Error("provider context budget exhausted");
        return { ...base, messages: [...messages] };
      },
      stream: async (request) => {
        requests.push(request);
        return request.tools?.length === 0
          ? { aborted: false, message: { role: "assistant", content: "fechado após erro de contexto" } }
          : { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("prepare-normal-failure", "file")] } };
      },
      onEvent: () => {},
    });

    expect(result.message?.content).toBe("fechado após erro de contexto");
    expect(backend.calls).toHaveLength(1);
    expect(requests.at(-1)?.tools).toEqual([]);
  });

  it("aborta durante o rescue sem publicar resposta de fechamento", async () => {
    const controller = new AbortController();
    const events: ProviderStreamEvent[] = [];
    let streams = 0;
    const result = await runToolLoop({
      agentId: "a",
      request: { ...base, signal: controller.signal },
      broker: broker(new Backend()),
      toolLoopBudget: { maxRounds: 1 },
      stream: async (request) => {
        streams += 1;
        if (request.tools?.length === 0) {
          controller.abort();
          return { aborted: false, message: { role: "assistant", content: "não deve publicar" } };
        }
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("rescue-abort")] } };
      },
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({ aborted: true, error: { kind: "aborted" } });
    expect(streams).toBe(3);
    expect(events.some((event) => event.type === "message")).toBe(false);
  });

  it("não tenta fechamento quando o turno foi cancelado", async () => {
    const controller = new AbortController();
    let streams = 0;
    const result = await runToolLoop({
      agentId: "a",
      request: { ...base, signal: controller.signal },
      broker: broker(new Backend()),
      toolLoopBudget: { maxRounds: 1 },
      stream: async () => {
        streams += 1;
        controller.abort();
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("cancelled-call")] } };
      },
      onEvent: () => {},
    });

    expect(result).toMatchObject({ aborted: true, error: { kind: "aborted" } });
    expect(streams).toBe(1);
  });

  it("retém narração de uma rodada com tools e libera lifecycle e done na ordem", async () => {
    const events: ProviderStreamEvent[] = [];
    let streams = 0;
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      broker: broker(new Backend()),
      stream: async (_request, emit) => {
        streams += 1;
        if (streams === 1) {
          emit({ type: "delta", delta: "Vou consultar o arquivo." });
          emit({ type: "tool-call", call: tool("buffered-call") });
          emit({ type: "resume-cursor", cursor: "cursor-tool" });
          emit({ type: "done" });
          return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("buffered-call")] } };
        }
        emit({ type: "delta", delta: "Resposta final." });
        emit({ type: "message", message: { role: "assistant", content: "Resposta final." } });
        emit({ type: "done" });
        return { aborted: false, message: { role: "assistant", content: "Resposta final." } };
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.message?.content).toBe("Resposta final.");
    expect(events.map((event) => event.type)).toEqual([
      "tool-call", "resume-cursor", "done", "delta", "message", "done",
    ]);
    expect(events.slice(0, 3).some((event) => event.type === "delta" || event.type === "message")).toBe(false);
  });

  it("libera texto e terminal done somente depois de uma rodada sem tools", async () => {
    const events: ProviderStreamEvent[] = [];
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (_request, emit) => {
        emit({ type: "delta", delta: "Resposta final." });
        emit({ type: "message", message: { role: "assistant", content: "Resposta final." } });
        emit({ type: "done" });
        return { aborted: false, message: { role: "assistant", content: "Resposta final." } };
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.message?.content).toBe("Resposta final.");
    expect(events.map((event) => event.type)).toEqual(["delta", "message", "done"]);
  });

  it("limita o buffer textual e publica erro de resposta sem done falso", async () => {
    const events: ProviderStreamEvent[] = [];
    const oversized = "x".repeat(MAX_LIVE_RESPONSE_BYTES + 1);
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      stream: async (_request, emit) => {
        emit({ type: "delta", delta: oversized });
        emit({ type: "message", message: { role: "assistant", content: oversized } });
        emit({ type: "done" });
        return { aborted: false, message: { role: "assistant", content: oversized } };
      },
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ aborted: false, error: { kind: "aborted", code: "response_limit" } });
    const delta = events.find((event): event is Extract<ProviderStreamEvent, { type: "delta" }> => event.type === "delta");
    expect(delta).toBeDefined();
    expect(Buffer.byteLength(delta?.delta ?? "", "utf8")).toBeLessThanOrEqual(MAX_LIVE_RESPONSE_BYTES);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.some((event) => event.type === "message" || event.type === "done")).toBe(false);
  });

  it("não executa tools se o provider exceder o buffer textual antes do resultado", async () => {
    let executions = 0;
    const events: ProviderStreamEvent[] = [];
    const oversized = "x".repeat(MAX_LIVE_RESPONSE_BYTES + 1);
    const result = await runToolLoop({
      agentId: "a",
      request: base,
      executeTool: async () => {
        executions += 1;
        return { handled: true, ok: true, content: "não deveria executar" };
      },
      stream: async (_request, emit) => {
        try {
          emit({ type: "delta", delta: oversized });
        } catch {
          // A permissive stream mock may swallow observer errors and still
          // return a tool call; runToolLoop must keep the overflow terminal.
        }
        return { aborted: false, message: { role: "assistant", content: "", toolCalls: [tool("after-overflow", "use_skill")] } };
      },
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ aborted: false, error: { kind: "aborted", code: "response_limit" } });
    expect(executions).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "response_limit" }) }));
  });
});
