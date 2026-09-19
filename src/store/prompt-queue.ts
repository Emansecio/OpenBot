import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { SandSendPromptArgs } from "../shared/contracts.js";
import type { ResolvedProvider } from "../rpc/identity.js";

export interface QueuedPrompt {
  args: SandSendPromptArgs;
  inference: ResolvedProvider;
  state: "queued" | "running" | "completed" | "cancelled" | "interrupted";
  sequence: number;
  digest: string;
  compacted: boolean;
  recoveryOf?: string;
}

export interface PromptQueueStore {
  put(args: SandSendPromptArgs, inference: ResolvedProvider): QueuedPrompt;
  get(agentId: string, conversationId: string, nonce: string): QueuedPrompt | undefined;
  list(agentId?: string, state?: "queued" | "interrupted", limit?: number): QueuedPrompt[];
  transition(agentId: string, conversationId: string, nonce: string, from: QueuedPrompt["state"], to: QueuedPrompt["state"]): boolean;
  revise(agentId: string, conversationId: string, nonce: string, args: SandSendPromptArgs): QueuedPrompt;
  compactTerminal(limit?: number): number;
  clear(agentId: string): void;
}

interface QueueRow { args_json: string; inference_json: string; state: QueuedPrompt["state"]; sequence: number; payload_digest: string; payload_compacted: number; recovery_of: string | null }

function parsePayload(text: string): SandSendPromptArgs {
  const value: SandSendPromptArgs = JSON.parse(text);
  if (!value || typeof value.agentId !== "string" || typeof value.conversationId !== "string" || typeof value.clientNonce !== "string" || typeof value.prompt !== "string") throw new Error("Invalid stored prompt");
  return value;
}

function parseInference(text: string): ResolvedProvider {
  const value: ResolvedProvider = JSON.parse(text);
  if (!value || typeof value.provider !== "string" || typeof value.model !== "string") throw new Error("Invalid stored provider");
  return value;
}

const key = (agent: string, conversation: string, nonce: string) => JSON.stringify([agent, conversation, nonce]);
export const promptPayloadDigest = (args: SandSendPromptArgs) => createHash("sha256").update(JSON.stringify({
  prompt: args.prompt, attachments: args.attachments ?? [], replyContext: args.replyContext ?? null,
  richText: args.richText ?? null,
})).digest("hex");

export function createPromptQueue(db?: Database.Database): PromptQueueStore {
  const rows = new Map<string, QueuedPrompt>();
  let sequence = 0;
  const decode = (row: QueueRow | undefined): QueuedPrompt | undefined => {
    if (!row) return undefined;
    const args = parsePayload(row.args_json);
    if (row.payload_compacted && !/^[a-f0-9]{64}$/.test(row.payload_digest)) throw new Error("Invalid compacted prompt digest");
    return { args, inference: parseInference(row.inference_json), state: row.state, sequence: row.sequence,
      digest: row.payload_digest || promptPayloadDigest(args), compacted: row.payload_compacted === 1,
      ...(row.recovery_of ? { recoveryOf: row.recovery_of } : {}) };
  };
  const find = db?.prepare<unknown[], QueueRow>("SELECT * FROM prompt_queue WHERE agent_id=? AND conversation_id=? AND nonce=?");
  const get: PromptQueueStore["get"] = (agent, conversation, nonce) => db
    ? decode(find!.get(agent, conversation, nonce))
    : structuredClone(rows.get(key(agent, conversation, nonce)));
  const compact = (row: QueuedPrompt): void => {
    if (row.compacted || (row.state !== "completed" && row.state !== "cancelled")) return;
    const args = { agentId: row.args.agentId, conversationId: row.args.conversationId, clientNonce: row.args.clientNonce, prompt: "" };
    const inference = { provider: row.inference.provider, model: row.inference.model };
    if (db) db.prepare("UPDATE prompt_queue SET args_json=?,inference_json=?,payload_digest=?,payload_compacted=1 WHERE sequence=? AND state IN ('completed','cancelled') AND payload_compacted=0")
      .run(JSON.stringify(args), JSON.stringify(inference), row.digest, row.sequence);
    else Object.assign(rows.get(key(args.agentId, args.conversationId!, args.clientNonce!))!, { args, inference, compacted: true });
  };
  const store: PromptQueueStore = {
    get,
    clear(agentId) {
      if (db) db.prepare("DELETE FROM prompt_queue WHERE agent_id=?").run(agentId);
      else for (const [id, row] of rows) if (row.args.agentId === agentId) rows.delete(id);
    },
    put(args, inference) {
      if (!args.conversationId || !args.clientNonce) throw new Error("Durable queue requires conversation and nonce");
      const payload = JSON.stringify(args);
      if (Buffer.byteLength(payload) > 2 * 1024 * 1024) throw new Error("Queued prompt exceeds storage limit");
      const hash = promptPayloadDigest(args);
      const write = () => {
        const existing = get(args.agentId, args.conversationId!, args.clientNonce!);
        if (existing) {
          if (existing.digest !== hash) throw new Error("Nonce already belongs to a different prompt");
          return existing;
        }
        if (db) {
          db.prepare("INSERT INTO prompt_queue(agent_id,conversation_id,nonce,args_json,inference_json,payload_digest,state) VALUES(?,?,?,?,?,?,'queued')")
            .run(args.agentId, args.conversationId, args.clientNonce, payload, JSON.stringify(inference), hash);
          for (const attachment of args.attachments ?? []) {
            if (!attachment.path.startsWith("attachment:")) continue;
            const id = attachment.path.slice(11);
            const result = db.prepare("UPDATE attachment_staging SET expires_at_ms=?,state='committed' WHERE id=? AND agent_id=? AND (conversation_id IS NULL OR conversation_id=?) AND state!='discarded' AND consumed_at_ms IS NULL AND expires_at_ms>?")
              .run(Number.MAX_SAFE_INTEGER, id, args.agentId, args.conversationId, Date.now());
            if (result.changes !== 1) throw new Error("Queued attachment is unavailable or belongs to another conversation");
          }
          return get(args.agentId, args.conversationId!, args.clientNonce!)!;
        }
        const row = { args: structuredClone(args), inference: structuredClone(inference), state: "queued" as const, sequence: ++sequence, digest: hash, compacted: false };
        rows.set(key(args.agentId, args.conversationId!, args.clientNonce!), row);
        return structuredClone(row);
      };
      return db ? db.transaction(write).immediate() : write();
    },
    list(agentId, state = "queued", limit) {
      if (state !== "queued" && state !== "interrupted") throw new Error("Invalid prompt queue state");
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new Error("Invalid prompt queue limit");
      if (db) return db.prepare<unknown[], QueueRow>(`SELECT * FROM prompt_queue WHERE state=?${agentId === undefined ? "" : " AND agent_id=?"} ORDER BY sequence${limit === undefined ? "" : " LIMIT ?"}`)
        .all(state, ...(agentId === undefined ? [] : [agentId]), ...(limit === undefined ? [] : [limit])).map(row => decode(row)!);
      return [...rows.values()].filter(row => row.state === state && (agentId === undefined || row.args.agentId === agentId)).slice(0, limit).map(row => structuredClone(row));
    },
    transition(agent, conversation, nonce, from, to) {
      if (db) return db.transaction(() => {
        const row = get(agent, conversation, nonce);
        if (db.prepare("UPDATE prompt_queue SET state=? WHERE agent_id=? AND conversation_id=? AND nonce=? AND state=?").run(to, agent, conversation, nonce, from).changes !== 1) return false;
        if (to !== "running" && to !== "queued") {
          for (const attachment of row?.args.attachments ?? []) {
            if (!attachment.path.startsWith("attachment:")) continue;
            // Retain the usual recovery window, but never leave cancelled attachments immortal.
            const held = db.prepare("SELECT 1 FROM prompt_queue q, json_each(q.args_json,'$.attachments') a WHERE q.agent_id=? AND q.state IN ('queued','running') AND json_extract(a.value,'$.path')=? LIMIT 1").get(agent, attachment.path);
            if (held) continue;
            db.prepare("UPDATE attachment_staging SET expires_at_ms=? WHERE id=? AND agent_id=? AND expires_at_ms=?")
              .run(Date.now() + 24 * 60 * 60_000, attachment.path.slice(11), agent, Number.MAX_SAFE_INTEGER);
          }
        }
        if (row) compact({ ...row, state: to });
        return true;
      })();
      const row = rows.get(key(agent, conversation, nonce));
      if (!row || row.state !== from) return false;
      row.state = to;
      compact(row);
      return true;
    },
    revise(agent, conversation, nonce, args) {
      if (args.agentId !== agent || args.conversationId !== conversation || !args.clientNonce || args.clientNonce === nonce) throw new Error("Invalid recovery identity");
      const revise = () => {
        const existing = get(agent, conversation, args.clientNonce!);
        if (existing) {
          if (existing.recoveryOf !== nonce || existing.digest !== promptPayloadDigest(args)) throw new Error("Recovery nonce already belongs to another request");
          return existing;
        }
        const original = get(agent, conversation, nonce);
        if (!original || original.state !== "interrupted" || original.compacted) throw new Error("Message is no longer available for recovery");
        const replacement = store.put(args, original.inference);
        if (db) db.prepare("UPDATE prompt_queue SET recovery_of=? WHERE sequence=?").run(nonce, replacement.sequence);
        else rows.get(key(agent, conversation, args.clientNonce!))!.recoveryOf = nonce;
        if (!store.transition(agent, conversation, nonce, "interrupted", "cancelled")) throw new Error("Recovery state changed");
        return get(agent, conversation, args.clientNonce!)!;
      };
      return db ? db.transaction(revise).immediate() : revise();
    },
    compactTerminal(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid compaction limit");
      const candidates = db
        ? db.prepare<unknown[], QueueRow>("SELECT * FROM prompt_queue WHERE payload_compacted=0 AND state IN ('completed','cancelled') ORDER BY sequence LIMIT ?").all(limit).map(row => decode(row)!)
        : [...rows.values()].filter(row => !row.compacted && (row.state === "completed" || row.state === "cancelled")).slice(0, limit);
      const apply = () => { for (const row of candidates) compact(row); return candidates.length; };
      return db ? db.transaction(apply)() : apply();
    },
  };
  return store;
}