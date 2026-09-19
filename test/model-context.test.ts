import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNKNOWN_MODEL_CAPABILITIES,
  computeModelContextBudget,
  createContextTokenizer,
  countProviderMessageTokens,
  createFakeTokenizer,
  fitProviderMessagesToByteBudget,
  canonicalProviderRequestBytes,
  prepareProviderRound,
  providerRequestBodyBytes,
  selectCompleteMessageGroups,
  truncateProviderText,
  resolveModelCapabilities,
  validateModelCatalogEntry,
} from "../src/memory/model-context.js";
import { OpenAiAdapter } from "../src/providers/openai.js";

describe("model-aware context", () => {
  it("includes tool arguments in preparation estimates without counting them twice", () => {
    const tokenizer = createContextTokenizer();
    const prepared = prepareProviderRound({ model: "test", messages: [
      { role: "user", content: "read" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "file", arguments: JSON.stringify({ path: "x".repeat(12_000) }) } }] },
      { role: "tool", toolCallId: "c1", content: "ok" },
    ] }, { capabilities: DEFAULT_UNKNOWN_MODEL_CAPABILITIES, maxBytes: 100_000 });
    expect(prepared.telemetry.droppedTurns).toBe(0);
    expect(prepared.telemetry.estimatedInputTokens).toBe(countProviderMessageTokens(prepared.request.messages, tokenizer) + prepared.budget.used.system + prepared.budget.used.tools);
    expect(prepared.telemetry.estimatedInputTokens).toBeGreaterThan(4_000);
    expect(prepared.request.requestId).toBe(prepared.telemetry.requestId);
  });
  it("uses different finite input budgets for models with different windows", () => {
    const tokenizer = createFakeTokenizer({ tokensPerCharacter: 1 });
    const small = computeModelContextBudget({
      capabilities: { contextWindow: 1_000, maxOutputTokens: 200, tokenizerStrategy: "fake", safetyMargin: 0.1 },
      tokenizer,
      system: "s".repeat(100),
      tools: "t".repeat(100),
      transcript: "x".repeat(100),
      memory: "m".repeat(100),
      attachments: "a".repeat(100),
    });
    const large = computeModelContextBudget({
      capabilities: { contextWindow: 2_000, maxOutputTokens: 400, tokenizerStrategy: "fake", safetyMargin: 0.1 },
      tokenizer,
      system: "s".repeat(100),
      tools: "t".repeat(100),
      transcript: "x".repeat(100),
      memory: "m".repeat(100),
      attachments: "a".repeat(100),
    });
    expect(large.inputBudgetTokens).toBeGreaterThan(small.inputBudgetTokens);
    expect(small.inputBudgetTokens + small.outputReserveTokens).toBeLessThanOrEqual(900);
  });

  it("uses a conservative finite fallback for unknown OpenAI-compatible models", () => {
    const resolved = resolveModelCapabilities("vendor-model-that-is-not-catalogued", "openai-compat");
    expect(resolved).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 16_384, maxRequestBytes: 1_048_576 });
    expect(resolved.tokenizerStrategy).toBe("estimated");
    expect(resolveModelCapabilities("unknown", "xai")).toEqual(DEFAULT_UNKNOWN_MODEL_CAPABILITIES);
  });

  it("uses token units for estimates and fails explicitly without a provider tokenizer", () => {
    const tokenizer = createContextTokenizer("estimated");
    expect(tokenizer.strategy).toBe("estimated");
    expect(tokenizer.count("const json = { ação: true };" )).toBeLessThan(Buffer.byteLength("const json = { ação: true };", "utf8"));
    expect(tokenizer.count("ação 😀 漢字")).toBeGreaterThan(0);
    expect(() => createContextTokenizer("provider")).toThrow(/not configured/i);
    expect(() => createFakeTokenizer({ tokensPerCharacter: Number.MAX_VALUE })).toThrow();
    expect(() => createFakeTokenizer({ tokensPerCharacter: Infinity })).toThrow();
  });

  it("rejects non-finite or inconsistent catalog capabilities", () => {
    expect(() => validateModelCatalogEntry({
      id: "bad",
      provider: "openai",
      displayName: "bad",
      contextWindow: Infinity,
      maxOutputTokens: 101,
      tokenizerStrategy: "estimated",
      safetyMargin: 0.1,
    })).toThrow();
    expect(() => validateModelCatalogEntry({
      id: "bad",
      provider: "openai",
      displayName: "bad",
      contextWindow: 100,
      maxOutputTokens: 101,
      tokenizerStrategy: "estimated",
      safetyMargin: 0.1,
    })).toThrow();
  });

  it("caps output by the safe window and reports fixed/content overflow", () => {
    const tokenizer = createFakeTokenizer({ tokensPerCharacter: 1 });
    const outputCapped = computeModelContextBudget({
      capabilities: { contextWindow: 100, maxOutputTokens: 500, tokenizerStrategy: "fake", safetyMargin: 0.2 },
      tokenizer,
      requestedOutputTokens: 500,
    });
    expect(outputCapped.outputReserveTokens).toBe(80);

    const fixedOverflow = computeModelContextBudget({
      capabilities: { contextWindow: 100, maxOutputTokens: 500, tokenizerStrategy: "fake", safetyMargin: 0.2 },
      tokenizer,
      system: 90,
      tools: 20,
      requestedOutputTokens: 500,
    });
    expect(fixedOverflow.outputReserveTokens).toBe(0);
    expect(fixedOverflow.used.system + fixedOverflow.used.tools).toBeGreaterThan(fixedOverflow.inputBudgetTokens);
    expect(fixedOverflow.truncated).toBe(true);

    const contentOverflow = computeModelContextBudget({
      capabilities: { contextWindow: 100, maxOutputTokens: 20, tokenizerStrategy: "fake", safetyMargin: 0.2 },
      tokenizer,
      system: 10,
      transcript: 51,
      requestedOutputTokens: 20,
    });
    expect(contentOverflow.used.system).toBeLessThanOrEqual(contentOverflow.inputBudgetTokens);
    expect(contentOverflow.used.transcript).toBeGreaterThan(contentOverflow.availableContentTokens);
    expect(contentOverflow.truncated).toBe(true);
  });

  it("keeps a marked continuous suffix and never leaves a tool result orphaned", () => {
    const tokenizer = createFakeTokenizer({ tokensPerCharacter: 1 });
    const selected = selectCompleteMessageGroups([
      { role: "user", content: "old" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", toolCallId: "call-1", content: "old result ".repeat(20) },
      { role: "user", content: "new" },
    ], tokenizer, 80);
    expect(selected).toEqual([
      { role: "system", content: "[OpenBot omitiu turnos anteriores por limite de contexto]" },
      { role: "user", content: "new" },
    ]);
    expect(selected.some((message) => message.role === "tool")).toBe(false);

    const discontinuous = [
      { role: "user" as const, content: "OLD" },
      { role: "user" as const, content: "x".repeat(300) },
      { role: "user" as const, content: "NEWEST" },
    ];
    const byTokens = selectCompleteMessageGroups(discontinuous, tokenizer, 80);
    const byBytes = fitProviderMessagesToByteBudget(discontinuous, 160);
    for (const fitted of [byTokens, byBytes]) {
      expect(fitted.map((message) => message.content)).toEqual([
        "[OpenBot omitiu turnos anteriores por limite de contexto]",
        "NEWEST",
      ]);
    }

    const incompleteToolGroup = [
      { role: "user" as const, content: "OLD" },
      { role: "user" as const, content: "tool prompt" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "missing-result", type: "function" as const, function: { name: "read", arguments: "{}" } }] },
      { role: "user" as const, content: "NEWEST" },
    ];
    for (const fitted of [
      selectCompleteMessageGroups(incompleteToolGroup, tokenizer, 500),
      fitProviderMessagesToByteBudget(incompleteToolGroup, 2_000),
    ]) {
      expect(fitted.map((message) => message.content)).toEqual([
        "[OpenBot omitiu turnos anteriores por limite de contexto]",
        "NEWEST",
      ]);
    }
  });

  it("closes truncated attachment and tool-history blocks with explicit markers", () => {
    const tokenizer = createFakeTokenizer({ tokensPerCharacter: 1 });
    const attachment = truncateProviderText("[[OPENBOT_UNTRUSTED_ATTACHMENT_BEGIN]]\n" + "x".repeat(100), 100, tokenizer);
    const tool = truncateProviderText("[[OPENBOT_UNTRUSTED_TOOL_HISTORY_BEGIN]]\n" + "x".repeat(100), 100, tokenizer);
    expect(attachment).toContain("[[OPENBOT_UNTRUSTED_ATTACHMENT_END]]");
    expect(tool).toContain("[[OPENBOT_UNTRUSTED_TOOL_HISTORY_END]]");
  });

  it("enforces the final byte cap for multimodal base64 payloads", () => {
    const fitted = fitProviderMessagesToByteBudget([{
      role: "user",
      content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(400_000)}` } }],
    }], 1_024);
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(1_024);
    expect(JSON.stringify(fitted)).not.toContain("A".repeat(10_000));
  });

  it("keeps prompt and tool pair while replacing a post-tool oversized image", () => {
    const call = { id: "call-1", type: "function" as const, function: { name: "lookup", arguments: "{}" } };
    const fitted = fitProviderMessagesToByteBudget([
      { role: "user", content: "prompt" },
      { role: "assistant", content: "", toolCalls: [call] },
      { role: "tool", toolCallId: "call-1", content: "tool result" },
      {
        role: "user",
        content: [
          { type: "text" as const, text: "follow-up" },
          { type: "image_url" as const, image_url: { url: `data:image/png;base64,${"A".repeat(400_000)}` } },
        ],
      },
    ], 1_000);
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(1_000);
    expect(fitted).toHaveLength(4);
    expect(fitted[0]).toMatchObject({ role: "user", content: "prompt" });
    expect(fitted[1]).toMatchObject({ role: "assistant", toolCalls: [call] });
    expect(fitted[2]).toMatchObject({ role: "tool", toolCallId: "call-1", content: "tool result" });
    expect(JSON.stringify(fitted[3])).toContain("[image omitted by context byte budget]");
  });

  it("preserves isolated multimodal text while replacing its oversized image", () => {
    const fitted = fitProviderMessagesToByteBudget([{
      role: "user",
      content: [
        { type: "text" as const, text: "keep this prompt" },
        { type: "image_url" as const, image_url: { url: `data:image/png;base64,${"A".repeat(400_000)}` } },
      ],
    }], 512);
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(512);
    expect(JSON.stringify(fitted)).toContain("keep this prompt");
    expect(JSON.stringify(fitted)).toContain("[image omitted by context byte budget]");
  });

  it("accounts the complete canonical envelope, not only system and tools", () => {
    const request = {
      model: "m",
      system: "sys",
      tools: [{ type: "function" as const, function: { name: "t", parameters: {} } }],
      messages: [{ role: "user" as const, content: "hello" }],
      maxTokens: 4,
      signal: new AbortController().signal,
    };
    const exact = canonicalProviderRequestBytes(request);
    const fixedEnvelope = canonicalProviderRequestBytes({ ...request, messages: [] });
    const exhausted = prepareProviderRound(request, {
      capabilities: { contextWindow: 1_000, maxOutputTokens: 100, tokenizerStrategy: "bytes", safetyMargin: 0 },
      maxBytes: fixedEnvelope - 1,
    });
    expect(exhausted.exhausted).toBe(true);
    const prepared = prepareProviderRound(request, {
      capabilities: { contextWindow: 1_000, maxOutputTokens: 100, tokenizerStrategy: "bytes", safetyMargin: 0 },
      maxBytes: exact - 1,
    });
    expect(prepared.exhausted).toBe(false);
    expect(canonicalProviderRequestBytes(prepared.request)).toBeLessThanOrEqual(exact - 1);
    expect(prepared.request.messages).not.toEqual(request.messages);
    expect(prepareProviderRound(request, {
      capabilities: { contextWindow: 1_000, maxOutputTokens: 100, tokenizerStrategy: "bytes", safetyMargin: 0 },
      maxBytes: exact,
    }).exhausted).toBe(false);
  });

  it("fits against the real adapter body for chat and Responses payloads", () => {
    for (const [provider, model] of [["xai", "grok-4.6"], ["openai", "gpt-5.6-sol"]] as const) {
      const request = {
        model,
        system: "sys",
        messages: [{ role: "user" as const, content: "hello" }],
        maxTokens: 4,
      };
      const bodyBytes = providerRequestBodyBytes(provider, request);
      const prepared = prepareProviderRound(request, {
        capabilities: { contextWindow: 1_000, maxOutputTokens: 100, tokenizerStrategy: "bytes", safetyMargin: 0 },
        maxBytes: bodyBytes,
        provider,
      });
      expect(providerRequestBodyBytes(provider, prepared.request)).toBeLessThanOrEqual(bodyBytes);
      const tooSmall = prepareProviderRound(request, {
        capabilities: { contextWindow: 1_000, maxOutputTokens: 100, tokenizerStrategy: "bytes", safetyMargin: 0 },
        maxBytes: bodyBytes - 1,
        provider,
      });
      expect(tooSmall.exhausted).toBe(false);
      expect(providerRequestBodyBytes(provider, tooSmall.request)).toBeLessThanOrEqual(bodyBytes - 1);
    }
  });

  it("uses the exact Codex adapter serializer at the byte gate", () => {
    const adapter = new OpenAiAdapter({
      protocol: "codex",
      credentialResolver: async () => ({ accessToken: "test", accountId: "account" }),
    });
    const request = {
      model: "gpt-5.6-sol",
      system: "system",
      messages: [{ role: "user" as const, content: "x".repeat(4_096) }],
      maxTokens: 32,
      reasoningEffort: "medium" as const,
    };
    const exactBytes = Buffer.byteLength(adapter.serializeRequest(request), "utf8");
    const prepared = prepareProviderRound(request, {
      capabilities: { contextWindow: 20_000, maxOutputTokens: 1_000, tokenizerStrategy: "bytes", safetyMargin: 0 },
      maxBytes: exactBytes - 1,
      provider: "openai",
      serializeRequest: (candidate) => adapter.serializeRequest(candidate),
    });

    expect(prepared.exhausted).toBe(false);
    expect(Buffer.byteLength(adapter.serializeRequest(prepared.request), "utf8")).toBeLessThanOrEqual(exactBytes - 1);
    expect(prepared.request.messages).not.toEqual(request.messages);
  });

  it("fails closed when the current tool group cannot fit structurally", () => {
    const request = {
      model: "grok-4.6",
      messages: [
        { role: "user" as const, content: "prompt" },
        { role: "assistant" as const, content: "", toolCalls: [{ id: "call-1", type: "function" as const, function: { name: "lookup", arguments: `{"q":"${"x".repeat(200)}"}` } }] },
        { role: "tool" as const, toolCallId: "call-1", content: "result" },
      ],
      maxTokens: 20,
    };
    const exhausted = prepareProviderRound(request, {
      capabilities: { contextWindow: 100, maxOutputTokens: 20, tokenizerStrategy: "bytes", safetyMargin: 0 },
      maxBytes: 10_000,
    });
    expect(exhausted.exhausted).toBe(true);
    expect(exhausted.request.messages).toEqual([]);

    const fitting = prepareProviderRound(request, {
      capabilities: { contextWindow: 1_000, maxOutputTokens: 20, tokenizerStrategy: "bytes", safetyMargin: 0 },
      maxBytes: 10_000,
    });
    expect(fitting.exhausted).toBe(false);
    expect(fitting.request.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("keeps the real chat and Responses bodies under the 256 KiB gate", () => {
    for (const [provider, model] of [["xai", "grok-4.6"], ["openai-compat", "grok-4.6"], ["openai", "gpt-5.6-sol"]] as const) {
      const request = {
        model,
        system: "s".repeat(128),
        messages: [{ role: "user" as const, content: "x".repeat(262_144) }],
        maxTokens: 32,
      };
      const prepared = prepareProviderRound(request, {
        provider,
        capabilities: { contextWindow: 500_000, maxOutputTokens: 1_000, tokenizerStrategy: "bytes", safetyMargin: 0 },
        maxBytes: 262_144,
      });
      expect(prepared.exhausted).toBe(false);
      expect(providerRequestBodyBytes(provider, prepared.request)).toBeLessThanOrEqual(262_144);
    }
  });

  it("rejects unsafe numeric counts and custom tokenizer outputs", () => {
    const capabilities = { contextWindow: 1_000, maxOutputTokens: 100, tokenizerStrategy: "bytes" as const, safetyMargin: 0 };
    expect(() => computeModelContextBudget({ capabilities, system: Number.MAX_VALUE })).toThrow();
    expect(() => computeModelContextBudget({ capabilities, system: 1e20 })).toThrow();
    expect(() => computeModelContextBudget({ capabilities, system: "x", tokenizer: { strategy: "bytes", count: () => Infinity } })).toThrow();
    expect(() => computeModelContextBudget({ capabilities, system: "x", tokenizer: { strategy: "bytes", count: () => 1.5 } })).toThrow();
  });

  it("keeps the newest required user input when its complete group is oversized", () => {
    const tokenizer = createFakeTokenizer({ tokensPerCharacter: 1 });
    const selected = selectCompleteMessageGroups([
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new but very long ".repeat(10) },
      { role: "assistant", content: "new answer" },
    ], tokenizer, 120);
    expect(selected[0]?.role).toBe("system");
    const userMessage = selected.find((message) => message.role === "user");
    expect(userMessage?.content).toContain("context truncated");
    expect(selected.some((message) => message.content === "old")).toBe(false);
  });
});
