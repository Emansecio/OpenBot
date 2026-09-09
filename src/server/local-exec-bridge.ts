import type { LocalExecutionBroker } from "../execution/broker.js";
import { parseExecutionRequest, type ExecutionRequest } from "../execution/contracts.js";
import { RpcError, type GatewayBridgeHandler } from "./gateway.js";

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RpcError(400, "local-exec: body must be an object");
  }
  return value as Record<string, unknown>;
};

const requiredText = (body: Record<string, unknown>, key: string, max = 256): string => {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || value.includes("\0")) {
    throw new RpcError(400, "local-exec: " + key + " is invalid");
  }
  return value.trim();
};

/**
 * HTTP bridge for clients that cannot call the RPC route directly.
 * It deliberately reuses the same parser, approval machinery, policy and
 * audit path as the in-process tool loop; it accepts only structured
 * requests via parseExecutionRequest, and process.run executes on the
 * trusted host per the configured runner.
 */
export function createLocalExecBridge(broker: LocalExecutionBroker): GatewayBridgeHandler {
  return async (path, rawBody) => {
    if (path !== "/local-exec/execute") throw new RpcError(404, "local-exec route not found");
    const body = asRecord(rawBody);
    const agentId = requiredText(body, "agentId", 128);
    const requestId = requiredText(body, "requestId");
    let request: ExecutionRequest;
    try {
      request = parseExecutionRequest(body.request);
    } catch (error) {
      throw new RpcError(400, "local-exec: " + (error instanceof Error ? error.message : "request is invalid"));
    }
    const conversationId = body.conversationId === undefined
      ? undefined
      : requiredText(body, "conversationId", 256);
    return broker.execute(
      agentId,
      requestId,
      request,
      undefined,
      conversationId === undefined ? undefined : { conversationId },
    );
  };
}
