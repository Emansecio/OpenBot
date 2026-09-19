import { describe, expect, it } from "vitest";

import { MemoryReflectionWorker } from "../src/memory/reflection.js";
import { OpenAiCompatAdapter } from "../src/providers/openai-compat.js";
import { OpenAiAdapter } from "../src/providers/openai.js";
import { OpenCodeGoAdapter } from "../src/providers/opencode-go.js";
import { createProviderRegistry, streamChat, type ProviderAdapter } from "../src/providers/router.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

type TerminalCase = {
  name: string;
  provider: string;
  model: string;
  reason: string;
  createAdapter: (fetchImpl: typeof fetch) => ProviderAdapter;
  body: string;
};

function chatBody(reason: "length" | "content_filter"): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "parcial" }, finish_reason: reason }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

const messagesBody = [
  `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "parcial" } })}\n\n`,
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 2, total_tokens: 7 } })}\n\n`,
  `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

const cases: TerminalCase[] = [
  {
    name: "OpenAI Chat length",
    provider: "openai",
    model: "chat-test",
    reason: "length",
    createAdapter: (fetchImpl) => new OpenAiAdapter({ apiKey: "fixture", fetchImpl }),
    body: chatBody("length"),
  },
  {
    name: "OpenAI Chat content_filter",
    provider: "openai",
    model: "chat-test",
    reason: "content_filter",
    createAdapter: (fetchImpl) => new OpenAiAdapter({ apiKey: "fixture", fetchImpl }),
    body: chatBody("content_filter"),
  },
  {
    name: "OpenAI-compatible Chat length",
    provider: "openai-compat",
    model: "chat-test",
    reason: "length",
    createAdapter: (fetchImpl) => new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl }),
    body: chatBody("length"),
  },
  {
    name: "OpenAI-compatible Chat content_filter",
    provider: "openai-compat",
    model: "chat-test",
    reason: "content_filter",
    createAdapter: (fetchImpl) => new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl }),
    body: chatBody("content_filter"),
  },
  {
    name: "OpenCode Messages max_tokens",
    provider: "opencode-go",
    model: "opencode-go/minimax-m2.7",
    reason: "max_tokens",
    createAdapter: (fetchImpl) => new OpenCodeGoAdapter({ apiKey: "fixture", fetchImpl }),
    body: messagesBody,
  },
];

describe("reflection terminal reasons", () => {
  it.each(cases)("marks $name as dead without retrying the incomplete response", async ({ provider, model, reason, createAdapter, body }) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const registry = createProviderRegistry();
    registry.register(createAdapter(fetchImpl));
    const transcript = new SqliteTranscriptStore({ path: ":memory:" });
    const conversationId = transcript.conversationStore.create("agent-a").id;
    const worker = new MemoryReflectionWorker({
      store: transcript.memoryStore,
      maxAttempts: 3,
      backoffMs: [0],
      reflect: async (_input, signal) => {
        const result = await streamChat(provider, {
          model,
          purpose: "memory-reflection",
          messages: [{ role: "user", content: "{}" }],
          signal,
        }, undefined, { registry, sleep: async () => {} });
        if (result.error !== undefined || result.message === undefined) {
          throw result.error ?? new Error("reflection provider returned no content");
        }
        return result.message.content;
      },
    });

    try {
      const job = worker.enqueue({
        agentId: "agent-a",
        conversationId,
        provider,
        model,
        fromSequenceId: 0,
        throughSequenceId: 0,
        summaryRequested: true,
        memoryRequested: false,
        entries: [],
      });
      await worker.waitForIdle();

      expect(calls).toBe(1);
      expect(job.id).toEqual(expect.any(String));
      expect(transcript.memoryStore.getJob("agent-a", job.id!)).toMatchObject({
        status: "dead",
        attempts: 1,
        lastErrorCode: "provider_validation",
        lastErrorText: expect.stringContaining(reason),
      });
      expect(transcript.memoryStore.getSummary("agent-a", conversationId)).toBeNull();
      expect(transcript.memoryStore.listMemories("agent-a")).toEqual([]);
    } finally {
      await worker.close();
      transcript.close();
    }
  });
});
