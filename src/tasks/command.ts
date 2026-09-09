import { parseExecutionRequest, type ExecutionRequest, type ExecutionResult } from "../execution/contracts.js";
import { parseDelegatedBrowserOrigin, type DelegatedCapabilityKind } from "./contracts.js";

export type AsyncTaskCommandV1 =
  | { readonly version: 1; readonly kind: "filesystem"; readonly request: ExecutionRequest }
  | { readonly version: 1; readonly kind: "process"; readonly request: Extract<ExecutionRequest, { operation: "process.run" }> }
  | { readonly version: 1; readonly kind: "browser"; readonly origin: string; readonly request: Extract<ExecutionRequest, { operation: `browser.${string}` }> }
  | { readonly version: 1; readonly kind: "mcp"; readonly request: { readonly serverId: string; readonly toolName: string; readonly args: Record<string, unknown> } }
  | { readonly version: 1; readonly kind: "skill"; readonly request: { readonly skillId: string; readonly args: Record<string, unknown> } };

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const expected = new Set(fields);
  if (Object.keys(value).some((key) => !expected.has(key)) || fields.some((field) => !(field in value))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/** Parse a canonical, text-only command. Ambiguous prose fails closed. */
export function parseAsyncTaskCommandV1(objective: string, expectedKind: Exclude<DelegatedCapabilityKind, "provider">): AsyncTaskCommandV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(objective) as unknown; } catch { throw new Error("non-provider task objective must be canonical JSON command"); }
  if (JSON.stringify(parsed) !== objective) throw new Error("task command JSON must be canonical and whitespace-free");
  const command = object(parsed, "task command");
  exact(command, expectedKind === "browser" ? ["version", "kind", "origin", "request"] : ["version", "kind", "request"], "task command");
  if (command.version !== 1 || command.kind !== expectedKind) throw new Error("task command kind/version does not match grant");
  if (expectedKind === "mcp" || expectedKind === "skill") {
    const request = object(command.request, "task command request");
    exact(request, expectedKind === "mcp" ? ["serverId", "toolName", "args"] : ["skillId", "args"], "task command request");
    const idField = expectedKind === "mcp" ? "serverId" : "skillId";
    const id = boundedIdentifier(request[idField], `task command ${idField}`);
    const toolName = expectedKind === "mcp" ? boundedIdentifier(request.toolName, "task command toolName") : undefined;
    const args = object(request.args, "task command args");
    return expectedKind === "mcp"
      ? { version: 1, kind: "mcp", request: { serverId: id, toolName: toolName!, args } }
      : { version: 1, kind: "skill", request: { skillId: id, args } };
  }
  const request = parseExecutionRequest(command.request);
  if (expectedKind === "process" && request.operation !== "process.run") throw new Error("process task requires process.run");
  if (expectedKind === "browser" && !request.operation.startsWith("browser.")) throw new Error("browser task requires browser operation");
  if (expectedKind === "filesystem" && !request.operation.startsWith("file.") && request.operation !== "command.run") throw new Error("filesystem task requires file/search operation");
  if (expectedKind === "browser") {
    return { version: 1, kind: "browser", origin: parseDelegatedBrowserOrigin(command.origin), request: request as Extract<ExecutionRequest, { operation: `browser.${string}` }> };
  }
  return { version: 1, kind: expectedKind, request } as AsyncTaskCommandV1;
}

export function executionResultText(result: ExecutionResult): string {
  return JSON.stringify(result);
}
