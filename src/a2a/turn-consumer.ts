import type { TurnRunner } from "../rpc/send.js";
import type { A2AMessageRecord } from "./store.js";

/**
 * Routes one durable A2A message through the normal TurnRunner. The A2A ACK
 * is released only after the runner's SQLite-backed completion barrier.
 */
export async function consumeA2ATurn(
  runner: Pick<TurnRunner, "sendAgentPrompt" | "flush" | "promptOutcome">,
  message: A2AMessageRecord,
): Promise<{ ackNonce?: string; outcome: "success" | "partial" | "error" | "aborted" }> {
  const prompt = message.payload.kind === "text"
    ? message.payload.text
    : `[A2A task-result-ref ${message.payload.taskId}] ${message.payload.summary}`;
  const clientNonce = `a2a:${message.messageId}`;
  await runner.sendAgentPrompt({ agentId: message.recipientAgentId, prompt, clientNonce }, message.senderAgentId);
  await runner.flush(message.recipientAgentId);
  const outcome = runner.promptOutcome(message.recipientAgentId, clientNonce);
  if (outcome === undefined) {
    throw new Error("a2a: consumer turn did not reach a durable completion");
  }
  return outcome === "success"
    ? { ackNonce: `ack:${message.messageId}`, outcome }
    : { outcome };
}
