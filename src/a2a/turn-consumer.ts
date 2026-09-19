import type { TurnRunner } from "../rpc/send.js";
import type { A2AMessageRecord } from "./store.js";

/**
 * Routes one durable A2A message through the normal TurnRunner. The A2A ACK
 * is released only after the runner's SQLite-backed completion barrier.
 */
export async function consumeA2ATurn(
  runner: Pick<TurnRunner, "sendAgentPrompt" | "flush" | "isPromptCompleted">,
  message: A2AMessageRecord,
): Promise<{ ackNonce: string }> {
  const prompt = message.payload.kind === "text"
    ? message.payload.text
    : `[A2A task-result-ref ${message.payload.taskId}] ${message.payload.summary}`;
  const clientNonce = `a2a:${message.messageId}`;
  await runner.sendAgentPrompt({ agentId: message.recipientAgentId, prompt, clientNonce }, message.senderAgentId);
  await runner.flush(message.recipientAgentId);
  if (!runner.isPromptCompleted(message.recipientAgentId, clientNonce)) {
    throw new Error("a2a: consumer turn did not reach a durable completion");
  }
  return { ackNonce: `ack:${message.messageId}` };
}
