import type { ProviderChatRequest } from "./router.js";
import { ApiError, buildChatBody } from "./openai-helpers.js";

function responsesUserContent(content: Extract<ProviderChatRequest["messages"][number], { role: "user" }>): unknown {
  if (typeof content.content === "string") return content.content;
  return content.content.map((part) => part.type === "text"
    ? { type: "input_text", text: part.text }
    : { type: "input_image", image_url: part.image_url.url, detail: part.image_url.detail ?? "auto" });
}

/** Pure serializer shared by the OpenAI Responses adapter and context gate. */
export function buildResponsesBody(req: ProviderChatRequest): Record<string, unknown> {
  const input: unknown[] = [];
  if (req.system) input.push({ role: "developer", content: req.system });
  for (const message of req.messages) {
    switch (message.role) {
      case "system":
        input.push({ role: "developer", content: message.content });
        break;
      case "user":
        input.push({ role: "user", content: responsesUserContent(message) });
        break;
      case "assistant":
        if (message.content) input.push({ role: "assistant", content: message.content });
        for (const call of message.toolCalls ?? []) {
          input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
        break;
      case "tool":
        if (!message.toolCallId) throw new ApiError("openai: tool result sem toolCallId", 400);
        input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
        break;
    }
  }
  return {
    model: req.model,
    input,
    stream: true,
    store: false,
    ...(req.modelResolution?.serviceTier ? { service_tier: req.modelResolution.serviceTier } : {}),
    // Fail-closed: o esforço só entra no corpo quando o catálogo declara o
    // valor como suportado pelo modelo resolvido — nunca por inferência.
    ...(req.reasoningEffort !== undefined
      && req.modelResolution?.supportedReasoningEfforts?.includes(req.reasoningEffort) === true
      ? { reasoning: { effort: req.reasoningEffort } } : {}),
    ...(req.tools?.length ? {
      tools: req.tools.map((tool) => ({
        type: "function",
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        // Keep optional arguments optional; Responses otherwise normalizes schemas to strict mode.
        strict: false,
        parameters: tool.function.parameters ?? {},
      })),
    } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? (() => {
      if (!Number.isSafeInteger(req.maxTokens) || req.maxTokens <= 0) throw new Error("provider: maxTokens inválido");
      return { max_output_tokens: req.maxTokens };
    })() : {}),
  };
}

/** ChatGPT Codex uses top-level instructions instead of developer input items. */
export function buildCodexResponsesBody(req: ProviderChatRequest): Record<string, unknown> {
  const body = buildResponsesBody(req);
  const { max_output_tokens: _unsupportedMaxOutputTokens, ...codexBody } = body;
  const instructions = [
    req.system,
    ...req.messages.filter((message) => message.role === "system").map((message) => message.content),
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n\n");
  return {
    ...codexBody,
    input: (body.input as unknown[]).filter((item) =>
      typeof item !== "object" || item === null || (item as { role?: string }).role !== "developer"),
    instructions: instructions || "You are a helpful assistant.",
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

/**
 * Modelos OpenAI servidos pelo endpoint `/responses` em vez de
 * `/chat/completions`. Fonte única do predicado — `OpenAiAdapter` importa
 * daqui para que o gate de contexto (`providerRequestBody`) e o adapter
 * nunca divirjam.
 */
export function usesResponsesApi(model: string): boolean {
  return model === "gpt-6-astra" || model.startsWith("gpt-5.6-");
}

export function providerRequestBody(
  provider: string | undefined,
  request: ProviderChatRequest,
): Record<string, unknown> {
  return provider === "openai" && usesResponsesApi(request.model)
    ? buildResponsesBody(request)
    : buildChatBody(request) as unknown as Record<string, unknown>;
}

export function providerRequestBodyBytes(provider: string | undefined, request: ProviderChatRequest): number {
  return Buffer.byteLength(JSON.stringify(providerRequestBody(provider, request)), "utf8");
}
