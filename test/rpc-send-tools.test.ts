import { describe, expect, it, vi } from "vitest";
import { LocalExecutionBroker } from "../src/execution/broker.js";
import { runToolLoop, resolveToolLoopBudget, MAX_TOOL_CALLS_PER_ROUND, MAX_TOOL_RESULT_BYTES_PER_ROUND, MAX_TOOL_ROUNDS, MAX_TOOL_TOTAL_CALLS, MAX_TOOL_TOTAL_ROUNDS, maskStaleToolResults, isReadOnlyToolCall, type ToolExecutionResult } from "../src/execution/tool-loop.js";
import { stableToolCallId } from "../src/execution/tool-card.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";
import { createProviderRegistry, ProviderError, type ProviderAdapter, type ProviderChatMessage, type ProviderChatRequest, type ProviderStreamEvent, type StreamChatResult } from "../src/providers/router.js";
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
const base: ProviderChatRequest = { model: "fake", messages: [{ role: "user", content: "liste" }] };
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
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "invalid-extension",
      content: "shared tool returned an invalid result",
    });
    expect(entries.at(-1)).toMatchObject({
      status: "failed",
      result: { ok: false, code: "io_error", message: "Shared tool returned an invalid result." },
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
    expect(requests.at(-1)?.tools).toEqual([]);
    expect(entries.filter((entry) => entry.kind === "tool-call" && entry.status === "failed")).toHaveLength(MAX_TOOL_CALLS_PER_ROUND + 1);
  });

  it("remove tools antes do preparo do fechamento e preserva pares de ids", async () => {
    const requests: ProviderChatRequest[] = [];
    const overrides: Array<ProviderChatRequest | undefined> = [];
    const backend = new Backend();
    const result = await runToolLoop({
      agentId: "a",
      request: { ...base, tools: [{ type: "function", function: { name: "file", parameters: {} } }] },
      broker: broker(backend),
      toolLoopBudget: { maxRounds: 1 },
      prepareRequest: (messages, override) => {
        overrides.push(override);
        return { ...(override ?? base), messages: [...messages] };
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


describe("TurnRunner tools integration", () => {
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
