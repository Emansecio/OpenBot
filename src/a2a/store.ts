import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { migrateOpenBotSchema } from "../store/schema.js";
import {
  A2A_MAX_BYTES_PER_PARENT_TURN,
  A2A_MAX_DELIVERY_ATTEMPTS,
  A2A_MAX_ENVELOPE_BYTES,
  A2A_MAX_HOPS,
  A2A_MAX_MESSAGES_PER_PARENT_TURN,
  A2A_MAX_PENDING_PER_RECIPIENT,
  A2A_MAX_PAYLOAD_BYTES,
  A2A_MAX_RECIPIENTS_PER_PARENT_TURN,
  A2AContractError,
  parseA2AEnvelope,
  parseA2ASendInput,
  type A2AEnvelope,
  type A2AMessageStatus,
  type A2ASendInput,
} from "./contracts.js";

export interface A2AStoreLimits {
  maxMessagesPerTurn?: number;
  maxBytesPerTurn?: number;
  maxRecipientsPerTurn?: number;
  maxPendingPerRecipient?: number;
  maxAttempts?: number;
}

export interface A2AStoreOptions {
  path: string;
  database?: Database.Database;
  now?: () => number;
  sensitiveValues?: () => readonly string[];
  limits?: A2AStoreLimits;
}

export interface A2AMessageRecord extends Omit<A2AEnvelope, "version" | "status" | "attempt" | "versionNumber" | "ackNonce"> {
  version: number;
  status: A2AMessageStatus;
  attempt: number;
  ackNonce: string | null;
  ack?: { ackNonce: string };
  terminalReason: string | null;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
}

export interface A2ASendResult {
  created: boolean;
  duplicate?: boolean;
  message: A2AMessageRecord;
}

export interface A2AClaimResult {
  message: A2AMessageRecord;
  lease: { ownerId: string; expiresAtMs: number; version: number };
}

export interface A2AStoreSnapshot {
  agentId: string;
  epoch: string;
  sequence: number;
  items: readonly A2AMessageRecord[];
}

export interface A2AProjectionEnvelope {
  projectionId: string;
  sourceOutboxId: string;
  agentId: string;
  epoch: string;
  sequence: number;
  messageId: string;
  transitionVersion: number;
  eventKind: string;
  payload: A2AMessageRecord;
}

type Row = Record<string, unknown> & {
  message_id: string;
  sender_agent_id: string;
  sender_incarnation: string;
  recipient_agent_id: string;
  recipient_incarnation: string;
  nonce: string;
  parent_task_id: string | null;
  parent_turn_id: string;
  priority: "normal" | "high";
  hop_count: number;
  payload_json: string;
  created_at_ms: number;
  available_at_ms: number;
  expires_at_ms: number | null;
  status: A2AMessageStatus;
  attempt: number;
  version: number;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  ack_nonce: string | null;
  terminal_reason: string | null;
};

type ProjectionRow = {
  projection_id: string;
  source_outbox_id: string;
  agent_id: string;
  epoch: string;
  sequence: number;
  message_id: string;
  transition_version: number;
  event_kind: string;
  payload_json: string;
  created_at_ms: number;
  delivered_at_ms: number | null;
};

function nowValue(now: (() => number) | undefined): number {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("a2a: invalid clock");
  return value;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function messageComparable(message: A2AMessageRecord): string {
  return JSON.stringify({
    senderAgentId: message.senderAgentId,
    recipientAgentId: message.recipientAgentId,
    parentTaskId: message.parentTaskId,
    parentTurnId: message.parentTurnId,
    priority: message.priority,
    hopCount: message.hopCount,
    payload: message.payload,
  });
}

function parseProjectionRecord(value: unknown): A2AMessageRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("a2a: invalid persisted projection payload");
  const source = value as Record<string, unknown>;
  const persistedVersion = source.version;
  const parsed = parseA2AEnvelope({
    version: 1,
    messageId: source.messageId,
    senderAgentId: source.senderAgentId,
    senderIncarnation: source.senderIncarnation,
    recipientAgentId: source.recipientAgentId,
    recipientIncarnation: source.recipientIncarnation,
    nonce: source.nonce,
    parentTaskId: source.parentTaskId,
    parentTurnId: source.parentTurnId,
    priority: source.priority,
    hopCount: source.hopCount,
    payload: source.payload,
    createdAtMs: source.createdAtMs,
    availableAtMs: source.availableAtMs,
    expiresAtMs: source.expiresAtMs,
    status: source.status,
    attempt: source.attempt,
    versionNumber: persistedVersion,
    ackNonce: source.ackNonce,
  });
  if (parsed.status === undefined || parsed.attempt === undefined || parsed.versionNumber === undefined) throw new Error("a2a: incomplete persisted projection payload");
  const terminalReason = source.terminalReason === null || typeof source.terminalReason === "string" ? source.terminalReason : null;
  const leaseOwner = source.leaseOwner === null || typeof source.leaseOwner === "string" ? source.leaseOwner : null;
  const leaseExpiresAtMs = source.leaseExpiresAtMs === null || (Number.isSafeInteger(source.leaseExpiresAtMs) && (source.leaseExpiresAtMs as number) >= 0)
    ? source.leaseExpiresAtMs as number | null
    : null;
  return {
    messageId: parsed.messageId,
    senderAgentId: parsed.senderAgentId,
    senderIncarnation: parsed.senderIncarnation,
    recipientAgentId: parsed.recipientAgentId,
    recipientIncarnation: parsed.recipientIncarnation,
    nonce: parsed.nonce,
    parentTaskId: parsed.parentTaskId,
    parentTurnId: parsed.parentTurnId,
    priority: parsed.priority,
    hopCount: parsed.hopCount,
    payload: parsed.payload,
    createdAtMs: parsed.createdAtMs,
    availableAtMs: parsed.availableAtMs,
    expiresAtMs: parsed.expiresAtMs,
    version: parsed.versionNumber,
    status: parsed.status,
    attempt: parsed.attempt,
    ackNonce: parsed.ackNonce ?? null,
    ...(parsed.ackNonce === undefined || parsed.ackNonce === null ? {} : { ack: { ackNonce: parsed.ackNonce } }),
    terminalReason,
    leaseOwner,
    leaseExpiresAtMs,
  };
}

export class A2AStore {
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;
  private readonly now: () => number;
  private readonly sensitiveValues: () => readonly string[];
  private readonly limits: Required<A2AStoreLimits>;
  private closed = false;

  constructor(options: A2AStoreOptions) {
    if (typeof options.path !== "string" || options.path.length === 0) throw new Error("a2a: path is required");
    this.ownsDatabase = options.database === undefined;
    this.db = options.database ?? new Database(options.path);
    this.db.pragma("foreign_keys = ON");
    if (this.ownsDatabase) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("busy_timeout = 5000");
    }
    migrateOpenBotSchema(this.db);
    this.now = options.now ?? (() => Date.now());
    this.sensitiveValues = options.sensitiveValues ?? (() => []);
    this.limits = {
      maxMessagesPerTurn: options.limits?.maxMessagesPerTurn ?? A2A_MAX_MESSAGES_PER_PARENT_TURN,
      maxBytesPerTurn: options.limits?.maxBytesPerTurn ?? A2A_MAX_BYTES_PER_PARENT_TURN,
      maxRecipientsPerTurn: options.limits?.maxRecipientsPerTurn ?? A2A_MAX_RECIPIENTS_PER_PARENT_TURN,
      maxPendingPerRecipient: options.limits?.maxPendingPerRecipient ?? A2A_MAX_PENDING_PER_RECIPIENT,
      maxAttempts: options.limits?.maxAttempts ?? A2A_MAX_DELIVERY_ATTEMPTS,
    };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("a2a: invalid limits");
  }

  private assertOpen(): void { if (this.closed) throw new Error("a2a: store is closed"); }

  private row(messageId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM a2a_messages WHERE message_id = ?").get(messageId) as Row | undefined;
  }

  private toRecord(row: Row): A2AMessageRecord {
    const parsed = parseA2AEnvelope({
      version: 1,
      messageId: row.message_id,
      senderAgentId: row.sender_agent_id,
      senderIncarnation: row.sender_incarnation,
      recipientAgentId: row.recipient_agent_id,
      recipientIncarnation: row.recipient_incarnation,
      nonce: row.nonce,
      parentTaskId: row.parent_task_id,
      parentTurnId: row.parent_turn_id,
      priority: row.priority,
      hopCount: row.hop_count,
      payload: JSON.parse(row.payload_json),
      createdAtMs: row.created_at_ms,
      availableAtMs: row.available_at_ms,
      expiresAtMs: row.expires_at_ms,
    });
    return {
      messageId: parsed.messageId,
      senderAgentId: parsed.senderAgentId,
      senderIncarnation: parsed.senderIncarnation,
      recipientAgentId: parsed.recipientAgentId,
      recipientIncarnation: parsed.recipientIncarnation,
      nonce: parsed.nonce,
      parentTaskId: parsed.parentTaskId,
      parentTurnId: parsed.parentTurnId,
      priority: parsed.priority,
      hopCount: parsed.hopCount,
      payload: parsed.payload,
      createdAtMs: parsed.createdAtMs,
      availableAtMs: parsed.availableAtMs,
      expiresAtMs: parsed.expiresAtMs,
      version: row.version,
      status: row.status,
      attempt: row.attempt,
      ackNonce: row.ack_nonce,
      ...(row.ack_nonce === null ? {} : { ack: { ackNonce: row.ack_nonce } }),
      terminalReason: row.terminal_reason,
      leaseOwner: row.lease_owner,
      leaseExpiresAtMs: row.lease_expires_at_ms,
    };
  }

  private appendTransition(messageId: string, eventKind: string, createdAtMs = nowValue(this.now)): void {
    const row = this.row(messageId);
    if (row === undefined) return;
    // Heartbeats are replaceable lease snapshots, not an unbounded audit log.
    // Compact the prior heartbeat in the same surrounding transaction. A
    // skipped projection sequence is safe because reconnect detects the gap
    // and rebuilds from the authoritative SQLite message snapshot.
    this.db.prepare("DELETE FROM a2a_projection_outbox WHERE message_id = ? AND event_kind = 'heartbeat'").run(messageId);
    this.db.prepare("DELETE FROM a2a_outbox WHERE message_id = ? AND event_kind = 'heartbeat'").run(messageId);
    const record = this.toRecord(row);
    const outboxId = randomUUID();
    const inserted = this.db.prepare("INSERT OR IGNORE INTO a2a_outbox(outbox_id, message_id, transition_version, event_kind, recipient_agent_id, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run(outboxId, messageId, row.version, eventKind, row.recipient_agent_id, JSON.stringify(record), createdAtMs);
    if (inserted.changes !== 1) return;
    const projection = this.db.prepare("SELECT epoch, next_sequence FROM a2a_projection_state WHERE agent_id = ?").get(row.recipient_agent_id) as { epoch: string; next_sequence: number } | undefined;
    const epoch = projection?.epoch ?? randomUUID();
    const sequence = projection?.next_sequence ?? 1;
    this.db.prepare("INSERT INTO a2a_projection_state(agent_id, epoch, next_sequence) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET next_sequence = excluded.next_sequence").run(row.recipient_agent_id, epoch, sequence + 1);
    this.db.prepare("INSERT INTO a2a_projection_outbox(projection_id, source_outbox_id, message_id, agent_id, epoch, sequence, transition_version, event_kind, payload_json, created_at_ms, delivered_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run(randomUUID(), outboxId, messageId, row.recipient_agent_id, epoch, sequence, row.version, eventKind, JSON.stringify(record), createdAtMs);
  }

  private settleRetiredRecipientProjections(agentId: string, incarnation: string, deliveredAtMs: number): void {
    this.db.prepare(`UPDATE a2a_projection_outbox SET delivered_at_ms = ?
      WHERE delivered_at_ms IS NULL AND message_id IN (
        SELECT message_id FROM a2a_messages
        WHERE recipient_agent_id = ? AND recipient_incarnation = ?
      )`).run(deliveredAtMs, agentId, incarnation);
    this.db.prepare(`UPDATE a2a_outbox SET delivered_at_ms = ?
      WHERE delivered_at_ms IS NULL AND message_id IN (
        SELECT message_id FROM a2a_messages
        WHERE recipient_agent_id = ? AND recipient_incarnation = ?
      )`).run(deliveredAtMs, agentId, incarnation);
  }

  ensureAgentIncarnation(agentId: string): string {
    this.assertOpen();
    const ensure = this.db.transaction(() => {
      const current = this.db.prepare("SELECT incarnation FROM a2a_agent_incarnations WHERE agent_id = ? AND status = 'active'").get(agentId) as { incarnation: string } | undefined;
      if (current !== undefined) return current.incarnation;
      const recreating = this.db.prepare("SELECT 1 FROM a2a_agent_incarnations WHERE agent_id = ? AND status = 'retired' LIMIT 1").get(agentId) !== undefined;
      const incarnation = randomUUID();
      const now = nowValue(this.now);
      this.db.prepare("INSERT INTO a2a_agent_incarnations(agent_id, incarnation, status, created_at_ms) VALUES (?, ?, 'active', ?)").run(agentId, incarnation, now);
      if (recreating) {
        this.db.prepare("INSERT INTO a2a_projection_state(agent_id, epoch, next_sequence) VALUES (?, ?, 1) ON CONFLICT(agent_id) DO UPDATE SET epoch = excluded.epoch, next_sequence = 1").run(agentId, randomUUID());
      }
      return incarnation;
    });
    return ensure.immediate();
  }

  syncActiveAgents(agentIds: readonly string[]): void {
    this.assertOpen();
    const active = new Set(agentIds);
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT agent_id FROM a2a_agent_incarnations WHERE status = 'active'").all() as Array<{ agent_id: string }>;
      const now = nowValue(this.now);
      for (const row of rows) if (!active.has(row.agent_id)) {
        const incarnation = this.db.prepare("SELECT incarnation FROM a2a_agent_incarnations WHERE agent_id = ? AND status = 'active'").get(row.agent_id) as { incarnation: string } | undefined;
        if (incarnation === undefined) continue;
        this.db.prepare("UPDATE a2a_agent_incarnations SET status = 'retired', retired_at_ms = ? WHERE agent_id = ? AND incarnation = ?").run(now, row.agent_id, incarnation.incarnation);
        const affected = this.db.prepare("SELECT message_id FROM a2a_messages WHERE (recipient_agent_id = ? AND recipient_incarnation = ? OR sender_agent_id = ? AND sender_incarnation = ?) AND status IN ('queued', 'delivering')").all(row.agent_id, incarnation.incarnation, row.agent_id, incarnation.incarnation) as Array<{ message_id: string }>;
        this.db.prepare("UPDATE a2a_messages SET status = 'cancelled', version = version + 1, terminal_reason = 'agent-retired', lease_owner = NULL, lease_expires_at_ms = NULL WHERE (recipient_agent_id = ? AND recipient_incarnation = ? OR sender_agent_id = ? AND sender_incarnation = ?) AND status IN ('queued', 'delivering')").run(row.agent_id, incarnation.incarnation, row.agent_id, incarnation.incarnation);
        for (const message of affected) this.appendTransition(message.message_id, "cancelled", now);
        this.settleRetiredRecipientProjections(row.agent_id, incarnation.incarnation, now);
      }
      for (const agentId of active) this.ensureAgentIncarnation(agentId);
    }).immediate();
  }

  fenceAgent(agentId: string): void {
    this.assertOpen();
    this.db.prepare("INSERT INTO a2a_agent_fences(agent_id, fenced_at_ms) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET fenced_at_ms = excluded.fenced_at_ms").run(agentId, nowValue(this.now));
  }

  clearAgentFence(agentId: string): void {
    this.assertOpen();
    this.db.prepare("DELETE FROM a2a_agent_fences WHERE agent_id = ?").run(agentId);
  }

  retireAgent(agentId: string): void {
    this.assertOpen();
    const retire = this.db.transaction(() => {
      const now = nowValue(this.now);
      const active = this.db.prepare("SELECT incarnation FROM a2a_agent_incarnations WHERE agent_id = ? AND status = 'active'").get(agentId) as { incarnation: string } | undefined;
      if (active === undefined) return;
      this.db.prepare("UPDATE a2a_agent_incarnations SET status = 'retired', retired_at_ms = ? WHERE agent_id = ? AND incarnation = ?").run(now, agentId, active.incarnation);
      const affected = this.db.prepare("SELECT message_id FROM a2a_messages WHERE (recipient_agent_id = ? AND recipient_incarnation = ? OR sender_agent_id = ? AND sender_incarnation = ?) AND status IN ('queued', 'delivering')").all(agentId, active.incarnation, agentId, active.incarnation) as Array<{ message_id: string }>;
      this.db.prepare("UPDATE a2a_messages SET status = 'cancelled', version = version + 1, terminal_reason = 'agent-retired', lease_owner = NULL, lease_expires_at_ms = NULL WHERE (recipient_agent_id = ? AND recipient_incarnation = ? OR sender_agent_id = ? AND sender_incarnation = ?) AND status IN ('queued', 'delivering')").run(agentId, active.incarnation, agentId, active.incarnation);
      for (const message of affected) this.appendTransition(message.message_id, "cancelled", now);
      this.settleRetiredRecipientProjections(agentId, active.incarnation, now);
    });
    retire.immediate();
  }

  send(input: A2ASendInput, options: { expectedRecipientIncarnation?: string } = {}): A2ASendResult {
    this.assertOpen();
    const parsed = parseA2ASendInput(input);
    const send = this.db.transaction(() => {
      const sender = this.db.prepare("SELECT incarnation FROM a2a_agent_incarnations WHERE agent_id = ? AND status = 'active'").get(parsed.senderAgentId) as { incarnation: string } | undefined;
      const recipient = this.db.prepare("SELECT incarnation FROM a2a_agent_incarnations WHERE agent_id = ? AND status = 'active'").get(parsed.recipientAgentId) as { incarnation: string } | undefined;
      if (sender === undefined || recipient === undefined) throw new Error("a2a: sender or recipient is not active");
      if (options.expectedRecipientIncarnation !== undefined && options.expectedRecipientIncarnation !== recipient.incarnation) throw new Error("a2a: recipient incarnation mismatch");
      if (this.db.prepare("SELECT 1 FROM a2a_agent_fences WHERE agent_id IN (?, ?) LIMIT 1").get(parsed.senderAgentId, parsed.recipientAgentId) !== undefined) throw new Error("a2a: sender or recipient is fenced");
      if (parsed.parentTaskId !== null) {
        const task = this.db.prepare("SELECT 1 FROM async_tasks WHERE task_id = ? AND agent_id = ? AND parent_turn_id = ?").get(parsed.parentTaskId, parsed.senderAgentId, parsed.parentTurnId);
        if (task === undefined) throw new Error("a2a: parent task does not belong to sender/turn");
      }
      const existingRow = this.db.prepare("SELECT * FROM a2a_messages WHERE sender_agent_id = ? AND sender_incarnation = ? AND nonce = ?").get(parsed.senderAgentId, sender.incarnation, parsed.nonce) as Row | undefined;
      if (existingRow !== undefined) {
        const existing = this.toRecord(existingRow);
        if (messageComparable(existing) !== JSON.stringify({ senderAgentId: parsed.senderAgentId, recipientAgentId: parsed.recipientAgentId, parentTaskId: parsed.parentTaskId, parentTurnId: parsed.parentTurnId, priority: parsed.priority, hopCount: parsed.hopCount, payload: parsed.payload })) throw new Error("a2a: conflicting nonce");
        return { created: false, duplicate: true, message: existing } satisfies A2ASendResult;
      }
      const payloadBytes = jsonBytes(parsed.payload);
      const envelopeBytes = jsonBytes({ ...parsed, senderIncarnation: sender.incarnation, recipientIncarnation: recipient.incarnation });
      if (payloadBytes > A2A_MAX_PAYLOAD_BYTES || envelopeBytes > A2A_MAX_ENVELOPE_BYTES || parsed.hopCount > A2A_MAX_HOPS) throw new A2AContractError("a2a: cap exceeded");
      const secret = this.sensitiveValues().filter((value) => typeof value === "string" && value.length > 0).find((value) => JSON.stringify(parsed.payload).toLowerCase().includes(value.toLowerCase()));
      if (secret !== undefined) throw new Error("a2a: sensitive value in payload");
      const usage = this.db.prepare("SELECT message_count, byte_count, recipients_json FROM a2a_parent_usage WHERE sender_agent_id = ? AND sender_incarnation = ? AND parent_turn_id = ?").get(parsed.senderAgentId, sender.incarnation, parsed.parentTurnId) as { message_count: number; byte_count: number; recipients_json: string } | undefined;
      const recipients = usage === undefined ? [] as string[] : JSON.parse(usage.recipients_json) as string[];
      if ((usage?.message_count ?? 0) + 1 > this.limits.maxMessagesPerTurn || (usage?.byte_count ?? 0) + payloadBytes > this.limits.maxBytesPerTurn || (!recipients.includes(parsed.recipientAgentId) && recipients.length + 1 > this.limits.maxRecipientsPerTurn)) throw new Error("a2a: parent turn limit exceeded");
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM a2a_messages WHERE recipient_agent_id = ? AND recipient_incarnation = ? AND status IN ('queued', 'delivering')").get(parsed.recipientAgentId, recipient.incarnation) as { count: number };
      if (pending.count + 1 > this.limits.maxPendingPerRecipient) throw new Error("a2a: recipient pending cap exceeded");
      const now = nowValue(this.now);
      const record = { ...parsed, senderIncarnation: sender.incarnation, recipientIncarnation: recipient.incarnation };
      parseA2AEnvelope(record);
      this.db.prepare(`INSERT INTO a2a_messages(message_id, sender_agent_id, sender_incarnation, recipient_agent_id, recipient_incarnation, nonce, parent_task_id, parent_turn_id, priority, hop_count, payload_json, created_at_ms, available_at_ms, expires_at_ms, status, attempt, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 1)`).run(record.messageId, record.senderAgentId, record.senderIncarnation, record.recipientAgentId, record.recipientIncarnation, record.nonce, record.parentTaskId, record.parentTurnId, record.priority, record.hopCount, JSON.stringify(record.payload), record.createdAtMs, record.availableAtMs, record.expiresAtMs);
      const nextRecipients = [...new Set([...recipients, parsed.recipientAgentId])];
      this.db.prepare("INSERT INTO a2a_parent_usage(sender_agent_id, sender_incarnation, parent_turn_id, message_count, byte_count, recipients_json) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(sender_agent_id, sender_incarnation, parent_turn_id) DO UPDATE SET message_count = message_count + 1, byte_count = byte_count + excluded.byte_count, recipients_json = excluded.recipients_json").run(parsed.senderAgentId, sender.incarnation, parsed.parentTurnId, payloadBytes, JSON.stringify(nextRecipients));
      this.appendTransition(record.messageId, "queued", now);
      return { created: true, message: this.toRecord(this.row(record.messageId)!) } satisfies A2ASendResult;
    });
    return send.immediate();
  }

  getMessage(messageId: string): A2AMessageRecord | undefined {
    this.assertOpen();
    const row = this.row(messageId);
    return row === undefined ? undefined : this.toRecord(row);
  }

  getMessageForRecipient(agentId: string, messageId: string): A2AMessageRecord | undefined {
    this.assertOpen();
    const row = this.db.prepare(`SELECT message.* FROM a2a_messages AS message
      JOIN a2a_agent_incarnations AS incarnation
        ON incarnation.agent_id = message.recipient_agent_id
       AND incarnation.incarnation = message.recipient_incarnation
       AND incarnation.status = 'active'
      WHERE message.message_id = ? AND message.recipient_agent_id = ?`).get(messageId, agentId) as Row | undefined;
    return row === undefined ? undefined : this.toRecord(row);
  }

  listForRecipient(agentId: string, limit = 128): A2AMessageRecord[] {
    this.assertOpen();
    const bounded = Math.max(1, Math.min(128, Math.trunc(limit)));
    return (this.db.prepare(`SELECT recent.* FROM (
      SELECT message.* FROM a2a_messages AS message
        JOIN a2a_agent_incarnations AS incarnation
          ON incarnation.agent_id = message.recipient_agent_id
         AND incarnation.incarnation = message.recipient_incarnation
         AND incarnation.status = 'active'
        WHERE message.recipient_agent_id = ?
        ORDER BY message.created_at_ms DESC, message.message_id DESC LIMIT ?
    ) AS recent ORDER BY recent.created_at_ms ASC, recent.message_id ASC`).all(agentId, bounded) as Row[]).map((row) => this.toRecord(row));
  }

  listUndeliveredOutbox(): unknown[] { this.assertOpen(); return this.db.prepare("SELECT * FROM a2a_outbox WHERE delivered_at_ms IS NULL ORDER BY created_at_ms ASC, outbox_id ASC").all(); }

  getParentTurnUsage(senderAgentId: string, parentTurnId: string): { messageCount: number; byteCount: number; recipients: string[] } {
    const incarnation = this.db.prepare("SELECT incarnation FROM a2a_agent_incarnations WHERE agent_id = ? AND status = 'active'").get(senderAgentId) as { incarnation: string } | undefined;
    const row = incarnation === undefined ? undefined : this.db.prepare("SELECT message_count, byte_count, recipients_json FROM a2a_parent_usage WHERE sender_agent_id = ? AND sender_incarnation = ? AND parent_turn_id = ?").get(senderAgentId, incarnation.incarnation, parentTurnId) as { message_count: number; byte_count: number; recipients_json: string } | undefined;
    return { messageCount: row?.message_count ?? 0, byteCount: row?.byte_count ?? 0, recipients: row === undefined ? [] : JSON.parse(row.recipients_json) as string[] };
  }

  claimNext(recipientAgentId: string, options: { ownerId: string; nowMs?: number; leaseDurationMs: number }): A2AClaimResult | undefined {
    this.assertOpen();
    const now = options.nowMs ?? nowValue(this.now);
    this.recoverExpired(now);
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT message.* FROM a2a_messages AS message
        JOIN a2a_agent_incarnations AS recipient
          ON recipient.agent_id = message.recipient_agent_id
         AND recipient.incarnation = message.recipient_incarnation
         AND recipient.status = 'active'
        JOIN a2a_agent_incarnations AS sender
          ON sender.agent_id = message.sender_agent_id
         AND sender.incarnation = message.sender_incarnation
         AND sender.status = 'active'
        WHERE message.recipient_agent_id = ? AND message.status = 'queued'
          AND message.available_at_ms <= ?
          AND (message.expires_at_ms IS NULL OR message.expires_at_ms > ?)
          AND NOT EXISTS (
            SELECT 1 FROM a2a_agent_fences AS fence
            WHERE fence.agent_id IN (message.sender_agent_id, message.recipient_agent_id)
          )
        ORDER BY CASE message.priority WHEN 'high' THEN 0 ELSE 1 END,
          message.created_at_ms ASC, message.message_id ASC LIMIT 1`).get(recipientAgentId, now, now) as Row | undefined;
      if (row === undefined) return undefined;
      const version = row.version + 1;
      const expires = now + options.leaseDurationMs;
      const changed = this.db.prepare("UPDATE a2a_messages SET status = 'delivering', attempt = attempt + 1, version = ?, lease_owner = ?, lease_expires_at_ms = ? WHERE message_id = ? AND status = 'queued' AND version = ?").run(version, options.ownerId, expires, row.message_id, row.version);
      if (changed.changes !== 1) return undefined;
      this.appendTransition(row.message_id, "delivering", now);
      const claimed = this.row(row.message_id)!;
      return { message: this.toRecord(claimed), lease: { ownerId: options.ownerId, expiresAtMs: expires, version } };
    });
    return claim.immediate();
  }

  recoverExpired(nowMs = nowValue(this.now)): A2AMessageRecord[] {
    this.assertOpen();
    const recover = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM a2a_messages WHERE (status = 'delivering' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?) OR (status = 'queued' AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?)").all(nowMs, nowMs) as Row[];
      const recovered: A2AMessageRecord[] = [];
      for (const row of rows) {
        let changed: Database.RunResult;
        if (row.status === "queued") {
          changed = this.db.prepare("UPDATE a2a_messages SET status = 'rejected', version = version + 1, terminal_reason = 'expired', lease_owner = NULL, lease_expires_at_ms = NULL WHERE message_id = ? AND status = 'queued' AND version = ?").run(row.message_id, row.version);
          if (changed.changes === 1) this.appendTransition(row.message_id, "rejected", nowMs);
        } else if (row.attempt >= this.limits.maxAttempts) {
          changed = this.db.prepare("UPDATE a2a_messages SET status = 'dead', version = version + 1, terminal_reason = 'attempt-cap', lease_owner = NULL, lease_expires_at_ms = NULL WHERE message_id = ? AND status = 'delivering' AND version = ?").run(row.message_id, row.version);
          if (changed.changes === 1) this.appendTransition(row.message_id, "dead", nowMs);
        } else {
          changed = this.db.prepare("UPDATE a2a_messages SET status = 'queued', version = version + 1, lease_owner = NULL, lease_expires_at_ms = NULL WHERE message_id = ? AND status = 'delivering' AND version = ?").run(row.message_id, row.version);
          if (changed.changes === 1) this.appendTransition(row.message_id, "requeued", nowMs);
        }
        if (changed.changes === 1) recovered.push(this.toRecord(this.row(row.message_id)!));
      }
      return recovered;
    });
    return recover.immediate();
  }

  ack(messageId: string, options: { ownerId: string; expectedVersion: number; status: "acked" | "dead"; ackNonce?: string }): A2AMessageRecord {
    this.assertOpen();
    const operation = this.db.transaction(() => {
      const current = this.row(messageId);
      if (current === undefined) throw new Error("a2a: message not found");
      if (current.status === "acked" && options.status === "acked" && current.ack_nonce === (options.ackNonce ?? null)) return this.toRecord(current);
      if (current.status !== "delivering" || current.lease_owner !== options.ownerId || current.version !== options.expectedVersion) throw new Error("a2a: stale ACK");
      const now = nowValue(this.now);
      const changed = this.db.prepare("UPDATE a2a_messages SET status = ?, version = version + 1, ack_nonce = ?, ack_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL, terminal_reason = ? WHERE message_id = ? AND status = 'delivering' AND lease_owner = ? AND version = ?").run(options.status, options.ackNonce ?? null, now, options.status === "dead" ? "consumer-dead" : null, messageId, options.ownerId, options.expectedVersion);
      if (changed.changes !== 1) throw new Error("a2a: stale ACK");
      this.appendTransition(messageId, options.status, now);
      return this.toRecord(this.row(messageId)!);
    });
    return operation.immediate();
  }

  retry(messageId: string, options: { ownerId: string; expectedVersion: number; availableAtMs?: number }): A2AMessageRecord {
    this.assertOpen();
    const operation = this.db.transaction(() => {
      const current = this.row(messageId);
      if (current === undefined) throw new Error("a2a: message not found");
      if (current.attempt >= this.limits.maxAttempts) {
        throw new Error("a2a: attempt cap reached");
      }
      const now = options.availableAtMs ?? nowValue(this.now);
      const updated = this.db.prepare("UPDATE a2a_messages SET status = 'queued', version = version + 1, available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL WHERE message_id = ? AND status = 'delivering' AND lease_owner = ? AND version = ?").run(now, messageId, options.ownerId, options.expectedVersion);
      if (updated.changes !== 1) throw new Error("a2a: stale retry");
      this.appendTransition(messageId, "requeued", now);
      return this.toRecord(this.row(messageId)!);
    });
    return operation.immediate();
  }

  heartbeat(messageId: string, options: { ownerId: string; expectedVersion: number; leaseDurationMs: number; nowMs?: number }): A2AMessageRecord {
    this.assertOpen();
    const operation = this.db.transaction(() => {
      const now = options.nowMs ?? nowValue(this.now);
      const expires = now + options.leaseDurationMs;
      const updated = this.db.prepare("UPDATE a2a_messages SET lease_expires_at_ms = ?, version = version + 1 WHERE message_id = ? AND status = 'delivering' AND lease_owner = ? AND version = ?").run(expires, messageId, options.ownerId, options.expectedVersion);
      if (updated.changes !== 1) throw new Error("a2a: stale heartbeat");
      this.appendTransition(messageId, "heartbeat", now);
      return this.toRecord(this.row(messageId)!);
    });
    return operation.immediate();
  }

  getSnapshot(agentId: string): A2AStoreSnapshot {
    this.assertOpen();
    const operation = this.db.transaction(() => {
      const projection = this.db.prepare("SELECT epoch, next_sequence FROM a2a_projection_state WHERE agent_id = ?").get(agentId) as { epoch: string; next_sequence: number } | undefined;
      const epoch = projection?.epoch ?? randomUUID();
      const nextSequence = projection?.next_sequence ?? 1;
      if (projection === undefined) this.db.prepare("INSERT INTO a2a_projection_state(agent_id, epoch, next_sequence) VALUES (?, ?, 1)").run(agentId, epoch);
      const rows = this.db.prepare(`SELECT recent.* FROM (
        SELECT message.* FROM a2a_messages AS message
          JOIN a2a_agent_incarnations AS incarnation
            ON incarnation.agent_id = message.recipient_agent_id
           AND incarnation.incarnation = message.recipient_incarnation
           AND incarnation.status = 'active'
          WHERE message.recipient_agent_id = ?
          ORDER BY message.created_at_ms DESC, message.message_id DESC LIMIT 128
      ) AS recent ORDER BY recent.created_at_ms ASC, recent.message_id ASC`).all(agentId) as Row[];
      return { agentId, epoch, sequence: Math.max(0, nextSequence - 1), items: rows.map((row) => this.toRecord(row)) };
    });
    return operation.immediate();
  }

  projectUndelivered(limit = 100): A2AProjectionEnvelope[] {
    this.assertOpen();
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db.prepare(`SELECT projection.* FROM a2a_projection_outbox AS projection
      JOIN a2a_messages AS message ON message.message_id = projection.message_id
      JOIN a2a_agent_incarnations AS recipient
        ON recipient.agent_id = message.recipient_agent_id
       AND recipient.incarnation = message.recipient_incarnation
       AND recipient.status = 'active'
      WHERE projection.delivered_at_ms IS NULL
      ORDER BY projection.created_at_ms ASC, projection.agent_id ASC, projection.epoch ASC, projection.sequence ASC
      LIMIT ?`).all(bounded) as ProjectionRow[];
    return rows.map((row) => ({
      projectionId: row.projection_id,
      sourceOutboxId: row.source_outbox_id,
      agentId: row.agent_id,
      epoch: row.epoch,
      sequence: row.sequence,
      messageId: row.message_id,
      transitionVersion: row.transition_version,
      eventKind: row.event_kind,
      payload: parseProjectionRecord(JSON.parse(row.payload_json)),
    }));
  }

  acknowledgeProjection(projectionId: string, accepted: boolean, deliveredAtMs = nowValue(this.now)): boolean {
    this.assertOpen();
    if (!accepted) return false;
    const operation = this.db.transaction(() => {
      const projection = this.db.prepare("SELECT source_outbox_id FROM a2a_projection_outbox WHERE projection_id = ? AND delivered_at_ms IS NULL").get(projectionId) as { source_outbox_id: string } | undefined;
      if (projection === undefined) return false;
      const changed = this.db.prepare("UPDATE a2a_projection_outbox SET delivered_at_ms = ? WHERE projection_id = ? AND delivered_at_ms IS NULL").run(deliveredAtMs, projectionId);
      if (changed.changes !== 1) return false;
      this.db.prepare("UPDATE a2a_outbox SET delivered_at_ms = ? WHERE outbox_id = ? AND delivered_at_ms IS NULL").run(deliveredAtMs, projection.source_outbox_id);
      return true;
    });
    return operation.immediate();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) this.db.close();
  }
}
