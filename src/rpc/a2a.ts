import { randomUUID } from "node:crypto";

import type { Gateway } from "../server/gateway.js";
import { RpcError } from "../server/gateway.js";
import { parseA2ASendInput, type A2ASendInput } from "../a2a/contracts.js";
import { A2AStore } from "../a2a/store.js";

export interface A2ARpcOptions {
  store: A2AStore;
  activeAgents?: () => readonly string[];
  now?: () => number;
  wake?: () => void;
}

function objectBody(body: unknown, method: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RpcError(400, `${method}: corpo deve ser um objeto`);
  return body as Record<string, unknown>;
}

function strictBody(body: unknown, method: string, allowed: readonly string[]): Record<string, unknown> {
  const value = objectBody(body, method);
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new RpcError(400, `${method}: campo desconhecido ${key}`);
  return value;
}

function requiredString(value: unknown, field: string, method: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new RpcError(400, `${method}: ${field} é obrigatório`);
  return value.trim();
}

function mapA2AError(method: string, error: unknown): never {
  if (error instanceof RpcError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found|não encontrado|not active|não está ativo|incarnation|recipient|sender/iu.test(message) ? 404
    : /fenced|fence|conflict|limit|cap|self|sensitive|unknown|invalid|stale/iu.test(message) ? 409 : 400;
  throw new RpcError(status, `${method}: ${message}`);
}

export function registerA2AHandlers(gateway: Gateway, options: A2ARpcOptions): void {
  const now = options.now ?? (() => Date.now());
  gateway.registerHandler("sendAgentMessage", (body) => {
    const value = strictBody(body, "sendAgentMessage", ["senderAgentId", "recipientAgentId", "nonce", "parentTaskId", "parentTurnId", "priority", "hopCount", "payload"]);
    try {
      if (options.activeAgents !== undefined) options.store.syncActiveAgents(options.activeAgents());
      const createdAtMs = now();
      const input: A2ASendInput = parseA2ASendInput({
        version: 1,
        ...value,
        messageId: randomUUID(),
        createdAtMs,
        availableAtMs: createdAtMs,
        expiresAtMs: null,
      });
      const result = options.store.send(input);
      options.wake?.();
      return result;
    } catch (error) { return mapA2AError("sendAgentMessage", error); }
  });

  gateway.registerHandler("listAgentMessages", (body) => {
    const value = strictBody(body, "listAgentMessages", ["agentId"]);
    try { return options.store.listForRecipient(requiredString(value.agentId, "agentId", "listAgentMessages")); }
    catch (error) { return mapA2AError("listAgentMessages", error); }
  });

  gateway.registerHandler("getAgentMessage", (body) => {
    const value = strictBody(body, "getAgentMessage", ["agentId", "messageId"]);
    const agentId = requiredString(value.agentId, "agentId", "getAgentMessage");
    const messageId = requiredString(value.messageId, "messageId", "getAgentMessage");
    const message = options.store.getMessageForRecipient(agentId, messageId);
    if (message === undefined) throw new RpcError(404, "getAgentMessage: mensagem não encontrada para o recipient");
    return message;
  });

  gateway.registerHandler("ackAgentMessage", (body) => {
    const value = strictBody(body, "ackAgentMessage", ["agentId", "messageId", "ownerId", "expectedVersion", "status", "ackNonce"]);
    const agentId = requiredString(value.agentId, "agentId", "ackAgentMessage");
    const messageId = requiredString(value.messageId, "messageId", "ackAgentMessage");
    const message = options.store.getMessageForRecipient(agentId, messageId);
    if (message === undefined) throw new RpcError(404, "ackAgentMessage: mensagem não encontrada para o recipient");
    try {
      const ownerId = requiredString(value.ownerId, "ownerId", "ackAgentMessage");
      if (!Number.isSafeInteger(value.expectedVersion)) throw new RpcError(400, "ackAgentMessage: expectedVersion inválido");
      const status = value.status === undefined ? "acked" : value.status;
      if (status !== "acked" && status !== "dead") throw new RpcError(400, "ackAgentMessage: status inválido");
      const ackNonce = value.ackNonce === undefined ? undefined : requiredString(value.ackNonce, "ackNonce", "ackAgentMessage");
      return options.store.ack(messageId, { ownerId, expectedVersion: value.expectedVersion as number, status, ...(ackNonce === undefined ? {} : { ackNonce }) });
    } catch (error) { return mapA2AError("ackAgentMessage", error); }
  });
}
