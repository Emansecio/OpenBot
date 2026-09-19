import { createProviderRegistry, streamChat, type ProviderChatRequest, type ProviderStreamEvent } from "../src/providers/router.js";
import { ProviderAdmissionScheduler } from "../src/providers/admission.js";
import { providerRequestBody } from "../src/providers/request-bodies.js";
import { prepareProviderRound, resolveModelCapabilities } from "../src/memory/model-context.js";
import type { ExecutionRequest, ExecutionResult } from "../src/execution/contracts.js";
import type { LocalExecutionBroker } from "../src/execution/broker.js";
import { describe, expect, it, vi } from "vitest";

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number; provider: string; model: string };
type Adapter = {
  name: string;
  streamChat: (request: ProviderChatRequest, emit: (event: ProviderStreamEvent) => void) => Promise<void>;
  close?: () => Promise<void> | void;
};
type OptionalAdaptersModule = {
  OpenRouterAdapter: new (options: Record<string, unknown>) => Adapter;
  createCliProviderAdapter: (options: Record<string, unknown>) => Adapter;
};
type ProcessRequest = Extract<ExecutionRequest, { operation: "process.run" }>;
type Broker = Pick<LocalExecutionBroker, "execute">;

async function loadOptionalAdapters(): Promise<OptionalAdaptersModule | null> {
  const moduleName = "../src/providers/optional-adapters.js";
  try {
    return await import(moduleName);
  } catch {
    return null;
  }
}

function request(model = "fixture-model"): ProviderChatRequest {
  return { model, messages: [{ role: "user", content: "hello" }] };
}

function openRouterResolution(
  model: string,
  options: { contextWindow?: number; maxOutputTokens?: number; capabilities?: Partial<NonNullable<ProviderChatRequest["modelResolution"]>["capabilities"]> } = {},
): NonNullable<ProviderChatRequest["modelResolution"]> {
  return {
    entry: {
      id: model,
      provider: "openai-compat",
      displayName: model,
      contextWindow: options.contextWindow ?? 128_000,
      maxOutputTokens: options.maxOutputTokens ?? 16_384,
      maxRequestBytes: 512 * 1024,
      tokenizerStrategy: "estimated",
      safetyMargin: 0.1,
    },
    capabilities: {
      streaming: true,
      tools: true,
      images: false,
      cancellation: "abort-signal",
      authentication: "keystore-api-key",
      usage: "stream-events",
      resume: "none",
      reasoning: false,
      ...options.capabilities,
    },
    protocol: "chat",
  };
}

function fixturePath(name: "codex-cli-v1.mjs" | "claude-code-v1.mjs"): string {
  return new URL(`./fixtures/${name}`, import.meta.url).pathname;
}

function processResult(stdout: string, stderr = "", exitCode = 0): ExecutionResult {
  return { ok: true, operation: "process.run", stdout, stderr, exitCode, durationMs: 1, stdoutTruncated: false, stderrTruncated: false };
}

function protocolOutput(provider: "codex-cli" | "claude-code", mode = "stream"): string {
  const prefix = provider === "codex-cli" ? "codex-cli" : "claude-code";
  const frames = (types: Array<Record<string, unknown>>): string => types.map((frame, index) => JSON.stringify({ protocol: `${prefix}.v1`, sequence: index + 1, ...frame })).join("\n") + "\n";
  if (mode === "malformed") return "{not-json\n";
  if (mode === "eof") return frames([{ type: "session", sessionId: `${prefix}-session` }, { type: "delta", text: "partial" }]);
  if (mode === "unknown") return frames([{ type: "session", sessionId: `${prefix}-session` }, { type: "future.event", value: "unknown" }]);
  if (mode === "duplicate-terminal") return frames([{ type: "session", sessionId: `${prefix}-session` }, { type: "done", cursor: `${prefix}-cursor` }, { type: "done", cursor: `${prefix}-duplicate` }]);
  if (mode === "oversized") return frames([{ type: "session", sessionId: `${prefix}-session` }, { type: "delta", text: "x".repeat(32_768) }]);
  if (mode === "tools") return frames([{ type: "session", sessionId: `${prefix}-session` }, { type: "tool-call", id: `${prefix}-call-1`, name: "fixture_tool", arguments: "{}" }, { type: "done", cursor: `${prefix}-cursor` }]);
  return frames([
    { type: "session", sessionId: `${prefix}-session` },
    { type: "child-start", pid: 1234 },
    { type: "delta", text: `${prefix}-hello` },
    { type: "usage", inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    { type: "done", cursor: `${prefix}-cursor-v1` },
  ]);
}

const smallCatalog = [{
  id: "openrouter-small",
  provider: "openai-compat" as const,
  displayName: "Offline OpenRouter small fixture",
  contextWindow: 128,
  maxOutputTokens: 16,
  tokenizerStrategy: "estimated" as const,
  safetyMargin: 0.1,
}];

describe("P2.5 RED — OpenRouter and bounded CLI adapters", () => {
  it("uses the shared serializer, model-aware byte gate, attribution headers and observed usage", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const usageCollector = { record: vi.fn<(usage: Usage) => void>() };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}`,
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const resolveCredential = vi.fn(async (ref: string, scope: { agentId: string }) => {
      expect(ref).toBe("openrouter:key:fixture-v1");
      expect(scope.agentId).toBe("agent-a");
      return "fixture-openrouter-key";
    });
    const adapter = new module.OpenRouterAdapter({
      agentId: "agent-a",
      credentialRef: "openrouter:key:fixture-v1",
      resolveCredential,
      modelCatalog: smallCatalog,
      maxRequestBytes: 8_192,
      fetchImpl,
      httpReferer: "https://openbot.example",
      appTitle: "OpenBot Fixture",
      usageCollector,
    });
    const req = request("openrouter-small");
    const prepared = prepareProviderRound(req, {
      capabilities: resolveModelCapabilities(smallCatalog[0] as never),
      maxBytes: 8_192,
      provider: "openrouter",
    });
    const expected = providerRequestBody("openrouter", prepared.request);
    const events: ProviderStreamEvent[] = [];
    await adapter.streamChat(req, (event) => events.push(event));

    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    const headers = new Headers(requests[0]?.init?.headers);
    expect(body.model).toBe(expected.model);
    expect(body.messages).toEqual(expected.messages);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(headers.get("authorization")).toBe("Bearer fixture-openrouter-key");
    expect(headers.get("http-referer")).toBe("https://openbot.example");
    expect(headers.get("x-title")).toBe("OpenBot Fixture");
    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(usageCollector.record).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 3, outputTokens: 1, totalTokens: 4, provider: "openrouter", model: "openrouter-small" }));
    expect(JSON.stringify(events)).not.toContain("fixture-openrouter-key");
  });

  it("fails closed before fetch when the model window is too small or the model is unknown", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const fetchImpl = vi.fn(async () => new Response("should not be called", { status: 200 }));
    const adapter = new module.OpenRouterAdapter({
      agentId: "agent-a",
      credentialRef: "openrouter:key:fixture-v1",
      resolveCredential: async () => "fixture-key",
      modelCatalog: smallCatalog,
      maxRequestBytes: 256,
      fetchImpl,
    });
    await expect(adapter.streamChat({ model: "openrouter-small", messages: [{ role: "user", content: "x".repeat(2_000) }] }, () => undefined))
      .rejects.toMatchObject({ code: "context_budget_exceeded" });
    await expect(adapter.streamChat(request("model-not-in-catalog"), () => undefined))
      .rejects.toMatchObject({ code: "model_capability_unknown" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("trusts an exact OpenRouter request snapshot before any adapter fallback", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = new module.OpenRouterAdapter({
      agentId: "agent-a",
      credentialRef: "openrouter:key:fixture-v1",
      resolveCredential: async () => "fixture-key",
      fetchImpl,
    });
    const content = "x".repeat(100_000);
    const req: ProviderChatRequest = {
      model: "snapshot-large",
      modelResolution: openRouterResolution("snapshot-large"),
      messages: [{ role: "user", content }],
    };

    await expect(adapter.streamChat(req, () => undefined)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { messages?: Array<{ content?: string }> };
    expect(body.messages?.[0]?.content).toBe(content);
  });

  it("uses a declared adapter catalog before the shared unknown-model floor", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const fetchImpl = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = new module.OpenRouterAdapter({
      agentId: "agent-a",
      credentialRef: "openrouter:key:fixture-v1",
      resolveCredential: async () => "fixture-key",
      modelCatalog: [{
        id: "openrouter-small",
        provider: "openai-compat",
        displayName: "Catalog large",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        maxRequestBytes: 512 * 1024,
        tokenizerStrategy: "estimated",
        safetyMargin: 0.1,
      }],
      fetchImpl,
    });
    const content = "x".repeat(100_000);
    await expect(adapter.streamChat({ model: "openrouter-small", messages: [{ role: "user", content }] }, () => undefined)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not trust a mismatched snapshot and keeps unknown OpenRouter models on the shared bounded floor", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const fetchImpl = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = new module.OpenRouterAdapter({
      agentId: "agent-a",
      credentialRef: "openrouter:key:fixture-v1",
      resolveCredential: async () => "fixture-key",
      fetchImpl,
    });
    const content = "x".repeat(100_000);
    const unknown = { model: "unknown-model", messages: [{ role: "user" as const, content }] };
    const mismatched = {
      ...unknown,
      modelResolution: openRouterResolution("different-model"),
    };
    const wrongProviderResolution = openRouterResolution("unknown-model");
    const wrongProvider = {
      ...unknown,
      modelResolution: {
        ...wrongProviderResolution,
        entry: { ...wrongProviderResolution.entry, provider: "xai" },
      } as never,
    };

    await expect(adapter.streamChat(unknown, () => undefined)).rejects.toMatchObject({ code: "context_budget_exceeded" });
    await expect(adapter.streamChat(mismatched, () => undefined)).rejects.toMatchObject({ code: "context_budget_exceeded" });
    await expect(adapter.streamChat(wrongProvider, () => undefined)).rejects.toMatchObject({ code: "context_budget_exceeded" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the matching request capability snapshot for the tools gate", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const fetchImpl = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    const adapter = new module.OpenRouterAdapter({
      agentId: "agent-a",
      credentialRef: "openrouter:key:fixture-v1",
      resolveCredential: async () => "fixture-key",
      fetchImpl,
    });
    await expect(adapter.streamChat({
      model: "snapshot-no-tools",
      modelResolution: openRouterResolution("snapshot-no-tools", { capabilities: { tools: false } }),
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "fixture", parameters: {} } }],
    }, () => undefined)).rejects.toMatchObject({ code: "unsupported_feature" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("measures the fully serialized OpenRouter body before fetch", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const req = request("openrouter-small");
    const prepared = prepareProviderRound(req, {
      capabilities: resolveModelCapabilities(smallCatalog[0] as never),
      maxBytes: 8_192,
      provider: "openrouter",
    });
    const genericBodyBytes = Buffer.byteLength(JSON.stringify(providerRequestBody("openrouter", prepared.request)), "utf8");
    const fetchImpl = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200 }));
    const adapter = new module.OpenRouterAdapter({
      agentId: "agent-a",
      credentialRef: "openrouter:key:fixture-v1",
      resolveCredential: async () => "fixture-key",
      modelCatalog: smallCatalog,
      maxRequestBytes: genericBodyBytes,
      fetchImpl,
    });

    await expect(adapter.streamChat(req, () => undefined)).rejects.toMatchObject({ code: "context_budget_exceeded" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 429, 503])("classifies OpenRouter %s with stable kind/retryability, retryAfter and sanitized error", async (status) => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const secret = "fixture-openrouter-key";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: `provider leaked ${secret}` } }), {
      status,
      headers: { "retry-after": "2" },
    }));
    const adapter = new module.OpenRouterAdapter({
      agentId: "agent-a",
      credentialRef: "openrouter:key:fixture-v1",
      resolveCredential: async () => secret,
      fetchImpl,
    });
    const registry = createProviderRegistry();
    registry.register(adapter);
    const result = await streamChat(adapter.name, request(), undefined, { registry, maxRetries: 2, sleep: vi.fn(async () => undefined) });
    expect(result.error).toMatchObject({
      status,
      kind: status === 401 ? "auth" : status === 429 ? "rate-limit" : "server",
      retryable: status !== 401,
    });
    expect(result.error?.retryAfterMs).toBe(status === 401 ? undefined : 2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(status === 401 ? 1 : 3);
    expect(JSON.stringify(result.error)).not.toContain(secret);
  });

  it.each([429, 503])("reacquires global admission for each retry after OpenRouter %s", async (status) => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? new Response(JSON.stringify({ error: { message: "temporary fixture error" } }), { status, headers: { "retry-after": "0" } })
        : new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const adapter = new module.OpenRouterAdapter({
      agentId: "agent-a",
      credentialRef: "openrouter:key:fixture-v1",
      resolveCredential: async () => "fixture-key",
      fetchImpl,
    });
    const registry = createProviderRegistry();
    registry.register(adapter);
    const admission = new ProviderAdmissionScheduler({ maxActive: 1 });
    const result = await streamChat(adapter.name, request(), undefined, { registry, maxRetries: 1, sleep: vi.fn(async () => undefined), admission, agentId: "agent-a" });
    expect(result.error).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(admission.metrics().admitted).toBe(2);
    expect(admission.metrics().active).toBe(0);
  });

  it("requires an opaque external session and uses LocalExecutionBroker process.run without direct spawn or token fallback", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    vi.stubEnv("CODEX_AUTH_TOKEN", "must-not-be-read");
    try {
      const broker: Broker = {
        execute: vi.fn(async (_agentId, _requestId, processRequest) => {
          expect(processRequest).toMatchObject({ operation: "process.run", executable: "node", cwd: ".", networkProfile: "host" });
          expect(processRequest.argv).not.toContain("opaque-session-ref");
          expect(processRequest.argv).not.toContain("must-not-be-read");
          const envelope = JSON.parse(processRequest.stdin ?? "null") as Record<string, unknown>;
          expect(envelope).toMatchObject({ protocol: "openbot.cli-request.v1", provider: "codex-cli", model: "fixture-model", messages: [{ role: "user", content: "hello" }] });
          expect(processRequest.stdin).not.toContain("opaque-session-ref");
          expect(processRequest.stdin).not.toContain("must-not-be-read");
          return processResult(protocolOutput("codex-cli"));
        }),
      };
      const missingSession = module.createCliProviderAdapter({
        provider: "codex-cli",
        agentId: "agent-a",
        executable: "node",
        args: [fixturePath("codex-cli-v1.mjs"), "--mode", "stream"],
        executionBroker: broker,
        cwd: ".",
      });
      await expect(missingSession.streamChat(request(), () => undefined)).rejects.toMatchObject({ code: "missing_session" });
      expect(broker.execute).not.toHaveBeenCalled();

      const adapter = module.createCliProviderAdapter({
        provider: "codex-cli",
        agentId: "agent-a",
        sessionRef: "opaque-session-ref",
        resolveSession: async (ref: string) => {
          expect(ref).toBe("opaque-session-ref");
          return { protocol: "codex-cli.v1" };
        },
        executable: "node",
        args: [fixturePath("codex-cli-v1.mjs"), "--mode", "stream"],
        executionBroker: broker,
        cwd: ".",
      });
      await adapter.streamChat(request(), () => undefined);
      expect(broker.execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a CLI request envelope that exceeds the bounded stdin limit", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const broker: Broker = { execute: vi.fn(async () => processResult(protocolOutput("codex-cli"))) };
    const adapter = module.createCliProviderAdapter({
      provider: "codex-cli",
      agentId: "agent-a",
      sessionRef: "fixture-session-ref",
      resolveSession: async () => ({ protocol: "codex-cli.v1" }),
      executable: "node",
      args: [],
      executionBroker: broker,
      cwd: ".",
    });

    await expect(adapter.streamChat({ model: "codex-cli:default", messages: [{ role: "user", content: "x".repeat(1_048_576) }] }, () => undefined))
      .rejects.toMatchObject({ code: "request_too_large" });
    expect(broker.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["codex-cli", "codex-cli-v1.mjs", "codex-cli.v1"],
    ["claude-code", "claude-code-v1.mjs", "claude-code.v1"],
  ])("parses the separate %s v1 protocol through the broker and observes usage", async (provider, fixture, protocol) => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const usageCollector = { record: vi.fn<(usage: Usage) => void>() };
    const broker: Broker = {
      execute: vi.fn(async (_agentId, _requestId, processRequest) => {
        expect(processRequest.operation).toBe("process.run");
        expect(processRequest.networkProfile).toBe("host");
        expect(processRequest.cwd).toBe(".");
        expect(processRequest.argv.join(" ")).not.toContain("fixture-session-ref");
        return processResult(protocolOutput(provider as "codex-cli" | "claude-code"));
      }),
    };
    const adapter = module.createCliProviderAdapter({
      provider,
      agentId: "agent-a",
      sessionRef: "fixture-session-ref",
      resolveSession: async (ref: string, scope: { agentId: string }) => {
        expect(ref).toBe("fixture-session-ref");
        expect(scope.agentId).toBe("agent-a");
        return { protocol };
      },
      executable: "node",
      args: [fixturePath(fixture as "codex-cli-v1.mjs" | "claude-code-v1.mjs"), "--mode", "stream"],
      executionBroker: broker,
      cwd: ".",
      usageCollector,
      maxStdoutBytes: 8_192,
      maxStderrBytes: 2_048,
      maxEventBytes: 2_048,
    });
    const events: ProviderStreamEvent[] = [];
    await adapter.streamChat(request(), (event) => events.push(event));
    expect(events.map((event) => event.type)).toContain("delta");
    expect(events.map((event) => event.type)).toContain("done");
    expect(usageCollector.record).toHaveBeenCalledWith(expect.objectContaining({ provider, model: "fixture-model" }));
    expect(JSON.stringify(events)).not.toContain("fixture-session-ref");
    expect(JSON.stringify(events)).not.toContain("must-not-be-read");
  });

  it.each(["malformed", "eof", "unknown", "duplicate-terminal"])("rejects %s protocol violations instead of guessing", async (mode) => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const broker: Broker = { execute: vi.fn(async () => processResult(protocolOutput("codex-cli", mode))) };
    const adapter = module.createCliProviderAdapter({
      provider: "codex-cli",
      agentId: "agent-a",
      sessionRef: "fixture-session-ref",
      resolveSession: async () => ({ protocol: "codex-cli.v1" }),
      executable: "node",
      args: [fixturePath("codex-cli-v1.mjs"), "--mode", mode],
      executionBroker: broker,
      cwd: ".",
      maxEventBytes: 512,
    });
    await expect(adapter.streamChat(request(), () => undefined)).rejects.toMatchObject({ code: "protocol_error" });
  });

  it("enforces stdout/event caps and sanitizes stderr without exposing secret material", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const secret = "must-not-appear";
    const cases = [
      { name: "stdout", stdout: "x".repeat(1_025), stderr: "", maxStdoutBytes: 1_024, maxStderrBytes: 4_096, maxEventBytes: 4_096 },
      { name: "stderr", stdout: protocolOutput("claude-code"), stderr: `${secret}${"x".repeat(512)}`, maxStdoutBytes: 8_192, maxStderrBytes: 512, maxEventBytes: 4_096 },
      { name: "event", stdout: protocolOutput("claude-code", "oversized"), stderr: "", maxStdoutBytes: 64_000, maxStderrBytes: 4_096, maxEventBytes: 512 },
    ];
    for (const limits of cases) {
      const broker: Broker = { execute: vi.fn(async () => processResult(limits.stdout, limits.stderr)) };
      const adapter = module.createCliProviderAdapter({
        provider: "claude-code",
        agentId: "agent-a",
        sessionRef: "fixture-session-ref",
        resolveSession: async () => ({ protocol: "claude-code.v1" }),
        executable: "node",
        args: [fixturePath("claude-code-v1.mjs"), "--mode", limits.name],
        executionBroker: broker,
        cwd: ".",
        maxStdoutBytes: limits.maxStdoutBytes,
        maxStderrBytes: limits.maxStderrBytes,
        maxEventBytes: limits.maxEventBytes,
      });
      let failure: unknown;
      try {
        await adapter.streamChat(request(), () => undefined);
      } catch (error) {
        failure = error;
      }
      expect(failure, `${limits.name} cap`).toMatchObject({ code: "output_limit" });
      expect(String(failure)).not.toContain(secret);
    }
  });

  it("propagates child-start barrier, cancellation, timeout, descendant ownership and shutdown to the broker", async () => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    const signals: AbortSignal[] = [];
    let resolveRun: ((result: ExecutionResult) => void) | undefined;
    const broker: Broker = {
      execute: vi.fn(async (_agentId, _requestId, processRequest, signal) => {
        expect(processRequest).toMatchObject({ operation: "process.run", timeoutMs: 50, networkProfile: "host" });
        expect(processRequest.argv).toContain("descendant");
        if (signal !== undefined) signals.push(signal);
        return await new Promise<ExecutionResult>((resolve) => {
          resolveRun = resolve;
          signal?.addEventListener("abort", () => {
            resolve({ ok: false, operation: "process.run", code: "process_aborted", message: "owned process tree stopped" });
          }, { once: true });
        });
      }),
    };
    const adapter = module.createCliProviderAdapter({
      provider: "codex-cli",
      agentId: "agent-a",
      sessionRef: "fixture-session-ref",
      resolveSession: async () => ({ protocol: "codex-cli.v1" }),
      executable: "node",
      args: [fixturePath("codex-cli-v1.mjs"), "--mode", "descendant"],
      executionBroker: broker,
      cwd: ".",
      timeoutMs: 50,
    });
    const events: ProviderStreamEvent[] = [];
    const barrier = adapter.streamChat(request(), (event) => events.push(event));
    await vi.waitFor(() => expect(resolveRun).toBeTypeOf("function"), { interval: 1 });
    expect(events).toEqual([]);
    resolveRun!(processResult(protocolOutput("codex-cli")));
    await barrier;
    expect(events.map((event) => event.type)).toEqual(["delta", "done"]);

    resolveRun = undefined;
    const controller = new AbortController();
    const pending = adapter.streamChat({ ...request(), signal: controller.signal }, () => undefined);
    await vi.waitFor(() => expect(resolveRun).toBeTypeOf("function"), { interval: 1 });
    controller.abort(new Error("fixture cancellation"));
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(signals.at(-1)?.aborted).toBe(true);

    vi.useFakeTimers();
    try {
      resolveRun = undefined;
      const timedOut = adapter.streamChat(request(), () => undefined);
      const timedOutExpectation = expect(timedOut).rejects.toMatchObject({ code: "timed_out" });
      await vi.advanceTimersByTimeAsync(51);
      await timedOutExpectation;
      expect(signals.at(-1)?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    resolveRun = undefined;
    const shutdown = adapter.streamChat(request(), () => undefined);
    await vi.waitFor(() => expect(resolveRun).toBeTypeOf("function"), { interval: 1 });
    await adapter.close?.();
    await expect(shutdown).rejects.toMatchObject({ code: "aborted" });
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it.each(["cancel", "close"] as const)("does not start CLI execution when %s occurs during session resolution", async (mode) => {
    const module = await loadOptionalAdapters();
    expect(module, "P2.5 RED: optional adapters module is missing").not.toBeNull();
    if (module === null) return;

    let resolveSession!: (session: { protocol: string }) => void;
    const broker: Broker = { execute: vi.fn(async () => processResult(protocolOutput("codex-cli"))) };
    const adapter = module.createCliProviderAdapter({
      provider: "codex-cli",
      agentId: "agent-a",
      sessionRef: "fixture-session-ref",
      resolveSession: async () => new Promise((resolve) => { resolveSession = resolve; }),
      executable: "node",
      args: [],
      executionBroker: broker,
      cwd: ".",
    });
    const controller = new AbortController();
    const pending = adapter.streamChat({ ...request("codex-cli:default"), signal: controller.signal }, () => undefined);
    await vi.waitFor(() => expect(resolveSession).toBeTypeOf("function"), { interval: 1 });
    if (mode === "cancel") controller.abort(new Error("fixture cancellation"));
    else await adapter.close?.();
    resolveSession({ protocol: "codex-cli.v1" });

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(broker.execute).not.toHaveBeenCalled();
  });
});
