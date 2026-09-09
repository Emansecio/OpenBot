import { createHash } from "node:crypto";

import type { ExecutionRequest } from "../contracts.js";
import type { RuntimeCapability } from "./contracts.js";

const exact = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("runtime capability contains unsupported fields");
};

export function parseRuntimeCapability(value: unknown): RuntimeCapability {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime capability must be an object");
  }
  const input = value as Record<string, unknown>;
  exact(input, ["kind", "networkProfile"]);
  if (input.kind !== "process.run") throw new Error("runtime capability is unsupported");
  if (input.networkProfile !== "none" && input.networkProfile !== "host") throw new Error("runtime network profile is unsupported");
  return { kind: "process.run", networkProfile: input.networkProfile };
}

export function runtimeCapabilityForRequest(request: ExecutionRequest): RuntimeCapability {
  if (request.operation !== "process.run") throw new Error("execution operation does not require the WSL runtime");
  return parseRuntimeCapability({ kind: "process.run", networkProfile: request.networkProfile });
}

export function capabilityDigest(capability: RuntimeCapability): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind: capability.kind, networkProfile: capability.networkProfile }))
    .digest("hex");
}
