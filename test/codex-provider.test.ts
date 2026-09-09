import { describe, expect, it } from "vitest";

import { OpenAiAdapter } from "../src/providers/openai.js";

describe("OpenAI Codex OAuth transport", () => {
  it("uses the ChatGPT Responses endpoint, OAuth headers and Codex body", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const adapter = new OpenAiAdapter({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      protocol: "codex",
      credentialResolver: async () => ({ accessToken: "oauth-token", accountId: "acct-123" }),
      fetchImpl: async (input, init) => {
        captured = { url: String(input), init };
        const stream = [
          'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
          'data: {"type":"response.done","response":{"status":"completed"}}\n\n',
        ].join("");
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const deltas: string[] = [];

    await adapter.streamChat({
      model: "gpt-5.6-codex",
      system: "sistema",
      messages: [{ role: "user", content: "oi" }],
      maxTokens: 16_384,
      reasoningEffort: "high",
    }, (event) => {
      if (event.type === "delta") deltas.push(event.delta);
    });

    expect(captured?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
    expect(body.instructions).toBe("sistema");
    expect(body.input).toEqual([{ role: "user", content: "oi" }]);
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(deltas).toEqual(["ok"]);
  });
});
