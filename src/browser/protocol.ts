import { randomBytes } from "node:crypto";

/** The only messages accepted by the browser host wire protocol. */
export const BROWSER_PROTOCOL_VERSION = 1 as const;
export const MAX_BROWSER_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_BROWSER_TEXT_BYTES = 64 * 1024;
export const MAX_BROWSER_SNAPSHOT_TEXT_BYTES = 128 * 1024;
export const MAX_BROWSER_UPLOAD_PATH_BYTES = 4096;
export const MAX_BROWSER_UPLOAD_SELECTOR_BYTES = 4096;
export const MAX_BROWSER_UPLOAD_BYTES = 4 * 1024 * 1024;

export type BrowserCommandName =
  | "open"
  | "navigate"
  | "snapshot"
  | "click"
  | "click_element"
  | "scroll"
  | "press_key"
  | "type"
  | "upload"
  | "screenshot"
  | "close"
  | "handoff";

export type BrowserCommand =
  | { command: "open"; url?: string }
  | { command: "navigate"; url: string }
  | { command: "snapshot"; includeText?: boolean }
  | { command: "click"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number }
  | { command: "click_element"; elementId: string }
  | { command: "scroll"; deltaX: number; deltaY: number }
  | { command: "press_key"; key: BrowserKey }
  | { command: "type"; text: string }
  | { command: "upload"; selector: string; path: string }
  | { command: "screenshot"; fullPage?: boolean }
  | { command: "close" }
  | { command: "handoff" };

/** Out-of-band host command used to stop a request that is already running. */
export interface BrowserCancelCommand {
  command: "cancel";
  targetId: string;
}

export type BrowserInternalCommand = BrowserCommand | { command: "reset" } | BrowserCancelCommand;

export interface BrowserLeaseDescriptor {
  leaseId: string;
  agentId: string;
  sessionId: string;
  tabId: string;
  partition: string;
  downloadRoot: string;
  expiresAt: number;
}

export interface BrowserScreenshot {
  mimeType: "image/png";
  dataBase64: string;
  width: number;
  height: number;
}

export type BrowserKey = "ENTER" | "TAB" | "ESCAPE" | "SPACE" | "ARROWUP" | "ARROWDOWN" | "ARROWLEFT" | "ARROWRIGHT" | "BACKSPACE";

export interface BrowserInteractiveElement {
  id: string;
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  disabled?: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text?: string;
  screenshot: BrowserScreenshot;
  elements?: BrowserInteractiveElement[];
  viewport: { width: number; height: number; deviceScaleFactor: number };
}

export interface BrowserUpload {
  selector: string;
  fileName: string;
  bytes: number;
}

export interface BrowserCommandResult {
  command: BrowserCommandName;
  tabId: string;
  url?: string;
  title?: string;
  visible?: boolean;
  upload?: BrowserUpload;
  snapshot?: BrowserSnapshot;
  screenshot?: BrowserScreenshot;
}

export interface BrowserHostCommandResult extends Omit<BrowserCommandResult, "command"> {
  command: BrowserCommandName | "reset" | "cancel";
}

export interface BrowserHostRequest {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: "request";
  id: string;
  token: string;
  agentId: string;
  sessionId: string;
  tabId: string;
  partition: string;
  downloadRoot: string;
  /** Trusted server-resolved home root; required for upload commands. */
  homeRoot?: string;
  command: BrowserInternalCommand;
}

export interface BrowserHostResponse {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: "response";
  id: string;
  ok: boolean;
  result?: BrowserHostCommandResult;
  error?: { code: string; message: string };
}

export interface BrowserHostReady {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: "ready";
  hostVersion: string;
}

export interface BrowserHostEvent {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: "event";
  event: "download";
  tabId: string;
  path: string;
  /** Download lifecycle data is optional for compatibility with older hosts. */
  state?: "completed" | "cancelled" | "interrupted" | "limit";
  bytes?: number;
}

export type BrowserHostMessage = BrowserHostResponse | BrowserHostReady | BrowserHostEvent;

export function createRequestId(): string {
  return randomBytes(16).toString("hex");
}

export function createAuthToken(): string {
  return randomBytes(32).toString("hex");
}

export function encodeBrowserFrame(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") {
    throw new Error("browser frame is not serializable");
  }
  const byteLength = Buffer.byteLength(encoded, "utf8");
  if (byteLength > MAX_BROWSER_FRAME_BYTES) {
    throw new Error(`browser frame exceeds ${MAX_BROWSER_FRAME_BYTES} bytes`);
  }
  return `${encoded}\n`;
}

export function parseBrowserHostMessage(line: string): BrowserHostMessage {
  if (Buffer.byteLength(line, "utf8") > MAX_BROWSER_FRAME_BYTES) {
    throw new Error("browser frame exceeds maximum size");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("browser host sent invalid JSON");
  }
  if (!isRecord(value) || value.protocolVersion !== BROWSER_PROTOCOL_VERSION || typeof value.kind !== "string") {
    throw new Error("browser host sent an invalid protocol message");
  }
  if (value.kind === "ready") {
    assertMessageKeys(value, ["protocolVersion", "kind", "hostVersion"]);
    if (typeof value.hostVersion !== "string") throw new Error("browser host ready message is invalid");
    return { protocolVersion: BROWSER_PROTOCOL_VERSION, kind: "ready", hostVersion: value.hostVersion };
  }
  if (value.kind === "event") {
    assertMessageKeys(value, ["protocolVersion", "kind", "event", "tabId", "path", "state", "bytes"]);
    if (value.event !== "download" || typeof value.tabId !== "string" || typeof value.path !== "string") {
      throw new Error("browser host event is invalid");
    }
    if (value.state !== undefined && value.state !== "completed" && value.state !== "cancelled" && value.state !== "interrupted" && value.state !== "limit") {
      throw new Error("browser host download state is invalid");
    }
    if (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes < 0)) {
      throw new Error("browser host download byte count is invalid");
    }
    return {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: "event",
      event: "download",
      tabId: value.tabId,
      path: value.path,
      ...(value.state === undefined ? {} : { state: value.state }),
      ...(value.bytes === undefined ? {} : { bytes: value.bytes }),
    };
  }
  if (value.kind !== "response" || typeof value.id !== "string" || typeof value.ok !== "boolean") {
    throw new Error("browser host response is invalid");
  }
  if (!value.ok) {
    assertMessageKeys(value, ["protocolVersion", "kind", "id", "ok", "error"]);
    if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
      throw new Error("browser host error response is invalid");
    }
    return {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: "response",
      id: value.id,
      ok: false,
      error: { code: value.error.code, message: value.error.message },
    };
  }
  assertMessageKeys(value, ["protocolVersion", "kind", "id", "ok", "result"]);
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    kind: "response",
    id: value.id,
    ok: true,
    ...(isRecord(value.result) ? { result: value.result as unknown as BrowserHostCommandResult } : {}),
  };
}

export function assertSafeBrowserUrl(url: string, allowBlank = false): string {
  if (typeof url !== "string" || url.length === 0 || url.length > 8_192) {
    throw new Error("browser URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    if (allowBlank && url === "about:blank") return url;
    throw new Error("browser URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    if (allowBlank && url === "about:blank") return url;
    throw new Error("browser URL protocol is not allowed");
  }
  return parsed.toString();
}

/**
 * Upload paths are model-facing relative paths. Windows absolute paths,
 * drive-relative paths and traversal components never cross this seam.
 * Filesystem link/reparse validation is performed again by the home sandbox
 * and the Electron host immediately before reading the file.
 */
export function assertSafeBrowserUploadPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_BROWSER_UPLOAD_PATH_BYTES
  ) {
    throw new Error("browser upload path is invalid");
  }
  if (/^[\\/]/u.test(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error("browser upload path must be relative to the home");
  }
  const components = value.split(/[\\/]/u);
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
    if (components.some((component) => component === "..")) throw new Error("browser upload path is outside the home");
    throw new Error("browser upload path is invalid");
  }
  return value;
}

export function assertSafeBrowserUploadSelector(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_BROWSER_UPLOAD_SELECTOR_BYTES
  ) {
    throw new Error("browser upload selector is invalid");
  }
  return value;
}

export function validateBrowserCommand(command: BrowserCommand): BrowserCommand {
  if (!isRecord(command) || typeof command.command !== "string") throw new Error("browser command is invalid");
  switch (command.command) {
    case "open":
      assertExactKeys(command, ["command", "url"]);
      if (command.url !== undefined) assertSafeBrowserUrl(command.url, true);
      return command;
    case "navigate":
      assertExactKeys(command, ["command", "url"]);
      assertSafeBrowserUrl(command.url);
      return command;
    case "snapshot":
      assertExactKeys(command, ["command", "includeText"]);
      if (command.includeText !== undefined && typeof command.includeText !== "boolean") throw new Error("snapshot includeText is invalid");
      return command;
    case "click":
      assertExactKeys(command, ["command", "x", "y", "button", "clickCount"]);
      if (!Number.isFinite(command.x) || !Number.isFinite(command.y) || command.x < 0 || command.y < 0) throw new Error("click coordinates are invalid");
      if (command.button !== undefined && command.button !== "left" && command.button !== "middle" && command.button !== "right") throw new Error("click button is invalid");
      if (command.clickCount !== undefined && (!Number.isInteger(command.clickCount) || command.clickCount < 1 || command.clickCount > 3)) throw new Error("click count is invalid");
      return command;
    case "click_element":
      assertExactKeys(command, ["command", "elementId"]);
      if (typeof command.elementId !== "string" || !/^ob-el-[1-9][0-9]{0,5}$/u.test(command.elementId)) throw new Error("browser element id is invalid");
      return command;
    case "scroll":
      assertExactKeys(command, ["command", "deltaX", "deltaY"]);
      if (!Number.isFinite(command.deltaX) || !Number.isFinite(command.deltaY) || Math.abs(command.deltaX) > 10_000 || Math.abs(command.deltaY) > 10_000) {
        throw new Error("browser scroll delta is invalid");
      }
      return command;
    case "press_key":
      assertExactKeys(command, ["command", "key"]);
      if (!["ENTER", "TAB", "ESCAPE", "SPACE", "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT", "BACKSPACE"].includes(command.key)) {
        throw new Error("browser key is invalid");
      }
      return command;
    case "type":
      assertExactKeys(command, ["command", "text"]);
      if (typeof command.text !== "string" || Buffer.byteLength(command.text, "utf8") > MAX_BROWSER_TEXT_BYTES) throw new Error("browser text is invalid or too large");
      return command;
    case "upload":
      assertExactKeys(command, ["command", "selector", "path"]);
      assertSafeBrowserUploadSelector(command.selector);
      assertSafeBrowserUploadPath(command.path);
      return command;
    case "screenshot":
      assertExactKeys(command, ["command", "fullPage"]);
      if (command.fullPage !== undefined && typeof command.fullPage !== "boolean") throw new Error("screenshot fullPage is invalid");
      return command;
    case "close":
    case "handoff":
      assertExactKeys(command, ["command"]);
      return command;
    default:
      throw new Error("browser command is not supported");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("browser command contains unsupported fields");
}

function assertMessageKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("browser host message contains unsupported fields");
}
