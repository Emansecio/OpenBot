import { expect, it } from "vitest";
import { createProviderRegistry, type ProviderChatRequest } from "../src/providers/router.js";
import { createMemoryTranscriptStore, registerSendPromptHandler } from "../src/rpc/send.js";
import { Gateway, RpcError } from "../src/server/gateway.js";

it("retryPrompt binds the clicked failure instead of retrying a newer message", async () => {
  const store = createMemoryTranscriptStore();
  const conversationId = store.conversationStore!.ensureDefault("a").id;
  const registry = createProviderRegistry();
  const requests: ProviderChatRequest[] = [];
  registry.register({
    name: "fixture",
    async streamChat(request, emit) {
      requests.push(request);
      emit({ type: "delta", delta: requests.length <= 2 ? "partial" : "recovered" });
      if (requests.length <= 2) throw Object.assign(new Error("temporary"), { status: 503 });
    },
  });
  const gateway = new Gateway();
  const runner = registerSendPromptHandler(gateway, {
    registry, store,
    resolveProvider: () => ({ provider: "fixture", model: "fixture" }),
  });
  const handler = gateway.listHandlers().get("retryPrompt")!;
  const retry = (expectedFailureEntryId?: unknown) => handler({ agentId: "a", conversationId, expectedFailureEntryId }, {
    method: "retryPrompt", getStatus: () => runner.getStatus(), publish: () => {},
  });
  const latestFailure = () => [...store.getEntries("a", conversationId)].reverse().find((entry) => entry.kind === "notice" && entry.retryable === true);
  try {
    await runner.sendPrompt({ agentId: "a", conversationId, prompt: "message A", clientNonce: "A" });
    await runner.flush("a");
    const failureA = latestFailure()!;
    await runner.sendPrompt({ agentId: "a", conversationId, prompt: "message B", clientNonce: "B" });
    await runner.flush("a");
    const failureB = latestFailure()!;
    expect(typeof failureA.id).toBe("string");
    expect(typeof failureB.id).toBe("string");
    expect(failureA.id).not.toBe(failureB.id);
    const beforeRetry = store.getEntries("a", conversationId);
    expect(() => retry(failureA.id)).toThrowError(expect.objectContaining({ status: 409 }));
    for (const invalid of [null, 42, "", "   "]) {
      expect(() => retry(invalid)).toThrowError(expect.objectContaining({ status: 400 }));
    }
    expect(store.getEntries("a", conversationId)).toEqual(beforeRetry);
    expect(requests).toHaveLength(2);
    await expect(retry(failureB.id)).resolves.toEqual({ accepted: true });
    await runner.flush("a");
    expect(requests).toHaveLength(3);
    expect(requests[2]?.messages.at(-1)).toEqual({ role: "user", content: "message B" });
    // A stale row cannot claim success through the latest failure's accepted nonce.
    expect(() => retry(failureA.id)).toThrowError(RpcError);
    await expect(retry(failureB.id)).resolves.toEqual({ accepted: true });
    await expect(retry()).resolves.toEqual({ accepted: true });
    expect(requests).toHaveLength(3);
    expect(store.getEntries("a", conversationId).filter((entry) => entry.kind === "message" && entry.role === "user")).toHaveLength(2);
  } finally {
    await runner.flush("a");
  }
});
