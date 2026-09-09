const BLOCKED_CODES = Object.freeze({
  tcp: new Set(["EPERM", "EACCES"]),
  dns: new Set(["EAI_AGAIN", "EPERM", "EACCES", "ENETUNREACH"]),
});

export function validateBlockedNetworkProbe(raw, kind) {
  if (!(kind in BLOCKED_CODES)) throw new Error(`unknown network probe kind: ${kind}`);
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error(`${kind} probe did not return structured evidence`);
  }
  if (parsed?.status !== "blocked" || typeof parsed.code !== "string" || !BLOCKED_CODES[kind].has(parsed.code)) {
    throw new Error(`${kind} egress was not fail-closed: ${String(raw)}`);
  }
  if (!Array.isArray(parsed.socketFds) || parsed.socketFds.some((value) => typeof value !== "string")) {
    throw new Error(`${kind} probe socket evidence is invalid`);
  }
  if (parsed.socketFds.length > 0) {
    throw new Error(`${kind} probe retained socket descriptors: ${JSON.stringify(parsed.socketFds)}`);
  }
  return Object.freeze({ status: parsed.status, code: parsed.code, socketFds: Object.freeze([]) });
}
