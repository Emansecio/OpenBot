import type { ExecutionRequest } from "./contracts.js";

/** Bot-relative or absolute paths a request names, as written (audit and shared-mount routing). */
export function extractRequestPaths(request: ExecutionRequest): string[] {
  switch (request.operation) {
    case "file.list":
    case "file.stat":
    case "file.mkdir":
    case "file.trash":
    case "file.read":
    case "file.write":
      return [request.path];
    case "file.copy":
    case "file.move":
      return [request.source, request.destination];
    case "file.restore":
      return [request.path ?? ""];
    case "command.run":
      return [request.cwd, ...request.params.paths];
    default:
      return [];
  }
}
