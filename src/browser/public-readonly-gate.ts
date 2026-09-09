import type { BrowserCommand } from "./protocol.js";

/**
 * Deliberately tiny public surface used by the opt-in external browser gate.
 * These are exact URLs, rather than origins, so a path/query/fragment cannot
 * silently expand the scope of a public run.
 */
export const PUBLIC_READONLY_URLS = [
  "https://example.com/",
  "https://www.iana.org/",
] as const;

export type PublicReadonlyUrl = (typeof PUBLIC_READONLY_URLS)[number];
export type PublicReadonlyStatus = "GREEN" | "BLOCKED_ENV" | "RED";

export class PublicReadonlyGateError extends Error {
  readonly code:
    | "PUBLIC_READONLY_URL_FORBIDDEN"
    | "PUBLIC_READONLY_COMMAND_FORBIDDEN";

  constructor(
    code: PublicReadonlyGateError["code"],
    message: string,
  ) {
    super(message);
    this.name = "PublicReadonlyGateError";
    this.code = code;
  }
}

/** Validate and canonicalize a URL against the fixed public gate allowlist. */
export function assertPublicReadonlyUrl(value: string): PublicReadonlyUrl {
  if (typeof value !== "string" || value.length === 0) {
    throw new PublicReadonlyGateError("PUBLIC_READONLY_URL_FORBIDDEN", "public browser gate requires an HTTPS URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublicReadonlyGateError("PUBLIC_READONLY_URL_FORBIDDEN", "public browser gate URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new PublicReadonlyGateError(
      "PUBLIC_READONLY_URL_FORBIDDEN",
      "public browser gate permits HTTPS URLs without credentials, query, or fragment",
    );
  }
  const canonical = parsed.href;
  if (!(PUBLIC_READONLY_URLS as readonly string[]).includes(canonical)) {
    throw new PublicReadonlyGateError(
      "PUBLIC_READONLY_URL_FORBIDDEN",
      "public browser gate URL is not in the fixed allowlist",
    );
  }
  return canonical as PublicReadonlyUrl;
}

/**
 * The public gate is intentionally narrower than the product browser API.
 * Anything not listed here, including click/type/form/upload/download/popup
 * behavior, is rejected before it can reach Electron.
 */
export function assertPublicReadonlyCommand(command: BrowserCommand): BrowserCommand {
  if (typeof command !== "object" || command === null || typeof command.command !== "string") {
    throw forbiddenCommand();
  }
  switch (command.command) {
    case "open":
      assertExactKeys(command, ["command", "url"]);
      if (typeof command.url !== "string") throw forbiddenCommand();
      assertPublicReadonlyUrl(command.url);
      return command;
    case "navigate":
      assertExactKeys(command, ["command", "url"]);
      assertPublicReadonlyUrl(command.url);
      return command;
    case "snapshot":
      assertExactKeys(command, ["command", "includeText"]);
      if (command.includeText !== undefined && typeof command.includeText !== "boolean") throw forbiddenCommand();
      return command;
    case "screenshot":
      assertExactKeys(command, ["command", "fullPage"]);
      if (command.fullPage !== undefined && typeof command.fullPage !== "boolean") throw forbiddenCommand();
      return command;
    default:
      throw forbiddenCommand();
  }
}

/** Classify external reachability failures without turning them into GREEN. */
export function classifyPublicReadonlyFailure(error: unknown): PublicReadonlyStatus {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  const message = error instanceof Error ? error.message : String(error);
  const haystack = `${code} ${message}`.toLowerCase();
  if (
    code === "dns_timeout" ||
    code === "no-addresses" ||
    code === "upstream_timeout" ||
    /dns resolution timed out|target has no dns answers|upstream connection failed|network is unreachable|err_name_not_resolved|err_internet_disconnected|err_network_changed|err_connection_|err_timed_out|err_tunnel_connection_failed|err_proxy_connection_failed|err_ssl_|err_cert_|certificate|tls/iu.test(haystack)
  ) {
    return "BLOCKED_ENV";
  }
  return "RED";
}

function forbiddenCommand(): PublicReadonlyGateError {
  return new PublicReadonlyGateError(
    "PUBLIC_READONLY_COMMAND_FORBIDDEN",
    "public browser gate allows only open, navigate, snapshot, and screenshot; forms, upload, download, popup, and mutating actions are forbidden",
  );
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw forbiddenCommand();
}
