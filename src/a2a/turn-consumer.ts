import type { TurnRunner } from "../rpc/send.js";
import type { A2AMessageRecord } from "./store.js";

/** Settles with `work`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(new Error("a2a: delivery aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("a2a: delivery aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/**
 * Routes one durable A2A message through the normal TurnRunner. The A2A ACK
 * is released only after the runner's SQLite-backed completion barrier.
 * When the delivery lease is lost or the runtime stops (`signal`), waiting
 * ends at once and nothing is acknowledged; the turn itself keeps its
 * `a2a:<message>` nonce, so a redelivery never runs it twice.
 */
export async function consumeA2ATurn(
  runner: Pick<TurnRunner, "sendAgentPrompt" | "flush" | "promptOutcome">,
  message: A2AMessageRecord,
  signal?: AbortSignal,
): Promise<{ ackNonce?: string; outcome: "success" | "partial" | "error" | "aborted" }> {
  const prompt = message.payload.kind === "text"
    ? message.payload.text
    : `[A2A task-result-ref ${message.payload.taskId}] ${message.payload.summary}`;
  const clientNonce = `a2a:${message.messageId}`;
  await untilAborted(runner.sendAgentPrompt({ agentId: message.recipientAgentId, prompt, clientNonce }, message.senderAgentId), signal);
  await untilAborted(runner.flush(message.recipientAgentId), signal);
  const outcome = runner.promptOutcome(message.recipientAgentId, clientNonce);
  if (outcome === undefined) {
    throw new Error("a2a: consumer turn did not reach a durable completion");
  }
  return outcome === "success"
    ? { ackNonce: `ack:${message.messageId}`, outcome }
    : { outcome };
}
