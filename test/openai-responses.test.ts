import { describe, expect, it, vi } from "vitest";

import { OpenAiAdapter } from "../src/providers/openai.js";
import { ModelCatalogService } from "../src/providers/model-catalog.js";
import {
  createProviderRegistry,
  streamChat,
  type ProviderChatRequest,
  type ProviderStreamEvent,
} from "../src/providers/router.js";

const request: ProviderChatRequest = {
  model: "gpt-5.6-sol",
  system: "Você é útil.",
  messages: [{ role: "user", content: "oi" }],
  tools: [{
    type: "function",
    function: {
      name: "weather",
      description: "Consulta o clima",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  }],
  maxTokens: 8,
};

type FetchCall = [input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]];

function sseResponse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function run(
  events: readonly unknown[],
  req: ProviderChatRequest = request,
): Promise<{
  events: ProviderStreamEvent[];
  result: Awaited<ReturnType<typeof streamChat>>;
  calls: FetchCall[];
}> {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
    calls.push(args);
    return sseResponse(events);
  }) as unknown as typeof fetch;
  const registry = createProviderRegistry();
  registry.register(new OpenAiAdapter({ apiKey: "sk-test", fetchImpl }));
  const emitted: ProviderStreamEvent[] = [];
  const result = await streamChat("openai", req, (event) => emitted.push(event), {
    registry,
    maxRetries: 0,
  });
  return { events: emitted, result, calls };
}

describe("OpenAI Responses API — GPT-5.6", () => {
  it.each(["priority", "default", undefined])("reports the applied tier %s without assuming requested Fast was used", async actual => {
    const catalog = new ModelCatalogService({ sources: { openai: {
      connectionKey: async () => "a".repeat(64),
      discover: async () => [{ id: "gpt-6-astra", supportedReasoningEfforts: ["high"], serviceTiers: ["priority"] }],
    } } });
    try {
      await catalog.get("openai");
      const modelResolution = catalog.resolve("openai", "gpt-6-astra", "high", "priority");
      const out = await run([{ type: "response.completed", response: { status: "completed", service_tier: actual } }], { ...request, model: "gpt-6-astra", reasoningEffort: "high", modelResolution });
      expect(JSON.parse(String(out.calls[0]?.[1]?.body))).toMatchObject({ service_tier: "priority", reasoning: { effort: "high" } });
      expect(out.events).toContainEqual({ type: "service-tier", actual: actual ?? "unknown" });
      const adapter = new OpenAiAdapter({ protocol: "codex" });
      expect(JSON.parse(adapter.serializeRequest({ ...request, modelResolution }))).toMatchObject({ service_tier: "priority" });
      expect(JSON.parse(adapter.serializeRequest({ ...request, modelResolution: { ...modelResolution, serviceTier: "default" } }))).toMatchObject({ service_tier: "default" });
      expect(JSON.parse(adapter.serializeRequest(request))).not.toHaveProperty("service_tier");
    } finally { catalog.close(); }
  });
  it("serializes reasoning.effort only when the resolved model declares it", async () => {
    const catalog = new ModelCatalogService({ sources: { openai: {
      connectionKey: async () => "a".repeat(64),
      discover: async () => [{ id: "gpt-6-astra", supportedReasoningEfforts: ["medium", "high"] }],
    } } });
    try {
      await catalog.get("openai");
      const adapter = new OpenAiAdapter({ protocol: "codex" });
      const declared = catalog.resolve("openai", "gpt-6-astra", "high");
      expect(JSON.parse(adapter.serializeRequest({ ...request, model: "gpt-6-astra", reasoningEffort: "high", modelResolution: declared })))
        .toMatchObject({ reasoning: { effort: "high" } });
      // Mesmo esforço, modelo que declara só "medium": fail-closed, omitido.
      const incompatible = { ...declared, supportedReasoningEfforts: ["medium" as const] };
      expect(JSON.parse(adapter.serializeRequest({ ...request, model: "gpt-6-astra", reasoningEffort: "high", modelResolution: incompatible })))
        .not.toHaveProperty("reasoning");
      // Sem resolução de catálogo, o esforço nunca é inferido.
      expect(JSON.parse(adapter.serializeRequest({ ...request, model: "gpt-6-astra", reasoningEffort: "high" })))
        .not.toHaveProperty("reasoning");
    } finally { catalog.close(); }
  });

  it.each(["gpt-5.6-sol", "gpt-6-astra"])("envia payload Responses e acumula deltas de texto para %s", async model => {
    const out = await run([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: "Olá" },
      { type: "response.output_text.delta", output_index: 0, delta: " mundo" },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ], { ...request, model });

    expect(out.result.message?.content).toBe("Olá mundo");
    expect(String(out.calls[0]?.[0])).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(out.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model,
      stream: true,
      store: false,
      max_output_tokens: 8,
      tools: [{ type: "function", name: "weather", description: "Consulta o clima", strict: false }],
    });
    expect((body.tools as Array<{ parameters: unknown }>)[0]?.parameters).toEqual(request.tools?.[0]?.function.parameters);
    expect(body.input).toEqual([
      { role: "developer", content: "Você é útil." },
      { role: "user", content: "oi" },
    ]);
  });

  it("normaliza function calls fragmentadas", async () => {
    const out = await run([
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_weather", name: "weather", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"city\":" },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "\"SP\"}" },
      { type: "response.function_call_arguments.done", output_index: 0, arguments: "{\"city\":\"SP\"}" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_weather", name: "weather", arguments: "{\"city\":\"SP\"}" } },
      { type: "response.completed", response: { status: "completed" } },
    ]);

    expect(out.events).toContainEqual({
      type: "tool-call",
      call: {
        id: "call_weather",
        type: "function",
        function: { name: "weather", arguments: "{\"city\":\"SP\"}" },
      },
    });
    expect(out.result.message?.toolCalls).toHaveLength(1);
  });

  it("propaga falha terminal e rejeita EOF sem response.completed", async () => {
    const failed = await run([
      { type: "response.failed", response: { status: "failed", error: { message: "boom" } } },
    ]);
    expect(failed.result.error).toMatchObject({ kind: "server", status: 502 });
    expect(failed.result.error?.message).toContain("boom");

    const truncated = await run([
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: "parcial" },
    ]);
    expect(truncated.result.error).toMatchObject({ kind: "server", status: 502 });
    expect(truncated.result.error?.message).toContain("response.completed");
  });

  it("cancela stream Responses pendente", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start() {
        // Mantém reader.read pendente até AbortSignal cancelar o request.
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const registry = createProviderRegistry();
    registry.register(new OpenAiAdapter({ apiKey: "sk-test", fetchImpl }));
    const pending = streamChat("openai", { ...request, signal: controller.signal }, undefined, {
      registry,
      maxRetries: 0,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();

    expect(await pending).toMatchObject({
      aborted: true,
      error: { kind: "aborted", retryable: false },
    });
  });
});
