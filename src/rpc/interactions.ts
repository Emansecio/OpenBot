import type { Keystore } from "../keystore/index.js";
import { RpcError, type Gateway } from "../server/gateway.js";
import { SqliteTranscriptStore } from "../store/index.js";

const record = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RpcError(400, "interactions: corpo deve ser um objeto");
  return body as Record<string, unknown>;
};
const optionalText = (body: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new RpcError(400, `${keys.join("|")} inválido`);
};
const agentId = (body: Record<string, unknown>): string => {
  const raw = body.agentId ?? body.id;
  if (raw === undefined) return "openbot-default";
  if (typeof raw !== "string" || raw.trim().length === 0) throw new RpcError(400, "agente não encontrado");
  return raw.trim();
};
const decisionValue = (body: Record<string, unknown>): string => {
  const raw = body.decision ?? body.resolution ?? body.value ?? body.response;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw === true) return "allow";
  if (raw === false) return "deny";
  throw new RpcError(400, "decision inválida");
};

export function registerInteractionHandlers(
  gateway: Gateway,
  store: SqliteTranscriptStore,
  keystore: Keystore,
): void {
  const decision = (body: unknown, kind: string, allowed: readonly string[]) => {
    const b = record(body);
    const id = agentId(b);
    const requestId = optionalText(b, ["requestId", "entryId", "widgetId"]);
    const value = decisionValue(b);
    if (!allowed.includes(value)) throw new RpcError(400, "decision inválida");
    const saved = store.rememberInteractionDecision(id, requestId, kind, value);
    return { ok: true, agentId: id, requestId, decision: saved.decision };
  };
  gateway.registerHandler("respondToWidget", (body) => {
    const b = record(body);
    const id = agentId(b);
    const widgetId = optionalText(b, ["widgetId", "entryId"]);
    if (b.response === undefined && b.value === undefined && b.resolution === undefined) {
      throw new RpcError(400, "response obrigatório");
    }
    return { ok: true, agentId: id, widgetId };
  });
  gateway.registerHandler("dismissWidget", (body) => {
    const b = record(body);
    const id = agentId(b);
    return { ok: true, agentId: id, widgetId: optionalText(b, ["widgetId", "entryId"]) };
  });
  gateway.registerHandler("resolveAutoReviewApproval", (body) => decision(body, "auto-review-approval", ["approve", "reject", "allow", "deny"]));
  gateway.registerHandler("submitSecret", async (body) => {
    const b = record(body);
    const id = agentId(b);
    const widgetId = optionalText(b, ["widgetId", "entryId"]);
    const name = optionalText(b, ["secretName", "name", "label"]);
    const value = optionalText(b, ["secretValue", "value", "secret"]);
    await keystore.upsert(name, value);
    return { ok: true, agentId: id, widgetId, secretName: name };
  });
}
