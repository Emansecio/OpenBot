import type { ProviderToolCall } from "../providers/router.js";
import { ExecutionRequestError, parseExecutionRequest, type ExecutionRequest } from "./contracts.js";

export interface ToolRequestParseResult {
  request?: ExecutionRequest;
  error?: string;
}

const asRecord = (call: ProviderToolCall): Record<string, unknown> => {
  const raw = call.function.arguments;
  let parsed: unknown;
  try { parsed = raw.length === 0 ? {} : JSON.parse(raw); }
  catch { throw new ExecutionRequestError("tool arguments are not valid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ExecutionRequestError("tool arguments must be an object");
  return parsed as Record<string, unknown>;
};

const normalizeFile = (args: Record<string, unknown>): unknown => {
  const op = args.op;
  if (op === "list") {
    exactArgs(args, ["op", "path"]);
    return { operation: "file.list", path: args.path ?? "." };
  }
  if (op === "stat") {
    exactArgs(args, ["op", "path"]);
    return { operation: "file.stat", path: args.path };
  }
  if (op === "mkdir") {
    exactArgs(args, ["op", "path"]);
    return { operation: "file.mkdir", path: args.path };
  }
  if (op === "copy") {
    exactArgs(args, ["op", "source", "destination"]);
    return { operation: "file.copy", source: args.source, destination: args.destination };
  }
  if (op === "move") {
    exactArgs(args, ["op", "source", "destination"]);
    return { operation: "file.move", source: args.source, destination: args.destination };
  }
  if (op === "trash") {
    exactArgs(args, ["op", "path"]);
    return { operation: "file.trash", path: args.path };
  }
  if (op === "restore") {
    exactArgs(args, ["op", "trashId", "path"]);
    return {
      operation: "file.restore",
      trashId: args.trashId,
      ...(args.path === undefined ? {} : { path: args.path }),
    };
  }
  if (op === "read") {
    exactArgs(args, ["op", "path", "encoding"]);
    return { operation: "file.read", path: args.path, encoding: args.encoding ?? "utf8" };
  }
  if (op === "write") {
    exactArgs(args, ["op", "path", "content", "encoding"]);
    return { operation: "file.write", path: args.path, content: args.content, encoding: args.encoding };
  }
  throw new ExecutionRequestError("file operation is unsupported");
};

const normalizeSearch = (name: string, args: Record<string, unknown>): unknown => {
  if (name === "search_files") return { operation: "command.run", command: "search.files", cwd: args.cwd, params: { paths: args.paths } };
  return { operation: "command.run", command: "search.text", cwd: args.cwd, params: { pattern: args.pattern, mode: args.mode, paths: args.paths } };
};

const normalizeWhatsapp = (args: Record<string, unknown>): unknown => {
  exactArgs(args, ["op", "chat", "limit", "text", "etapa", "mediaId"]);
  return {
    operation: "whatsapp",
    op: args.op,
    chat: args.chat,
    limit: args.limit,
    text: args.text,
    etapa: args.etapa,
    mediaId: args.mediaId,
  };
};

const normalizeProcess = (args: Record<string, unknown>): unknown => {
  const allowed = new Set(["executable", "argv", "cwd", "env", "stdin", "timeoutMs", "networkProfile"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw new ExecutionRequestError("request contains unsupported fields");
  return {
    operation: "process.run",
    executable: args.executable,
    argv: args.argv,
    cwd: args.cwd,
    env: args.env,
    stdin: args.stdin,
    timeoutMs: args.timeoutMs,
    networkProfile: args.networkProfile,
  };
};

const exactArgs = (args: Record<string, unknown>, keys: readonly string[]): void => {
  const allowed = new Set(keys);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw new ExecutionRequestError("request contains unsupported fields");
};

const normalizeBrowser = (name: string, args: Record<string, unknown>): unknown => {
  switch (name) {
    case "browser_open":
      exactArgs(args, ["url"]);
      return { operation: "browser.open", ...(args.url === undefined ? {} : { url: args.url }) };
    case "browser_navigate":
      exactArgs(args, ["url"]);
      return { operation: "browser.navigate", url: args.url };
    case "browser_snapshot":
      exactArgs(args, ["includeText"]);
      return { operation: "browser.snapshot", ...(args.includeText === undefined ? {} : { includeText: args.includeText }) };
    case "browser_click":
      exactArgs(args, ["x", "y", "button", "clickCount"]);
      return {
        operation: "browser.click",
        x: args.x,
        y: args.y,
        ...(args.button === undefined ? {} : { button: args.button }),
        ...(args.clickCount === undefined ? {} : { clickCount: args.clickCount }),
      };
    case "browser_click_element":
      exactArgs(args, ["elementId"]);
      return { operation: "browser.click_element", elementId: args.elementId };
    case "browser_scroll":
      exactArgs(args, ["deltaX", "deltaY"]);
      return { operation: "browser.scroll", deltaX: args.deltaX, deltaY: args.deltaY };
    case "browser_press_key":
      exactArgs(args, ["key"]);
      return { operation: "browser.press_key", key: args.key };
    case "browser_type":
      exactArgs(args, ["text"]);
      return { operation: "browser.type", text: args.text };
    case "browser_upload":
      exactArgs(args, ["selector", "path"]);
      return { operation: "browser.upload", selector: args.selector, path: args.path };
    case "browser_screenshot":
      exactArgs(args, ["fullPage"]);
      return { operation: "browser.screenshot", ...(args.fullPage === undefined ? {} : { fullPage: args.fullPage }) };
    case "browser_handoff":
      exactArgs(args, []);
      return { operation: "browser.handoff" };
    case "browser_close":
      exactArgs(args, []);
      return { operation: "browser.close" };
    default:
      throw new ExecutionRequestError("browser tool is unsupported");
  }
};

export function toolCallToExecutionRequest(call: ProviderToolCall): ToolRequestParseResult {
  try {
    if (call.id.length === 0) throw new ExecutionRequestError("tool call id is missing");
    const args = asRecord(call);
    let input: unknown;
    switch (call.function.name) {
      case "workspace_info": input = { ...args, operation: "workspace.info" }; break;
      case "file": input = normalizeFile(args); break;
      case "search_files":
      case "search_text": input = normalizeSearch(call.function.name, args); break;
      case "process_run": input = normalizeProcess(args); break;
      case "whatsapp": input = normalizeWhatsapp(args); break;
      case "browser_open":
      case "browser_navigate":
      case "browser_snapshot":
      case "browser_click":
      case "browser_click_element":
      case "browser_scroll":
      case "browser_press_key":
      case "browser_type":
      case "browser_upload":
      case "browser_screenshot":
      case "browser_handoff":
      case "browser_close": input = normalizeBrowser(call.function.name, args); break;
      case "shell": throw new ExecutionRequestError("shell is disabled; use structured tools");
      default: throw new ExecutionRequestError("tool is unsupported");
    }
    return { request: parseExecutionRequest(input) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "tool request is invalid" };
  }
}
