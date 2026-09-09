/**
 * P2.3 — RPC surface for server-side attachment staging, transcript search,
 * and incremental history. The renderer only ever receives opaque
 * `attachment:<id>` references; every revalidation happens here or at send.
 */
import { AttachmentStagingStore, STAGED_PATH_PREFIX } from "../attachments/staging.js";
import type { ConfigStore } from "../config/store.js";
import type { MemoryStore } from "../memory/types.js";
import { RpcError, type Gateway } from "../server/gateway.js";

function record(body: unknown, method: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RpcError(400, method + ": corpo deve ser um objeto");
  return body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, name: string, method: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new RpcError(400, method + ": " + name + " é obrigatório");
  return value.trim();
}

function scopedAgent(config: ConfigStore, body: Record<string, unknown>, method: string): string {
  const explicit = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const alias = typeof body.id === "string" ? body.id.trim() : "";
  const agentId = explicit.length > 0 ? explicit : alias.length > 0 ? alias : "";
  if (agentId.length === 0) throw new RpcError(400, method + ": agentId é obrigatório");
  if (!config.snapshot().agents.some((agent) => agent.id === agentId)) throw new RpcError(404, method + ": agente não encontrado");
  return agentId;
}

function decodeBase64(value: string, method: string): Buffer {
  if (value.length === 0) throw new RpcError(400, method + ": bytesBase64 vazio");
  try {
    const bytes = Buffer.from(value, "base64");
    // Reject garbage that does not round-trip as base64.
    if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") === "") {
      if (value.trim().length > 0 && bytes.length === 0) throw new Error("empty");
    }
    return bytes;
  } catch {
    throw new RpcError(400, method + ": bytesBase64 inválido");
  }
}

export interface RegisterP23HandlersOptions {
  staging?: AttachmentStagingStore;
  memory?: MemoryStore;
  config?: ConfigStore;
}

export function registerP23Handlers(gateway: Gateway, options: RegisterP23HandlersOptions): void {
  const { staging, memory, config } = options;

  if (staging !== undefined) {
    gateway.registerHandler("stageAttachment", async (body) => {
      const method = "stageAttachment";
      const b = record(body, method);
      const agentId = config === undefined ? requiredString(b, "agentId", method) : scopedAgent(config, b, method);
      const filename = requiredString(b, "filename", method);
      const bytesBase64 = requiredString(b, "bytesBase64", method);
      const conversationId = typeof b.conversationId === "string" && b.conversationId.trim().length > 0 ? b.conversationId.trim() : undefined;
      const bytes = decodeBase64(bytesBase64, method);
      let staged;
      try {
        staged = await staging.stageBytes(agentId, { filename, bytes, ...(conversationId === undefined ? {} : { conversationId }) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("unsupported_media")) throw new RpcError(415, method + ": tipo de mídia não suportado");
        if (message.includes("too_large")) throw new RpcError(413, method + ": arquivo acima do limite");
        if (message.includes("staging_pool")) throw new RpcError(429, method + ": limite de staging atingido");
        if (message.includes("staging_bytes")) throw new RpcError(429, method + ": limite de bytes de staging atingido");
        throw new RpcError(400, method + ": " + message);
      }
      return {
        attachmentId: staged.id,
        name: staged.filename,
        kind: staged.kind,
        sizeBytes: staged.sizeBytes,
        sha256: staged.sha256,
        createdAtMs: staged.createdAtMs,
        expiresAtMs: staged.expiresAtMs,
      };
    });

    gateway.registerHandler("listStagedAttachments", (body) => {
      const method = "listStagedAttachments";
      const b = record(body, method);
      const agentId = config === undefined ? requiredString(b, "agentId", method) : scopedAgent(config, b, method);
      const conversationId = typeof b.conversationId === "string" && b.conversationId.trim().length > 0 ? b.conversationId.trim() : undefined;
      return staging.listActive(agentId, conversationId).map((entry) => ({
        attachmentId: entry.id,
        name: entry.filename,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
        createdAtMs: entry.createdAtMs,
        expiresAtMs: entry.expiresAtMs,
        state: entry.state,
      }));
    });

    gateway.registerHandler("discardStagedAttachment", async (body) => {
      const method = "discardStagedAttachment";
      const b = record(body, method);
      const agentId = config === undefined ? requiredString(b, "agentId", method) : scopedAgent(config, b, method);
      const attachmentId = requiredString(b, "attachmentId", method);
      await staging.discard(agentId, attachmentId);
      return { ok: true };
    });

    gateway.registerHandler("commitStagedAttachments", async (body) => {
      const method = "commitStagedAttachments";
      const b = record(body, method);
      const agentId = config === undefined ? requiredString(b, "agentId", method) : scopedAgent(config, b, method);
      const paths = Array.isArray(b.paths) ? b.paths.filter((value): value is string => typeof value === "string") : [];
      if (paths.length === 0) throw new RpcError(400, method + ": paths é obrigatório");
      const committed: string[] = [];
      for (const path of paths) {
        if (!path.startsWith(STAGED_PATH_PREFIX)) continue;
        const id = path.slice(STAGED_PATH_PREFIX.length);
        const ok = await staging.commit(agentId, id);
        if (ok) committed.push(path);
      }
      if (committed.length !== paths.filter((path) => path.startsWith(STAGED_PATH_PREFIX)).length) {
        throw new RpcError(409, method + ": um ou mais anexos não puderam ser confirmados");
      }
      return committed;
    });

    // Native bridge compatibility (proprietary preload + patched main.cjs):
    // returns an opaque path the renderer hands back into sendPrompt.
    gateway.registerHandler("uploadAttachment", async (body) => {
      const method = "uploadAttachment";
      const b = record(body, method);
      const agentId = config === undefined ? requiredString(b, "agentId", method) : scopedAgent(config, b, method);
      const filename = requiredString(b, "filename", method);
      const bytesBase64 = requiredString(b, "bytesBase64", method);
      const bytes = decodeBase64(bytesBase64, method);
      let staged;
      try {
        staged = await staging.stageBytes(agentId, { filename, bytes });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("unsupported_media")) throw new RpcError(415, method + ": tipo de mídia não suportado");
        if (message.includes("too_large")) throw new RpcError(413, method + ": arquivo acima do limite");
        throw new RpcError(400, method + ": " + message);
      }
      return { path: staged.id.startsWith("att-") ? STAGED_PATH_PREFIX + staged.id : STAGED_PATH_PREFIX + staged.id };
    });
  }

  if (memory !== undefined) {
    gateway.registerHandler("searchTranscript", (body) => {
      const method = "searchTranscript";
      const b = record(body, method);
      const agentId = config === undefined ? requiredString(b, "agentId", method) : scopedAgent(config, b, method);
      const query = requiredString(b, "query", method);
      const limit = b.limit === undefined ? 20 : b.limit;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new RpcError(400, method + ": limit inválido");
      const conversationId = typeof b.conversationId === "string" && b.conversationId.trim().length > 0 ? b.conversationId.trim() : undefined;
      const cursor = typeof b.cursor === "string" && b.cursor.length > 0 ? b.cursor : undefined;
      if (typeof memory.searchTranscript !== "function") throw new RpcError(501, method + ": busca indisponível");
      const page = memory.searchTranscript(agentId, query, {
        ...(conversationId === undefined ? {} : { conversationId }),
        limit: limit as number,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return { agentId, query, items: page.items, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
    });
  }
}
