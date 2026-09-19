/**
 * P2.3 — server-side attachment staging authority.
 *
 * The renderer never supplies a trusted path, MIME, extension or bytes-for-
 * send. It stages bytes through an opaque flow and receives back only an
 * opaque `attachment:<id>` reference; everything else is revalidated here at
 * commit/send time.
 *
 * A staged record persists in SQLite (the durable ledger) while the bytes
 * live on disk under a controlled staging root never addressable by the
 * renderer. The store enforces: owner-agent and optional conversation
 * binding (foreign access hides), sanitized filenames, kind detection from
 * magic bytes (never the renderer extension), per-kind/per-turn/aggregate
 * byte+count caps, SHA-256 recorded at stage time and rechecked against the
 * on-disk file at commit/send (a swapped file is rejected), an expiry sweep,
 * and a strict state machine staged -> committed -> consumed.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { basename, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { extractPdfText } from "../rpc/attachments.js";
import { writeFileExclusive } from "../shared/fs-atomic.js";

export const STAGED_PATH_PREFIX = "attachment:";
/** Default lifetime for a staged attachment before the sweep discards it. */
export const STAGING_LIFETIME_MS = 15 * 60_000;
export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_PDF_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 16;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 4 * 1024 * 1024;
/** Bounds the staging pool per agent so abandoned staging cannot grow unbounded. */
export const MAX_STAGED_PER_AGENT = 32;
export const MAX_STAGED_BYTES_PER_AGENT = 32 * 1024 * 1024;
export const MAX_FILENAME_BYTES = 200;

export type AttachmentKind = "text" | "pdf" | "image";
export type AttachmentState = "staged" | "committed" | "discarded";

export interface StagedAttachmentRecord {
  id: string;
  agentId: string;
  conversationId: string | null;
  filename: string;
  kind: AttachmentKind;
  mime: string;
  storedPath: string;
  sizeBytes: number;
  sha256: string;
  createdAtMs: number;
  expiresAtMs: number;
  state: AttachmentState;
  consumedAtMs: number | null;
}

export interface StageAttachmentInput {
  filename: string;
  bytes: Buffer;
  conversationId?: string;
}

export interface ResolvedStagedAttachment {
  id: string;
  filename: string;
  kind: AttachmentKind;
  mime: string;
  sizeBytes: number;
  sha256: string;
  /** Extracted UTF-8 text for text/PDF kinds. */
  text?: string;
  /** Data URL carrying image bytes for providers that declare images. */
  imageDataUrl?: string;
  displayName: string;
}

export interface ResolveOutcome {
  /** Opaque staged attachments that passed revalidation. */
  attachments: ResolvedStagedAttachment[];
  /** Skipped entries (opaque ref, rejected/expired/etc.). */
  skipped: Array<{ ref: string; reason: string }>;
}

export interface ReadStagedOptions {
  conversationId?: string;
  /** The transcript transaction will claim consumption after reading succeeds. */
  deferConsumption?: boolean;
  /** Server-authorized retry of the original turn may reread retained images. */
  retry?: boolean;
  /** When true, images are read as data URLs (only for image-capable providers). */
  providerSupportsImages: boolean;
}

export interface StagingFileSystem {
  lstat(path: string): ReturnType<typeof fsp.lstat>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
}

/** Sanitizes a renderer-supplied filename into a safe display name. */
export function sanitizeDisplayFilename(raw: string): string {
  if (typeof raw !== "string") return "attachment";
  const base0 = raw.split(/[\\/]/).pop() ?? "";
  const base = base0.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (base.length === 0) return "attachment";
  const safe = base.replace(/[^A-Za-z0-9._\- ]/g, "_").trim();
  const trimmed = safe.length > MAX_FILENAME_BYTES ? safe.slice(0, MAX_FILENAME_BYTES) : safe;
  return trimmed.length === 0 ? "attachment" : trimmed;
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface DetectedKind { kind: AttachmentKind; mime: string; }

/** Detects kind/MIME from magic bytes. Never trusts the renderer extension. */
export function detectAttachmentKind(bytes: Buffer): DetectedKind | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { kind: "pdf", mime: "application/pdf" };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) {
    return { kind: "image", mime: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "image", mime: "image/jpeg" };
  }
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")) {
    return { kind: "image", mime: "image/gif" };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return { kind: "image", mime: "image/webp" };
  }
  const decoded = bytes.toString("utf8");
  if (!decoded.includes(String.fromCharCode(0xfffd))) {
    let printable = 0;
    let total = 0;
    for (const line of decoded) {
      total += 1;
      const code = line.codePointAt(0) ?? 0;
      const control = code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
      if (control) printable += 1;
    }
    const score = total === 0 ? 1 : printable / total;
    if (score >= 0.9 && bytes.length > 0) return { kind: "text", mime: "text/plain" };
  }
  return null;
}

export function kindMaxBytes(kind: AttachmentKind): number {
  switch (kind) {
    case "text": return MAX_TEXT_ATTACHMENT_BYTES;
    case "pdf": return MAX_PDF_ATTACHMENT_BYTES;
    case "image": return MAX_IMAGE_ATTACHMENT_BYTES;
  }
}

interface StagingRow {
  id: string; agent_id: string; conversation_id: string | null;
  filename: string; kind: AttachmentKind; stored_path: string;
  size_bytes: number; sha256: string; created_at_ms: number;
  expires_at_ms: number; state: AttachmentState; consumed_at_ms: number | null;
}

function fromRow(row: StagingRow, root: string): StagedAttachmentRecord {
  // Backups can reopen under a different data root. Only relocate the exact
  // host-generated filename; commit/send still verify ownership and SHA-256.
  const filename = basename(row.stored_path);
  const storedPath = filename === `${row.id}.${extForKind(row.kind)}`
    ? join(root, filename) : row.stored_path;
  return {
    id: row.id, agentId: row.agent_id, conversationId: row.conversation_id,
    filename: row.filename, kind: row.kind, mime: mimeForKind(row.kind),
    storedPath, sizeBytes: row.size_bytes, sha256: row.sha256,
    createdAtMs: row.created_at_ms, expiresAtMs: row.expires_at_ms,
    state: row.state, consumedAtMs: row.consumed_at_ms,
  };
}

function mimeForKind(kind: AttachmentKind): string {
  switch (kind) {
    case "text": return "text/plain";
    case "pdf": return "application/pdf";
    case "image": return "image/png";
  }
}

export class AttachmentStagingStore {
  private readonly db: Database.Database;
  readonly root: string;
  private readonly nowFn: () => number;
  private readonly fileSystem: StagingFileSystem;
  private readonly stageTails = new Map<string, Promise<void>>();
  private readonly statements: {
    insert: Database.Statement;
    getById: Database.Statement;
    listActive: Database.Statement;
    listActiveByConversation: Database.Statement;
    setCommitted: Database.Statement;
    setConsumed: Database.Statement;
    setDiscarded: Database.Statement;
    setExpired: Database.Statement;
    countActiveByAgent: Database.Statement;
    sumBytesByAgent: Database.Statement;
    listExpired: Database.Statement;
    listByAgent: Database.Statement;
    deleteByAgent: Database.Statement;
  };

  constructor(options: { db: Database.Database; root: string; nowFn?: () => number; fileSystem?: StagingFileSystem }) {
    if (typeof options.root !== "string" || options.root.length === 0) {
      throw new Error("attachment staging: root é obrigatório");
    }
    this.db = options.db;
    this.root = resolve(options.root);
    this.nowFn = options.nowFn ?? Date.now;
    this.fileSystem = options.fileSystem ?? {
      lstat: (path) => fsp.lstat(path),
      realpath: (path) => fsp.realpath(path),
      readFile: (path) => fsp.readFile(path),
    };
    const s = (sql: string) => this.db.prepare(sql);
    this.statements = {
      insert: s("INSERT INTO attachment_staging (id, agent_id, conversation_id, filename, kind, stored_path, size_bytes, sha256, created_at_ms, expires_at_ms, state, consumed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', NULL)"),
      getById: s("SELECT * FROM attachment_staging WHERE id = ?"),
      listActive: s("SELECT * FROM attachment_staging WHERE agent_id = ? AND state != 'discarded' ORDER BY created_at_ms ASC, id ASC"),
      listActiveByConversation: s("SELECT * FROM attachment_staging WHERE agent_id = ? AND conversation_id = ? AND state != 'discarded' ORDER BY created_at_ms ASC, id ASC"),
      setCommitted: s("UPDATE attachment_staging SET state = 'committed' WHERE id = ? AND agent_id = ? AND state = 'staged'"),
      setConsumed: s("UPDATE attachment_staging SET state = 'committed', consumed_at_ms = ? WHERE id = ? AND agent_id = ? AND state != 'discarded' AND consumed_at_ms IS NULL"),
      setDiscarded: s("UPDATE attachment_staging SET state = 'discarded' WHERE id = ? AND agent_id = ? AND state = 'staged' AND consumed_at_ms IS NULL"),
      setExpired: s("UPDATE attachment_staging SET state = 'discarded' WHERE id = ? AND agent_id = ? AND expires_at_ms <= ?"),
      countActiveByAgent: s("SELECT COUNT(*) AS c FROM attachment_staging WHERE agent_id = ? AND state != 'discarded' AND (consumed_at_ms IS NULL OR kind = 'image')"),
      sumBytesByAgent: s("SELECT COALESCE(SUM(size_bytes), 0) AS s FROM attachment_staging WHERE agent_id = ? AND state != 'discarded' AND (consumed_at_ms IS NULL OR kind = 'image')"),
      listExpired: s("SELECT * FROM attachment_staging WHERE state != 'discarded' AND expires_at_ms <= ?"),
      listByAgent: s("SELECT * FROM attachment_staging WHERE agent_id = ?"),
      deleteByAgent: s("DELETE FROM attachment_staging WHERE agent_id = ?"),
    };
  }

  private async deleteBytes(id: string, storedPath: string, strict = false): Promise<void> {
    const target = resolve(storedPath);
    if (!this.ownedPath(target)) {
      if (strict) throw new Error(`attachment staging: caminho fora da raiz (${id})`);
      return;
    }
    try {
      await fsp.rm(target, { force: true });
    } catch (error) {
      if (strict) throw error;
      // Expiry/discard cleanup is best effort; deletion reconciliation uses
      // the strict path below so failed bytes remain referenced for retry.
    }
  }

  private ownedPath(target: string): boolean {
    const base = resolve(this.root);
    const resolved = resolve(target);
    return resolved === base || resolved.startsWith(base + "\\") || resolved.startsWith(base + "/");
  }

  private async withAgentStageLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.stageTails.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = prior.then(() => gate);
    this.stageTails.set(agentId, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.stageTails.get(agentId) === tail) this.stageTails.delete(agentId);
    }
  }

  /** Sweeps and discards expired staged attachments along with their bytes. */
  expireDue(): number {
    const now = this.nowFn();
    const rows = this.statements.listExpired.all(now) as StagingRow[];
    for (const row of rows) {
      this.statements.setExpired.run(row.id, row.agent_id, now);
      void this.deleteBytes(row.id, fromRow(row, this.root).storedPath);
    }
    return rows.length;
  }

  /**
   * Stages bytes and returns the persisted opaque record. Rejects when the
   * detected kind is unsupported, a per-kind byte cap is exceeded, the agent
   * exceeds its staging pool bounds, or the bytes are not a decodable
   * text/PDF/image payload.
   */
  async stageBytes(agentId: string, input: StageAttachmentInput): Promise<StagedAttachmentRecord> {
    if (typeof agentId !== "string" || agentId.trim().length === 0) throw new Error("agentId inválido");
    const filename = sanitizeDisplayFilename(input.filename);
    const bytes = input.bytes;
    if (!Buffer.isBuffer(bytes)) throw new Error("bytes inválido");
    if (bytes.length === 0) throw new Error("attachment vazio");
    const detected = detectAttachmentKind(bytes);
    if (detected === null) throw new Error("unsupported_media");
    if (bytes.length > kindMaxBytes(detected.kind)) throw new Error("attachment_too_large");
    if (typeof input.conversationId === "string" && input.conversationId.length === 0) throw new Error("conversationId inválido");

    return this.withAgentStageLock(agentId, async () => {
      this.expireDue();
      const current = this.statements.countActiveByAgent.get(agentId) as { c: number };
      if (current.c >= MAX_STAGED_PER_AGENT) throw new Error("staging_pool_exceeded");
      const aggregate = this.statements.sumBytesByAgent.get(agentId) as { s: number };
      if (aggregate.s + bytes.length > MAX_STAGED_BYTES_PER_AGENT) throw new Error("staging_bytes_exceeded");

      const id = "att-" + randomUUID();
      const ext = "." + extForKind(detected.kind);
      const storedPath = resolve(join(this.root, id + ext));
      await fsp.mkdir(this.root, { recursive: true });
      try {
        await writeFileExclusive(storedPath, bytes);
        const now = this.nowFn();
        this.statements.insert.run(id, agentId, input.conversationId ?? null, filename, detected.kind, storedPath, bytes.length, sha256Of(bytes), now, now + STAGING_LIFETIME_MS);
        return fromRow(this.statements.getById.get(id) as StagingRow, this.root);
      } catch (error) {
        await this.deleteBytes(id, storedPath);
        throw error;
      }
    });
  }

  get(agentId: string, id: string): StagedAttachmentRecord | null {
    if (typeof id !== "string" || id.length === 0) return null;
    this.expireDue();
    const row = this.statements.getById.get(id) as StagingRow | undefined;
    if (row === undefined) return null;
    if (row.agent_id !== agentId) return null;
    return fromRow(row, this.root);
  }

  listActive(agentId: string, conversationId?: string): readonly StagedAttachmentRecord[] {
    this.expireDue();
    const rows = (conversationId === undefined
      ? this.statements.listActive.all(agentId)
      : this.statements.listActiveByConversation.all(agentId, conversationId)) as StagingRow[];
    return rows.filter((row) => row.agent_id === agentId).map((row) => fromRow(row, this.root));
  }

  async commit(agentId: string, id: string): Promise<boolean> {
    const record = this.get(agentId, id);
    if (record === null) return false;
    if (record.state !== "staged") return false;
    if ((await this.revalidate(record)) === null) return false;
    const claimed = this.statements.setCommitted.run(id, agentId);
    return claimed.changes === 1;
  }

  /**
   * Discards an attachment idempotently. Only unconfirmed (staged) entries
   * are discardable; a committed (Escape/pagehide/cancel path) or consumed
   * entry is not. Expired entries, including retained images, are swept.
   */
  async discard(agentId: string, id: string): Promise<boolean> {
    const record = this.get(agentId, id);
    if (record === null) return false;
    if (record.state === "discarded") return true;
    if (record.state !== "staged") return false;
    if (record.consumedAtMs !== null) return false;
    const claimed = this.statements.setDiscarded.run(id, agentId);
    if (claimed.changes !== 1) return false;
    await this.deleteBytes(id, record.storedPath);
    return true;
  }

  /** Removes every staged byte before deleting references for agent deletion. */
  async purgeAgent(agentId: string): Promise<number> {
    return this.withAgentStageLock(agentId, async () => {
      const rows = this.statements.listByAgent.all(agentId) as StagingRow[];
      for (const row of rows) {
        await this.deleteBytes(row.id, fromRow(row, this.root).storedPath, true);
      }
      this.db.transaction(() => this.statements.deleteByAgent.run(agentId))();
      return rows.length;
    });
  }

  private async revalidate(record: StagedAttachmentRecord): Promise<Buffer | null> {
    if (record.state === "discarded") return null;
    if (this.nowFn() > record.expiresAtMs) return null;
    if (!this.ownedPath(record.storedPath)) return null;
    // Symlink / junction / reparse defense: the staged on-disk file must be a
    // regular file whose canonical realpath stays inside the controlled root.
    try {
      const stat = await this.fileSystem.lstat(record.storedPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const real = await this.fileSystem.realpath(record.storedPath);
      if (!this.ownedPath(real)) return null;
    } catch {
      return null;
    }
    let bytes: Buffer;
    try { bytes = await this.fileSystem.readFile(record.storedPath); } catch { return null; }
    if (bytes.length !== record.sizeBytes) return null;
    if (sha256Of(bytes) !== record.sha256) return null;
    return bytes;
  }

  /**
   * Resolves and consumes opaque `attachment:<id>` references for one send.
   * Revalidates each staged entry; rejects foreign/expired/consumed/missing
   * entries with a skipped reason. Enforces per-turn count and aggregate byte
   * caps. Images are only surfaced as data URLs when the provider/model
   * declares image support.
   */
  async resolveForSend(agentId: string, refs: readonly string[], options: ReadStagedOptions): Promise<ResolveOutcome> {
    this.expireDue();
    const outcome: ResolveOutcome = { attachments: [], skipped: [] };
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const raw of refs) {
      if (raw.startsWith(STAGED_PATH_PREFIX)) {
        const id = raw.slice(STAGED_PATH_PREFIX.length);
        if (seen.has(id)) { outcome.skipped.push({ ref: raw, reason: "duplicado" }); continue; }
        seen.add(id);
        const record = this.get(agentId, id);
        if (record === null) { outcome.skipped.push({ ref: raw, reason: "não encontrado" }); continue; }
        const rereadImage = options.retry === true && record.kind === "image" && record.consumedAtMs !== null;
        if (record.consumedAtMs !== null && !rereadImage) { outcome.skipped.push({ ref: raw, reason: "já consumido" }); continue; }
        if (options.conversationId !== undefined && record.conversationId !== null && record.conversationId !== options.conversationId) {
          outcome.skipped.push({ ref: raw, reason: "conversa incompatível" }); continue;
        }
        const bytes = await this.revalidate(record);
        if (bytes === null) {
          outcome.skipped.push({ ref: raw, reason: record.state === "discarded" ? "descartado" : "validação falhou" }); continue;
        }
        if (outcome.attachments.length >= MAX_ATTACHMENTS_PER_TURN) { outcome.skipped.push({ ref: raw, reason: "limite agregado de anexos" }); break; }
        totalBytes += record.sizeBytes;
        if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) { outcome.skipped.push({ ref: raw, reason: "limite agregado de bytes" }); break; }
        let text: string | undefined;
        let imageDataUrl: string | undefined;
        if (record.kind === "text" || record.kind === "pdf") {
          text = record.kind === "pdf" ? extractPdfText(bytes) : bytes.toString("utf8");
        } else if (options.providerSupportsImages) {
          imageDataUrl = "data:" + record.mime + ";base64," + bytes.toString("base64");
        } else {
          outcome.skipped.push({ ref: raw, reason: "unsupported_feature" }); continue;
        }
        if (!rereadImage && !options.deferConsumption) {
          const claimed = this.statements.setConsumed.run(this.nowFn(), id, agentId);
          if (claimed.changes !== 1) { outcome.skipped.push({ ref: raw, reason: "já consumido" }); continue; }
        } else if (rereadImage && this.get(agentId, id)?.state !== "committed") {
          outcome.skipped.push({ ref: raw, reason: "descartado" }); continue;
        }
        if (record.kind !== "image" && !options.deferConsumption) await this.deleteBytes(id, record.storedPath);

        outcome.attachments.push({
          id, filename: record.filename, kind: record.kind, mime: record.mime,
          sizeBytes: record.sizeBytes, sha256: record.sha256,
          ...(text !== undefined ? { text } : {}),
          ...(imageDataUrl !== undefined ? { imageDataUrl } : {}),
          displayName: record.filename,
        });
      } else {
        outcome.skipped.push({ ref: raw, reason: "path não permitido" });
      }
    }
    return outcome;
  }
}

function extForKind(kind: AttachmentKind): string {
  switch (kind) {
    case "text": return "txt";
    case "pdf": return "pdf";
    case "image": return "img";
  }
}
