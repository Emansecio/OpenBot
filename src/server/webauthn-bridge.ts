import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { RpcError, type GatewayBridgeHandler } from "./gateway.js";

const MAX_OPTIONS_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const CEREMONY_TIMEOUT_MS = 120_000;
const defaultSignerPath = fileURLToPath(new URL("../../client/extracted/dist/native/sand-webauthn-signer.exe", import.meta.url));
const SIGNER_ENV_ALLOWLIST = new Set(["COMSPEC", "PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "WINDIR"]);

const signerEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(
  Object.entries(process.env).filter(([key, value]) => value !== undefined && SIGNER_ENV_ALLOWLIST.has(key.toUpperCase())),
);

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RpcError(400, "webauthn: body must be an object");
  }
  return value as Record<string, unknown>;
};

const text = (body: Record<string, unknown>, key: string, max: number): string => {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new RpcError(400, "webauthn: " + key + " is invalid");
  }
  return value;
};

const validOrigin = (value: string): boolean => {
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" || (origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname));
  } catch {
    return false;
  }
};

async function runSigner(signerPath: string, input: string): Promise<unknown> {
  await access(signerPath, fsConstants.F_OK).catch(() => {
    throw new RpcError(503, "WebAuthn signer is unavailable");
  });
  return new Promise((resolve, reject) => {
    const child = spawn(signerPath, [], {
      env: signerEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const fail = (error: Error): void => finish(() => reject(error));
    const timeout = setTimeout(() => {
      child.kill();
      fail(new RpcError(504, "WebAuthn ceremony timed out"));
    }, CEREMONY_TIMEOUT_MS);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESULT_BYTES) {
        child.kill();
        fail(new RpcError(502, "WebAuthn signer response is too large"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => fail(new RpcError(503, "WebAuthn signer failed: " + error.message)));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        fail(new RpcError(502, detail || "WebAuthn signer rejected the ceremony"));
        return;
      }
      let result: unknown;
      try {
        result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown;
      } catch {
        fail(new RpcError(502, "WebAuthn signer returned invalid JSON"));
        return;
      }
      finish(() => resolve(result));
    });
    child.stdin.end(input);
  });
}

export function createWebauthnBridge(signerPath = defaultSignerPath): GatewayBridgeHandler {
  return async (path, rawBody) => {
    if (path !== "/webauthn/ceremony") throw new RpcError(404, "webauthn route not found");
    const body = record(rawBody);
    const kind = body.kind;
    if (kind !== "get" && kind !== "create") throw new RpcError(400, "webauthn: kind must be get or create");
    const origin = text(body, "origin", 2048);
    if (!validOrigin(origin)) throw new RpcError(400, "webauthn: origin is invalid");
    const optionsJson = text(body, "optionsJson", MAX_OPTIONS_BYTES);
    try {
      const options = JSON.parse(optionsJson) as unknown;
      if (typeof options !== "object" || options === null || Array.isArray(options)) throw new Error("not-object");
    } catch {
      throw new RpcError(400, "webauthn: optionsJson is invalid");
    }
    return runSigner(signerPath, JSON.stringify({ kind, origin, optionsJson }));
  };
}
