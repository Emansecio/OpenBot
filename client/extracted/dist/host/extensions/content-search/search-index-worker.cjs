const __mod=require('node:module');const __p=require('node:path');const __depsDir=__p.join(__dirname,'..','deps');process.env.NODE_PATH=__depsDir+(process.env.NODE_PATH?__p.delimiter+process.env.NODE_PATH:'');__mod.Module._initPaths();const __import_meta_url=require('node:url').pathToFileURL(__filename).href;
"use strict";

// src/host/extensions/content-search/search-index-worker.ts
var import_node_worker_threads = require("node:worker_threads");

// src/shared/invariant.ts
var SandInvariantViolation = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SandInvariantViolation";
  }
};
var installedReporter = null;
var STRIPPED_MESSAGE = "Invariant violation (message stripped in packaged builds; the stack identifies the site)";
function messagesStripped() {
  return true;
}
var FRAME_LINE = /^at /;
var OWN_FRAME = /^at (?:new SandInvariantViolation\b|invariant\b|installInvariantReporter\b)/;
function topApplicationFrame(violation) {
  const stack = violation.stack;
  if (stack == null || !stack.startsWith(headerOf(violation))) return null;
  for (const raw of stack.slice(headerOf(violation).length).split("\n")) {
    const frame = raw.trim();
    if (!FRAME_LINE.test(frame) || OWN_FRAME.test(frame)) continue;
    return frame;
  }
  return null;
}
function headerOf(violation) {
  return violation.message === "" ? violation.name : `${violation.name}: ${violation.message}`;
}
function invariant(condition, message) {
  if (condition) return;
  let violationMessage;
  if (messagesStripped()) {
    violationMessage = STRIPPED_MESSAGE;
  } else if (typeof message === "function") {
    violationMessage = message();
  } else {
    violationMessage = message;
  }
  const violation = new SandInvariantViolation(violationMessage);
  installedReporter?.({ name: violation.name, frame: topApplicationFrame(violation) });
  throw violation;
}

// src/host/storage/sqlite-busy.ts
var SQLITE_CORRUPT = 11;
var SQLITE_NOTADB = 26;
function isSqliteCorruptError(error) {
  if (!(error instanceof Error)) return false;
  const errcode = error.errcode;
  if (typeof errcode === "number") {
    const primary = errcode & 255;
    if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB) return true;
  }
  const message = error.message.toLowerCase();
  return message.includes("malformed") || message.includes("is not a database") || message.includes("database disk image");
}

// src/host/extensions/content-search/search-index-db.ts
var import_node_path = require("node:path");
var import_node_sqlite2 = require("node:sqlite");

// src/shared/media/attachment-open-policy.ts
function attachmentExtension(nameOrPath) {
  const segments = nameOrPath.split(/[/\\]/);
  const base = segments[segments.length - 1] ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

// src/shared/media/attachment-preview.ts
var TEXT_PREVIEWABLE_EXTENSIONS = /* @__PURE__ */ new Set([
  "txt",
  "text",
  "log",
  "md",
  "markdown",
  "mdx",
  "rst",
  "adoc",
  "tex",
  "json",
  "jsonc",
  "json5",
  "ndjson",
  "csv",
  "tsv",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "plist",
  "gradle",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "svg",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "py",
  "pyi",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "php",
  "swift",
  "scala",
  "dart",
  "lua",
  "pl",
  "pm",
  "r",
  "sql",
  "graphql",
  "gql",
  "proto",
  "vue",
  "svelte",
  "astro",
  "sh",
  "bash",
  "zsh",
  "fish",
  "bat",
  "ps1",
  "tf",
  "tfvars",
  "dockerfile",
  "diff",
  "patch"
]);
function isTextPreviewableName(nameOrPath) {
  const ext = attachmentExtension(nameOrPath);
  return ext != null && TEXT_PREVIEWABLE_EXTENSIONS.has(ext);
}
var BINARY_SNIFF_BYTE_WINDOW = 8 * 1024;

// src/shared/media/media-extensions.ts
function extensionOf(name) {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}
var IMAGE_MIME_FROM_EXTENSION = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};
var VIDEO_MIME_FROM_EXTENSION = {
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm"
};
var AUDIO_MIME_FROM_EXTENSION = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".weba": "audio/webm"
};

// src/shared/media/file-preview-kind.ts
var IMAGE_EXTENSIONS = new Set(
  Object.keys(IMAGE_MIME_FROM_EXTENSION).map((ext) => ext.slice(1))
);
var VIDEO_EXTENSIONS = new Set(
  Object.keys(VIDEO_MIME_FROM_EXTENSION).map((ext) => ext.slice(1))
);
var AUDIO_EXTENSIONS = new Set(
  Object.keys(AUDIO_MIME_FROM_EXTENSION).map((ext) => ext.slice(1))
);
var MARKDOWN_EXTENSIONS = /* @__PURE__ */ new Set(["md", "markdown", "mdx"]);
var JSON_EXTENSIONS = /* @__PURE__ */ new Set(["json"]);
var TABLE_EXTENSIONS = /* @__PURE__ */ new Set(["csv", "tsv", "xlsx", "xls"]);
function getFilePreviewKind(nameOrPath) {
  const ext = attachmentExtension(nameOrPath);
  if (ext == null) return "unknown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (TABLE_EXTENSIONS.has(ext)) return "table";
  if (JSON_EXTENSIONS.has(ext)) return "json";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (ext === "docx") return "docx";
  if (isTextPreviewableName(nameOrPath)) return "text";
  return "unknown";
}

// src/shared/media/attachment-summary.ts
var JSON_EXTENSIONS2 = /* @__PURE__ */ new Set(["json", "jsonc", "json5", "ndjson"]);
var ARCHIVE_EXTENSIONS = /* @__PURE__ */ new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "tbz2",
  "xz",
  "txz",
  "zst",
  "7z",
  "rar"
]);
var TABLE_MIME_TYPES = /* @__PURE__ */ new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);
var DOCUMENT_MIME_TYPES = /* @__PURE__ */ new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
var ARCHIVE_MIME_TYPES = /* @__PURE__ */ new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar"
]);
function classifyMimeType(rawMimeType) {
  const mime = (rawMimeType.split(";")[0] ?? "").trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown") return "markdown";
  if (TABLE_MIME_TYPES.has(mime)) return "table";
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (DOCUMENT_MIME_TYPES.has(mime)) return "document";
  if (ARCHIVE_MIME_TYPES.has(mime)) return "archive";
  if (mime.startsWith("text/")) return "text";
  return null;
}
function extensionSubject(source) {
  let pathname;
  try {
    pathname = new URL(source).pathname;
  } catch {
    return source;
  }
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
function classifyPathLike(source) {
  const subject = extensionSubject(source);
  const previewKind = getFilePreviewKind(subject);
  switch (previewKind) {
    case "image":
    case "video":
    case "audio":
    case "pdf":
    case "markdown":
    case "table":
      return previewKind;
    case "docx":
      return "document";
    case "json":
      return "json";
    case "text": {
      const ext = attachmentExtension(subject);
      return ext != null && JSON_EXTENSIONS2.has(ext) ? "json" : "text";
    }
    case "unknown": {
      const ext = attachmentExtension(subject);
      return ext != null && ARCHIVE_EXTENSIONS.has(ext) ? "archive" : null;
    }
  }
  const _exhaustive = previewKind;
  return _exhaustive;
}
function classifyAttachment(source) {
  if (source.mimeType != null && source.mimeType.length > 0) {
    const byMime = classifyMimeType(source.mimeType);
    if (byMime != null) return byMime;
  }
  if (source.fileName != null && source.fileName.length > 0) {
    const byName = classifyPathLike(source.fileName);
    if (byName != null) return byName;
  }
  if (source.urlOrPath != null && source.urlOrPath.length > 0) {
    const byPath = classifyPathLike(source.urlOrPath);
    if (byPath != null) return byPath;
  }
  return "file";
}

// src/shared/media/attachments.ts
var SAND_ATTACHMENT_KINDS = [
  "image",
  "video",
  "audio",
  "pdf",
  "markdown",
  "table",
  "json",
  "text",
  "document",
  "archive",
  "file"
];

// src/shared/media/image-mime.ts
function imageMimeFromPath(filePath) {
  return IMAGE_MIME_FROM_EXTENSION[extensionOf(filePath)];
}
function videoMimeFromPath(filePath) {
  return VIDEO_MIME_FROM_EXTENSION[extensionOf(filePath)];
}
function audioMimeFromPath(filePath) {
  return AUDIO_MIME_FROM_EXTENSION[extensionOf(filePath)];
}

// src/shared/transcript.ts
function isOutboundAgentPeerMessageEntry(entry) {
  return entry != null && entry.kind === "message" && entry.toAgent != null;
}
function isHiddenOutboundAgentPeerMessageEntry(entry) {
  return isOutboundAgentPeerMessageEntry(entry) && entry.toAgent.kind !== "agent";
}

// src/host/storage/store-db.ts
var import_node_sqlite = require("node:sqlite");
var DB_BUSY_TIMEOUT_MS = 5e3;

// src/host/extensions/content-search/agent-content-search.ts
function entrySearchText(entry) {
  switch (entry.kind) {
    case "message":
      return entry.content;
    case "send-message":
      return entry.message.type === "text" ? entry.message.content : "";
    case "notice":
      return entry.text;
    default:
      return "";
  }
}

// src/host/extensions/content-search/search-index-db.ts
var INDEXED_BODY_MAX_CHARS = 2e4;
var META_RECONCILE_DONE = "reconcile_done";
var ATTACHMENT_KINDS = new Set(SAND_ATTACHMENT_KINDS);
var SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  timestamp_ms INTEGER NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(agent_id, entry_id)
) STRICT;
CREATE INDEX IF NOT EXISTS messages_agent_recency
  ON messages(agent_id, timestamp_ms DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  content='messages',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body)
    VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body)
    VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  ext TEXT NOT NULL,
  mime TEXT,
  kind TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  UNIQUE(agent_id, entry_id)
) STRICT;
CREATE INDEX IF NOT EXISTS media_recency ON media(timestamp_ms DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
  file_name,
  content='media',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);
CREATE TRIGGER IF NOT EXISTS media_fts_insert AFTER INSERT ON media BEGIN
  INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name);
END;
CREATE TRIGGER IF NOT EXISTS media_fts_delete AFTER DELETE ON media BEGIN
  INSERT INTO media_fts(media_fts, rowid, file_name)
    VALUES ('delete', old.id, old.file_name);
END;
CREATE TRIGGER IF NOT EXISTS media_fts_update AFTER UPDATE ON media BEGIN
  INSERT INTO media_fts(media_fts, rowid, file_name)
    VALUES ('delete', old.id, old.file_name);
  INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name);
END;
`;
function openSearchIndexDb(dbPath) {
  const db2 = new import_node_sqlite2.DatabaseSync(dbPath);
  try {
    db2.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    db2.exec("PRAGMA journal_mode = WAL");
    db2.exec("PRAGMA synchronous = NORMAL");
    db2.exec("PRAGMA auto_vacuum = INCREMENTAL");
    return db2;
  } catch (error) {
    try {
      db2.close();
    } catch {
    }
    throw error;
  }
}
function ensureSearchIndexSchema(db2) {
  db2.exec(SCHEMA);
}
function writeReconcileDone(db2) {
  db2.prepare(
    "INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run(META_RECONCILE_DONE);
}
function deriveMessageRow(entry) {
  if (isHiddenOutboundAgentPeerMessageEntry(entry)) return null;
  const body = entrySearchText(entry).trim();
  if (body.length === 0) return null;
  return {
    entryId: entry.id,
    role: entry.kind === "message" ? entry.role : "assistant",
    timestampMs: wholeMs(entry.timestampMs),
    body: body.slice(0, INDEXED_BODY_MAX_CHARS)
  };
}
function wholeMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}
function wholeDimension(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}
function mediaFileName(fileName, urlOrPath) {
  const trimmed = fileName?.trim();
  if (trimmed != null && trimmed.length > 0) return trimmed;
  let subject = urlOrPath;
  try {
    subject = new URL(urlOrPath).pathname;
  } catch {
  }
  try {
    subject = decodeURIComponent(subject);
  } catch {
  }
  return (0, import_node_path.basename)(subject);
}
function deriveMediaRow(entry) {
  let fileName;
  let urlOrPath;
  let width = null;
  let height = null;
  if (entry.kind === "user-attachment") {
    urlOrPath = entry.file_path;
    fileName = mediaFileName(entry.file_name, urlOrPath);
    width = wholeDimension(entry.width);
    height = wholeDimension(entry.height);
  } else if (entry.kind === "send-message" && entry.message.type === "attachment") {
    urlOrPath = entry.message.url;
    fileName = mediaFileName(entry.message.file_name, urlOrPath);
  } else {
    return null;
  }
  if (fileName.length === 0) return null;
  const ext = (0, import_node_path.extname)(fileName).toLowerCase();
  const mime = imageMimeFromPath(fileName) ?? videoMimeFromPath(fileName) ?? audioMimeFromPath(fileName) ?? null;
  return {
    entryId: entry.id,
    fileName,
    ext,
    mime,
    kind: classifyAttachment({ fileName, urlOrPath }),
    timestampMs: wholeMs(entry.timestampMs),
    width,
    height
  };
}

// src/host/extensions/content-search/search-index-writer.ts
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");
var import_node_sqlite3 = require("node:sqlite");
var STORE_FILENAME = "store.db";
var INCREMENTAL_VACUUM_PAGES = 512;
function prepareStatements(db2) {
  return {
    upsertMessage: db2.prepare(
      `INSERT INTO messages (agent_id, entry_id, role, timestamp_ms, body)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(agent_id, entry_id) DO UPDATE SET
				role = excluded.role,
				timestamp_ms = excluded.timestamp_ms,
				body = excluded.body`
    ),
    deleteMessage: db2.prepare("DELETE FROM messages WHERE agent_id = ? AND entry_id = ?"),
    deleteAgentMessages: db2.prepare("DELETE FROM messages WHERE agent_id = ?"),
    upsertMedia: db2.prepare(
      `INSERT INTO media (
				agent_id, entry_id, file_name, ext, mime, kind,
				timestamp_ms, width, height
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(agent_id, entry_id) DO UPDATE SET
				file_name = excluded.file_name,
				ext = excluded.ext,
				mime = excluded.mime,
				kind = excluded.kind,
				timestamp_ms = excluded.timestamp_ms,
				width = excluded.width,
				height = excluded.height`
    ),
    deleteMedia: db2.prepare("DELETE FROM media WHERE agent_id = ? AND entry_id = ?"),
    deleteAgentMedia: db2.prepare("DELETE FROM media WHERE agent_id = ?"),
    upsertFingerprint: db2.prepare(
      `INSERT INTO agents (agent_id, fingerprint) VALUES (?, ?)
			 ON CONFLICT(agent_id) DO UPDATE SET fingerprint = excluded.fingerprint`
    ),
    deleteFingerprint: db2.prepare("DELETE FROM agents WHERE agent_id = ?"),
    readFingerprint: db2.prepare("SELECT fingerprint FROM agents WHERE agent_id = ?"),
    listIndexedAgentIds: db2.prepare(
      `SELECT agent_id AS agentId FROM agents
			 UNION SELECT DISTINCT agent_id FROM messages
			 UNION SELECT DISTINCT agent_id FROM media`
    )
  };
}
var SandSearchIndexWriter = class {
  constructor(db2, agentsRootDir) {
    this.db = db2;
    this.agentsRootDir = agentsRootDir;
    this.statements = prepareStatements(db2);
  }
  db;
  agentsRootDir;
  statements;
  storeConnections = /* @__PURE__ */ new Map();
  close() {
    for (const connection of this.storeConnections.values()) {
      try {
        connection.db.close();
      } catch {
      }
    }
    this.storeConnections.clear();
  }
  runJob(job) {
    switch (job.kind) {
      case "upsert-entries":
        this.upsertEntries(job.agentId, job.entries);
        return;
      case "delete-entry":
        this.deleteEntry(job.agentId, job.entryId);
        return;
      case "clear-agent":
        this.clearAgent(job.agentId);
        return;
      case "reindex-agents":
        for (const agentId of job.agentIds) this.reindexAgent(agentId);
        return;
      case "reconcile":
        this.reconcile();
        return;
    }
  }
  storeDbPath(agentId) {
    return (0, import_node_path2.join)(this.agentsRootDir, agentId, STORE_FILENAME);
  }
  evictStoreConnection(agentId) {
    const cached = this.storeConnections.get(agentId);
    if (cached == null) return;
    this.storeConnections.delete(agentId);
    try {
      cached.db.close();
    } catch {
    }
  }
  storeConnection(agentId) {
    const cached = this.storeConnections.get(agentId);
    if (cached != null) return cached;
    const path = this.storeDbPath(agentId);
    if (!(0, import_node_fs.existsSync)(path)) return null;
    try {
      const db2 = new import_node_sqlite3.DatabaseSync(path, { readOnly: true });
      db2.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
      const connection = { db: db2 };
      this.storeConnections.set(agentId, connection);
      return connection;
    } catch {
      return null;
    }
  }
  readStoreFingerprint(agentId) {
    const connection = this.storeConnection(agentId);
    if (connection == null) return null;
    try {
      const row = connection.db.prepare(
        "SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS maxSeq FROM transcript_entries"
      ).get();
      if (row == null || typeof row.count !== "number" || typeof row.maxSeq !== "number") {
        return null;
      }
      return `${row.count}:${row.maxSeq}`;
    } catch {
      this.evictStoreConnection(agentId);
      return null;
    }
  }
  inTransaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  applyEntry(agentId, entry) {
    let message = null;
    let media = null;
    try {
      message = deriveMessageRow(entry);
      media = deriveMediaRow(entry);
    } catch {
    }
    if (message != null) {
      this.statements.upsertMessage.run(
        agentId,
        message.entryId,
        message.role,
        message.timestampMs,
        message.body
      );
    } else {
      this.statements.deleteMessage.run(agentId, entry.id);
    }
    if (media != null) {
      this.statements.upsertMedia.run(
        agentId,
        media.entryId,
        media.fileName,
        media.ext,
        media.mime,
        media.kind,
        media.timestampMs,
        media.width,
        media.height
      );
    } else {
      this.statements.deleteMedia.run(agentId, entry.id);
    }
  }
  refreshFingerprint(agentId) {
    const fingerprint = this.readStoreFingerprint(agentId);
    if (fingerprint == null) {
      this.statements.deleteFingerprint.run(agentId);
    } else {
      this.statements.upsertFingerprint.run(agentId, fingerprint);
    }
  }
  upsertEntries(agentId, entries) {
    if (entries.length === 0) return;
    this.inTransaction(() => {
      for (const entry of entries) this.applyEntry(agentId, entry);
      this.refreshFingerprint(agentId);
    });
  }
  deleteEntry(agentId, entryId) {
    this.inTransaction(() => {
      this.statements.deleteMessage.run(agentId, entryId);
      this.statements.deleteMedia.run(agentId, entryId);
      this.refreshFingerprint(agentId);
    });
  }
  clearAgent(agentId) {
    this.evictStoreConnection(agentId);
    this.inTransaction(() => {
      this.statements.deleteAgentMessages.run(agentId);
      this.statements.deleteAgentMedia.run(agentId);
      this.statements.deleteFingerprint.run(agentId);
    });
    this.db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`);
  }
  reindexAgent(agentId) {
    this.evictStoreConnection(agentId);
    if (!(0, import_node_fs.existsSync)(this.storeDbPath(agentId))) {
      this.clearAgent(agentId);
      return;
    }
    const connection = this.storeConnection(agentId);
    if (connection == null) return;
    let rows;
    try {
      rows = connection.db.prepare("SELECT seq, entry FROM transcript_entries ORDER BY seq").all();
    } catch {
      this.evictStoreConnection(agentId);
      return;
    }
    let maxSeq = 0;
    const entries = [];
    for (const row of rows) {
      if (typeof row.seq === "number" && row.seq > maxSeq) maxSeq = row.seq;
      if (typeof row.entry !== "string") continue;
      try {
        const parsed = JSON.parse(row.entry);
        if (parsed != null && typeof parsed === "object" && typeof parsed.id === "string" && typeof parsed.kind === "string") {
          entries.push(parsed);
        }
      } catch {
      }
    }
    const fingerprint = `${rows.length}:${maxSeq}`;
    this.inTransaction(() => {
      this.statements.deleteAgentMessages.run(agentId);
      this.statements.deleteAgentMedia.run(agentId);
      for (const entry of entries) this.applyEntry(agentId, entry);
      this.statements.upsertFingerprint.run(agentId, fingerprint);
    });
    this.db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`);
  }
  reconcile() {
    let agentDirs;
    try {
      agentDirs = (0, import_node_fs.readdirSync)(this.agentsRootDir, { withFileTypes: true }).filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
    } catch {
      agentDirs = [];
    }
    const onDisk = new Set(agentDirs);
    const indexedRows = this.statements.listIndexedAgentIds.all();
    for (const row of indexedRows) {
      if (typeof row.agentId !== "string") continue;
      if (!onDisk.has(row.agentId)) this.clearAgent(row.agentId);
    }
    for (const agentId of agentDirs) {
      if (!(0, import_node_fs.existsSync)(this.storeDbPath(agentId))) continue;
      const storeFingerprint = this.readStoreFingerprint(agentId);
      if (storeFingerprint == null) continue;
      const indexed = this.statements.readFingerprint.get(agentId);
      if (indexed?.fingerprint !== storeFingerprint) {
        this.reindexAgent(agentId);
      }
    }
    writeReconcileDone(this.db);
  }
};

// src/host/extensions/content-search/search-index-worker.ts
var port = import_node_worker_threads.parentPort;
invariant(port != null, "search-index-worker must run as a worker_thread");
var config = import_node_worker_threads.workerData;
invariant(
  typeof config?.indexDbPath === "string" && typeof config?.agentsRootDir === "string",
  "search-index-worker needs indexDbPath + agentsRootDir"
);
var db = openSearchIndexDb(config.indexDbPath);
ensureSearchIndexSchema(db);
var writer = new SandSearchIndexWriter(db, config.agentsRootDir);
port.on("message", (request) => {
  let response;
  try {
    writer.runJob(request.job);
    response = { requestId: request.requestId, ok: true };
  } catch (error) {
    response = {
      requestId: request.requestId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      isIndexCorrupt: isSqliteCorruptError(error)
    };
  }
  port.postMessage(response);
});
//# sourceMappingURL=search-index-worker.cjs.map
