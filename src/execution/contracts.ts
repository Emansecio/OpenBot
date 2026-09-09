import {
  validateBrowserCommand,
  type BrowserKey,
  type BrowserCommandName,
  type BrowserCommandResult,
} from "../browser/protocol.js";

export const MAX_EXECUTION_PATH_BYTES = 4096;
export const MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_SEARCH_PATHS = ["Documents", "Projects"] as const;
export const MAX_LIST_ENTRIES = 1000;
export const MAX_SEARCH_PATTERN_BYTES = 4096;
export const MAX_PROCESS_EXECUTABLE_BYTES = MAX_EXECUTION_PATH_BYTES;
export const MAX_PROCESS_ARGS = 64;
export const MAX_PROCESS_ARG_BYTES = 4096;
export const MAX_PROCESS_ENV_ENTRIES = 64;
export const MAX_PROCESS_ENV_VALUE_BYTES = 4096;
export const MAX_PROCESS_STDIN_BYTES = 1024 * 1024;
export const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_PROCESS_TIMEOUT_MS = 5 * 60_000;

export type FileEncoding = "utf8" | "base64";
export type CommandId = "search.text" | "search.files";
export type ProcessNetworkProfile = "none" | "host";

export type BrowserExecutionOperation = `browser.${BrowserCommandName}`;

export const WHATSAPP_OPS = ["doctor", "sweep", "messages_list", "send", "download"] as const;
export type WhatsappOp = (typeof WHATSAPP_OPS)[number];
export const MAX_WHATSAPP_TEXT_BYTES = 16 * 1024;
export const MAX_WHATSAPP_CHAT_BYTES = 256;
export const MAX_WHATSAPP_OUTPUT_BYTES = 256 * 1024;
export const MAX_WHATSAPP_TIMEOUT_MS = 60_000;

export type BrowserExecutionRequest =
  | { operation: "browser.open"; url?: string }
  | { operation: "browser.navigate"; url: string }
  | { operation: "browser.snapshot"; includeText?: boolean }
  | { operation: "browser.click"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number }
  | { operation: "browser.click_element"; elementId: string }
  | { operation: "browser.scroll"; deltaX: number; deltaY: number }
  | { operation: "browser.press_key"; key: BrowserKey }
  | { operation: "browser.type"; text: string }
  | { operation: "browser.upload"; selector: string; path: string }
  | { operation: "browser.screenshot"; fullPage?: boolean }
  | { operation: "browser.close" }
  | { operation: "browser.handoff" };

export type ExecutionRequest =
  | { operation: "workspace.info" }
  | {
      operation: "file.list";
      path: string;
    }
  | { operation: "file.stat"; path: string }
  | { operation: "file.mkdir"; path: string }
  | { operation: "file.copy"; source: string; destination: string }
  | { operation: "file.move"; source: string; destination: string }
  | { operation: "file.trash"; path: string }
  | { operation: "file.restore"; trashId: string; path?: string }
  | { operation: "file.read"; path: string; encoding: FileEncoding }
  | { operation: "file.write"; path: string; content: string; encoding: FileEncoding }
  | {
      operation: "command.run";
      command: CommandId;
      cwd: string;
      params:
        | { pattern: string; mode: "fixed" | "regex"; paths: string[] }
        | { paths: string[] };
    }
  | {
      operation: "process.run";
      executable: string;
      argv: string[];
      cwd: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs: number;
      networkProfile: ProcessNetworkProfile;
    }
  | {
      operation: "whatsapp";
      op: WhatsappOp;
      chat?: string;
      limit?: number;
      text?: string;
      etapa?: string;
      mediaId?: string;
    }
  | BrowserExecutionRequest;

export type ExecutionErrorCode =
  | "invalid_request"
  | "invalid_path"
  | "outside_workspace"
  | "not_found"
  | "access_denied"
  | "permission_denied"
  | "unsupported"
  | "aborted"
  | "timed_out"
  | "output_limit"
  | "process_not_allowed"
  | "process_timeout"
  | "process_aborted"
  | "process_output_limit"
  | "quota_exceeded"
  | "runtime_unavailable"
  | "runtime_protocol_error"
  | "runtime_unhealthy"
  | "lease_expired"
  | "io_error";

export interface ProcessOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Bound even a partially returned runner result before it reaches the provider. */
export function boundedProcessOutput(output: ProcessOutput): ProcessOutput {
  const truncate = (value: string): string => new TextDecoder().decode(
    Buffer.from(value).subarray(0, MAX_PROCESS_OUTPUT_BYTES), { stream: true },
  );
  return {
    ...output,
    stdout: truncate(output.stdout),
    stderr: truncate(output.stderr),
    stdoutTruncated: output.stdoutTruncated || Buffer.byteLength(output.stdout) > MAX_PROCESS_OUTPUT_BYTES,
    stderrTruncated: output.stderrTruncated || Buffer.byteLength(output.stderr) > MAX_PROCESS_OUTPUT_BYTES,
  };
}

export type ExecutionResult =
  | { ok: true; operation: "workspace.info"; homeRoot: string; sharedFolders: { name: string; path: string; access: "read" | "write" }[]; legacyFolders: { name: string; path: string }[] }
  | { ok: true; operation: "file.list"; entries: { name: string; kind: "file" | "directory" | "other" }[] }
  | { ok: true; operation: "file.stat"; kind: "file" | "directory" | "other"; bytes: number }
  | { ok: true; operation: "file.mkdir"; created: boolean }
  | { ok: true; operation: "file.copy"; bytes: number; entries: number }
  | { ok: true; operation: "file.move" }
  | { ok: true; operation: "file.trash"; trashId: string }
  | { ok: true; operation: "file.restore"; path: string }
  | { ok: true; operation: "file.read"; content: string; encoding: FileEncoding; bytes: number }
  | { ok: true; operation: "file.write"; bytes: number }
  | { ok: true; operation: "command.run"; command: CommandId; stdout: string; stderr: string; exitCode: number | null; durationMs: number }
  | {
      ok: true;
      operation: "process.run";
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal?: string;
      durationMs: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
    }
  | {
      ok: true;
      operation: "whatsapp";
      op: WhatsappOp;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      durationMs: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
    }
  | ({ ok: true; operation: BrowserExecutionOperation } & BrowserCommandResult)
  | {
      ok: false;
      operation: ExecutionRequest["operation"] | "unknown";
      code: ExecutionErrorCode;
      message: string;
      /** Present only after a process started; never implies that its effects were rolled back. */
      partialOutput?: ProcessOutput;
    };

export interface ExecutionBackend {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
}

export class ExecutionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionRequestError";
  }
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ExecutionRequestError("request must be an object");
  return value as Record<string, unknown>;
};

const exact = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ExecutionRequestError("request contains unsupported fields");
};

const pathValue = (value: unknown, name = "path"): string => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_EXECUTION_PATH_BYTES || value.includes("\0")) {
    throw new ExecutionRequestError(`${name} is invalid`);
  }
  return value;
};

const trashIdValue = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ExecutionRequestError("trashId is invalid");
  }
  return value;
};

const encodingValue = (value: unknown): FileEncoding => {
  if (value === undefined || value === "utf8") return "utf8";
  if (value === "base64") return "base64";
  throw new ExecutionRequestError("encoding is invalid");
};

const pathsValue = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new ExecutionRequestError("paths are invalid");
  return value.map((item) => pathValue(item, "paths item"));
};

const executableValue = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_PROCESS_EXECUTABLE_BYTES ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    throw new ExecutionRequestError("executable is invalid");
  }
  return value;
};

const stringArrayValue = (value: unknown, name: string, maxItems: number, maxItemBytes: number): string[] => {
  if (!Array.isArray(value) || value.length > maxItems) throw new ExecutionRequestError(`${name} is invalid`);
  return value.map((item) => {
    if (typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item) > maxItemBytes) {
      throw new ExecutionRequestError(`${name} is invalid`);
    }
    return item;
  });
};

const environmentValue = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  const input = record(value);
  const entries = Object.entries(input);
  if (entries.length > MAX_PROCESS_ENV_ENTRIES) throw new ExecutionRequestError("env is invalid");
  const output: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry) > MAX_PROCESS_ENV_VALUE_BYTES) {
      throw new ExecutionRequestError("env is invalid");
    }
    output[key] = entry;
  }
  return output;
};

const whatsappOpValue = (value: unknown): WhatsappOp => {
  if (typeof value !== "string" || !(WHATSAPP_OPS as readonly string[]).includes(value)) {
    throw new ExecutionRequestError("whatsapp op is unsupported");
  }
  return value as WhatsappOp;
};

const whatsappChatValue = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_WHATSAPP_CHAT_BYTES ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("/") ||
    /\s/u.test(value) ||
    !/^[A-Za-z0-9._@+-]+$/u.test(value)
  ) {
    throw new ExecutionRequestError("chat is invalid");
  }
  return value;
};

const whatsappTextValue = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > MAX_WHATSAPP_TEXT_BYTES) {
    throw new ExecutionRequestError(`${name} is invalid`);
  }
  return value;
};

const whatsappLimitValue = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new ExecutionRequestError("limit is invalid");
  }
  return value;
};

const timeoutValue = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_PROCESS_TIMEOUT_MS) {
    throw new ExecutionRequestError("timeoutMs is invalid");
  }
  return value;
};

const browserCommandValue = (command: Parameters<typeof validateBrowserCommand>[0]): void => {
  try {
    validateBrowserCommand(command);
  } catch (error) {
    throw new ExecutionRequestError(error instanceof Error ? error.message : "browser request is invalid");
  }
};

export function parseExecutionRequest(value: unknown): ExecutionRequest {
  const input = record(value);
  switch (input.operation) {
    case "workspace.info":
      exact(input, ["operation"]);
      return { operation: "workspace.info" };
    case "file.list":
      exact(input, ["operation", "path"]);
      return { operation: "file.list", path: pathValue(input.path) };
    case "file.stat":
      exact(input, ["operation", "path"]);
      return { operation: "file.stat", path: pathValue(input.path) };
    case "file.mkdir":
      exact(input, ["operation", "path"]);
      return { operation: "file.mkdir", path: pathValue(input.path) };
    case "file.copy":
      exact(input, ["operation", "source", "destination"]);
      return { operation: "file.copy", source: pathValue(input.source, "source"), destination: pathValue(input.destination, "destination") };
    case "file.move":
      exact(input, ["operation", "source", "destination"]);
      return { operation: "file.move", source: pathValue(input.source, "source"), destination: pathValue(input.destination, "destination") };
    case "file.trash":
      exact(input, ["operation", "path"]);
      return { operation: "file.trash", path: pathValue(input.path) };
    case "file.restore":
      exact(input, ["operation", "trashId", "path"]);
      return {
        operation: "file.restore",
        trashId: trashIdValue(input.trashId),
        ...(input.path === undefined ? {} : { path: pathValue(input.path) }),
      };
    case "file.read":
      exact(input, ["operation", "path", "encoding"]);
      return { operation: "file.read", path: pathValue(input.path), encoding: encodingValue(input.encoding) };
    case "file.write": {
      exact(input, ["operation", "path", "content", "encoding"]);
      if (typeof input.content !== "string") throw new ExecutionRequestError("content is invalid");
      const encoding = encodingValue(input.encoding);
      const bytes = encoding === "base64" ? Buffer.from(input.content, "base64").byteLength : Buffer.byteLength(input.content);
      if (bytes > MAX_FILE_BYTES) throw new ExecutionRequestError("content exceeds the byte limit");
      return { operation: "file.write", path: pathValue(input.path), content: input.content, encoding };
    }
    case "process.run": {
      exact(input, ["operation", "executable", "argv", "cwd", "env", "stdin", "timeoutMs", "networkProfile"]);
      const networkProfile = input.networkProfile ?? "host";
      if (networkProfile !== "none" && networkProfile !== "host") throw new ExecutionRequestError("networkProfile is unsupported");
      if (input.stdin !== undefined && (typeof input.stdin !== "string" || input.stdin.includes("\0") || Buffer.byteLength(input.stdin) > MAX_PROCESS_STDIN_BYTES)) {
        throw new ExecutionRequestError("stdin is invalid");
      }
      const env = environmentValue(input.env);
      return {
        operation: "process.run",
        executable: executableValue(input.executable),
        argv: stringArrayValue(input.argv, "argv", MAX_PROCESS_ARGS, MAX_PROCESS_ARG_BYTES),
        cwd: pathValue(input.cwd, "cwd"),
        ...(env === undefined ? {} : { env }),
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        timeoutMs: timeoutValue(input.timeoutMs),
        networkProfile,
      };
    }
    case "whatsapp": {
      exact(input, ["operation", "op", "chat", "limit", "text", "etapa", "mediaId"]);
      const op = whatsappOpValue(input.op);
      if (op === "doctor" || op === "sweep") {
        if (input.chat !== undefined || input.limit !== undefined || input.text !== undefined || input.etapa !== undefined || input.mediaId !== undefined) {
          throw new ExecutionRequestError("request contains unsupported fields");
        }
        return { operation: "whatsapp", op };
      }
      if (op === "messages_list") {
        if (input.text !== undefined || input.etapa !== undefined || input.mediaId !== undefined) {
          throw new ExecutionRequestError("request contains unsupported fields");
        }
        return {
          operation: "whatsapp",
          op,
          chat: whatsappChatValue(input.chat),
          ...(input.limit === undefined ? {} : { limit: whatsappLimitValue(input.limit) }),
        };
      }
      if (op === "send") {
        if (input.limit !== undefined || input.mediaId !== undefined) {
          throw new ExecutionRequestError("request contains unsupported fields");
        }
        return {
          operation: "whatsapp",
          op,
          chat: whatsappChatValue(input.chat),
          text: whatsappTextValue(input.text, "text"),
          ...(input.etapa === undefined ? {} : { etapa: whatsappTextValue(input.etapa, "etapa") }),
        };
      }
      if (input.text !== undefined || input.etapa !== undefined || input.limit !== undefined) {
        throw new ExecutionRequestError("request contains unsupported fields");
      }
      return {
        operation: "whatsapp",
        op,
        chat: whatsappChatValue(input.chat),
        ...(input.mediaId === undefined ? {} : { mediaId: whatsappTextValue(input.mediaId, "mediaId") }),
      };
    }
    case "command.run": {
      exact(input, ["operation", "command", "cwd", "params"]);
      if (input.command !== "search.text" && input.command !== "search.files") throw new ExecutionRequestError("command is not allowlisted");
      const params = record(input.params);
      const cwd = input.cwd === undefined ? "." : pathValue(input.cwd, "cwd");
      if (input.command === "search.text") {
        exact(params, ["pattern", "mode", "paths"]);
        if (typeof params.pattern !== "string" || params.pattern.length === 0 || Buffer.byteLength(params.pattern) > MAX_SEARCH_PATTERN_BYTES) {
          throw new ExecutionRequestError("pattern is invalid");
        }
        if (params.mode !== undefined && params.mode !== "fixed" && params.mode !== "regex") throw new ExecutionRequestError("mode is invalid");
        return {
          operation: "command.run",
          command: "search.text",
          cwd,
          params: {
            pattern: params.pattern,
            mode: params.mode ?? "fixed",
            paths: params.paths === undefined ? [...DEFAULT_SEARCH_PATHS] : pathsValue(params.paths),
          },
        };
      }
      exact(params, ["paths"]);
      return {
        operation: "command.run",
        command: "search.files",
        cwd,
        params: { paths: params.paths === undefined ? [...DEFAULT_SEARCH_PATHS] : pathsValue(params.paths) },
      };
    }
    case "browser.open":
      exact(input, ["operation", "url"]);
      browserCommandValue({ command: "open", ...(input.url === undefined ? {} : { url: input.url as string }) });
      return { operation: "browser.open", ...(input.url === undefined ? {} : { url: input.url as string }) };
    case "browser.navigate":
      exact(input, ["operation", "url"]);
      browserCommandValue({ command: "navigate", url: input.url as string });
      return { operation: "browser.navigate", url: input.url as string };
    case "browser.snapshot":
      exact(input, ["operation", "includeText"]);
      browserCommandValue({ command: "snapshot", ...(input.includeText === undefined ? {} : { includeText: input.includeText as boolean }) });
      return { operation: "browser.snapshot", ...(input.includeText === undefined ? {} : { includeText: input.includeText as boolean }) };
    case "browser.click":
      exact(input, ["operation", "x", "y", "button", "clickCount"]);
      browserCommandValue({
        command: "click",
        x: input.x as number,
        y: input.y as number,
        ...(input.button === undefined ? {} : { button: input.button as "left" | "middle" | "right" }),
        ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount as number }),
      });
      return {
        operation: "browser.click",
        x: input.x as number,
        y: input.y as number,
        ...(input.button === undefined ? {} : { button: input.button as "left" | "middle" | "right" }),
        ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount as number }),
      };
    case "browser.click_element":
      exact(input, ["operation", "elementId"]);
      browserCommandValue({ command: "click_element", elementId: input.elementId as string });
      return { operation: "browser.click_element", elementId: input.elementId as string };
    case "browser.scroll":
      exact(input, ["operation", "deltaX", "deltaY"]);
      browserCommandValue({ command: "scroll", deltaX: input.deltaX as number, deltaY: input.deltaY as number });
      return { operation: "browser.scroll", deltaX: input.deltaX as number, deltaY: input.deltaY as number };
    case "browser.press_key":
      exact(input, ["operation", "key"]);
      browserCommandValue({ command: "press_key", key: input.key as BrowserKey });
      return { operation: "browser.press_key", key: input.key as BrowserKey };
    case "browser.type":
      exact(input, ["operation", "text"]);
      browserCommandValue({ command: "type", text: input.text as string });
      return { operation: "browser.type", text: input.text as string };
    case "browser.upload":
      exact(input, ["operation", "selector", "path"]);
      browserCommandValue({ command: "upload", selector: input.selector as string,
        path: typeof input.path === "string" ? input.path.replace(/^shared:\/\//iu, "") : input.path as string });
      return { operation: "browser.upload", selector: input.selector as string, path: input.path as string };
    case "browser.screenshot":
      exact(input, ["operation", "fullPage"]);
      browserCommandValue({ command: "screenshot", ...(input.fullPage === undefined ? {} : { fullPage: input.fullPage as boolean }) });
      return { operation: "browser.screenshot", ...(input.fullPage === undefined ? {} : { fullPage: input.fullPage as boolean }) };
    case "browser.close":
      exact(input, ["operation"]);
      browserCommandValue({ command: "close" });
      return { operation: "browser.close" };
    case "browser.handoff":
      exact(input, ["operation"]);
      browserCommandValue({ command: "handoff" });
      return { operation: "browser.handoff" };
    default:
      throw new ExecutionRequestError("operation is unsupported");
  }
}
