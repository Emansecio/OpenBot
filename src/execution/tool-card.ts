import type { ExecutionRequest, ExecutionResult } from "./contracts.js";
import type { ToolCallResult, TranscriptEntry } from "../shared/contracts.js";

export type ToolCallEntry = Extract<TranscriptEntry, { kind: "tool-call" }>;

export const MAX_TOOL_SUMMARY_CHARS = 120;

const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:[\\/][^\s"'<>|]+/gu;
const FILE_URL_PATH = /file:\/\/[^\s"'<>]+/giu;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|secret|password|passwd|authorization|cookie|session)\b\s*[:=]\s*[^\s,;]+/giu;
const BEARER_SECRET = /\b(Bearer)\s+[A-Za-z0-9._-]+\b/giu;
const OPENAI_SECRET = /\bsk-[A-Za-z0-9_-]{8,}\b/gu;

function safeToolName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9._:-]+/g, " ").trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "unknown";
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, " ").trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : fallback;
}

function sanitizeRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\\/g, "/");
  if (normalized.length === 0) return null;
  if (/^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)) {
    return null;
  }
  normalized = normalized.replace(/^\.\/+/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

function redactSensitiveSummaryText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(WINDOWS_ABSOLUTE_PATH, "[path]")
    .replace(FILE_URL_PATH, "[path]")
    .replace(BEARER_SECRET, "$1 [redacted]")
    .replace(SECRET_ASSIGNMENT, "$1=[redacted]")
    .replace(OPENAI_SECRET, "[redacted]");
}

function sanitizeToolSummary(value: string): string {
  const normalized = redactSensitiveSummaryText(value).replace(/\s+/g, " ").trim();
  const chars = [...normalized];
  return chars.length <= MAX_TOOL_SUMMARY_CHARS
    ? normalized
    : `${chars.slice(0, MAX_TOOL_SUMMARY_CHARS - 3).join("")}...`;
}

export function stableToolCallId(id: string, name: string, rawArgs: string): string {
  if (id.length > 0) return id;
  let hash = 2166136261;
  const input = `${name}\0${rawArgs}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `anon:${(hash >>> 0).toString(16)}`;
}

/** Local transcript identity; raw provider ids may repeat across turns. */
export function toolCallLocalId(turnId: string, toolCallId: string): string {
  return `${turnId}\0${toolCallId}`;
}

export function toolCallSummary(name: string, rawArgs: string): string {
  const toolName = safeToolName(name);
  const fallback = `tool ${toolName}`;
  const mcpSummary = (() => {
    if (!name.startsWith("mcp__")) return undefined;
    const server = safeToolName(name.slice(5).split("__")[0] ?? "");
    return `MCP ${server}`;
  })();
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    if (name === "file") {
      const op = safeLabel(parsed.op, "file");
      const target = sanitizeRelativePath(parsed.path ?? parsed.source ?? parsed.destination);
      return sanitizeToolSummary(target === null ? `${op} file` : `${op} ${target}`);
    }
    if (name === "search_text") return "search text";
    if (name === "search_files") return "search files";
    if (name === "search_skills") return "search skills";
    if (name === "use_skill") {
      const skillId = safeLabel(parsed.id, "");
      return sanitizeToolSummary(skillId.length === 0 ? "use skill" : `use skill ${skillId}`);
    }
    if (name === "save_skill") return sanitizeToolSummary(`save skill ${safeLabel(parsed.id, "")}`.trim());
    if (name === "process_run") return "run process";
    if (name === "whatsapp") {
      const op = safeLabel(parsed.op, "whatsapp");
      return sanitizeToolSummary(op === "whatsapp" ? "whatsapp" : `whatsapp ${op}`);
    }
    if (name === "browser_navigate") {
      if (typeof parsed.url === "string") {
        try {
          const url = new URL(parsed.url);
          if (url.origin !== "null" && url.host.length > 0) {
            return sanitizeToolSummary(`navigate ${url.origin}`);
          }
        } catch {
          return "navigate browser";
        }
      }
      return "navigate browser";
    }
    if (name === "browser_open") return "open browser";
    if (name === "browser_snapshot") return "snapshot browser";
    if (name === "browser_click") return "click browser";
    if (name === "browser_click_element") return "click browser element";
    if (name === "browser_scroll") return "scroll browser";
    if (name === "browser_press_key") return "press browser key";
    if (name === "browser_type") return "type in browser";
    if (name === "browser_upload") return "upload in browser";
    if (name === "browser_screenshot") return "take browser screenshot";
    if (name === "browser_handoff") return "hand off browser";
    if (name === "browser_close") return "close browser";
    if (mcpSummary !== undefined) return sanitizeToolSummary(mcpSummary);
  } catch {
    if (mcpSummary !== undefined) return sanitizeToolSummary(mcpSummary);
  }
  return sanitizeToolSummary(fallback);
}

export function toolCallResult(result: ExecutionResult, request?: ExecutionRequest): ToolCallResult {
  if (!result.ok) {
    return { ok: false, operation: result.operation, code: result.code, message: result.message };
  }
  if (result.operation === "process.run") {
    return {
      ok: result.exitCode === 0,
      operation: result.operation,
      exitCode: result.exitCode,
      ...(result.exitCode === 0 ? {} : {
        code: "process_failed",
        message: `Process exited with ${result.exitCode === null ? "no exit code" : `code ${result.exitCode}`}. Earlier effects may have completed.`,
      }),
    };
  }
  const path = request && "path" in request ? request.path : undefined;
  if (result.operation === "file.write") return { ok: true, operation: result.operation, bytes: result.bytes, ...(path ? { path } : {}) };
  if (result.operation === "file.read") return { ok: true, operation: result.operation, bytes: result.bytes, ...(path ? { path } : {}) };
  if (result.operation === "file.list") return { ok: true, operation: result.operation, count: result.entries.length, ...(path ? { path } : {}) };
  if (result.operation === "command.run") {
    return { ok: true, operation: result.operation, command: result.command, exitCode: result.exitCode };
  }
  if (result.operation === "whatsapp") {
    return { ok: true, operation: result.operation, command: result.op, exitCode: result.exitCode };
  }
  return { ok: true };
}

export function makeToolCallEntry(
  id: string,
  name: string,
  summary: string,
  status: ToolCallEntry["status"],
  result?: ToolCallResult,
  localToolCallId?: string,
): ToolCallEntry {
  return {
    kind: "tool-call",
    id,
    name,
    summary,
    status,
    ...(result !== undefined ? { result } : {}),
    ...(localToolCallId !== undefined ? { localToolCallId } : {}),
  };
}
