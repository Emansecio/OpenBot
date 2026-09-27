/**
 * Identity of the checkout and build a gateway process runs from.
 *
 * `/health` reports it so the desktop launcher can tell, without inspecting
 * processes, whether the gateway on the port belongs to this checkout
 * (`rootId`) and still runs the current build (`build`). The launcher
 * computes the same values from disk (scripts/gateway-control.mjs); both
 * sides must keep the algorithm in sync.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildIdentity {
  /** First 16 hex chars of sha256(lowercased absolute checkout root). */
  rootId: string;
  /** mtime (ms) of dist/main.js when this process loaded it. */
  build: string;
}

export function checkoutRootId(root: string): string {
  return createHash("sha256").update(resolve(root).toLowerCase()).digest("hex").slice(0, 16);
}

export function buildStamp(root: string): string {
  try {
    return String(Math.trunc(statSync(join(root, "dist", "main.js")).mtimeMs));
  } catch {
    return "unknown";
  }
}

let cached: BuildIdentity | undefined;

/** Captured once per process: a rebuild on disk makes the running gateway stale. */
export function currentBuildIdentity(): BuildIdentity {
  if (cached === undefined) {
    // dist/server/build-identity.js -> checkout root
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    cached = { rootId: checkoutRootId(root), build: buildStamp(root) };
  }
  return cached;
}
