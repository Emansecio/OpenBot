import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CryptoBackend } from "./backend.js";

export const DPAPI_CURRENT_USER_BACKEND = "dpapi-current-user" as const;
const PAYLOAD_TAG = Buffer.from("OPENBOT-DPAPI-CURRENT-USER\x01", "ascii");
const require = createRequire(import.meta.url);

export interface DpapiAddon {
  protect(input: Buffer): Buffer;
  unprotect(input: Buffer): Buffer;
}

export interface DpapiBackendOptions {
  addon?: DpapiAddon;
  modulePath?: string;
}

function isAddon(value: unknown): value is DpapiAddon {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.protect === "function" && typeof record.unprotect === "function";
}

export function dpapiAddonPath(modulePath?: string): string {
  if (modulePath) return modulePath;
  const platformArch = `${process.platform}-${process.arch}`;
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../native/dpapi", platformArch, "openbot-dpapi.node"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../native/dpapi", platformArch, "openbot-dpapi.node"),
    path.resolve(process.cwd(), "native/dpapi", platformArch, "openbot-dpapi.node"),
  ];
  return candidates[0]!;
}

export function loadDpapiAddon(options: DpapiBackendOptions = {}): DpapiAddon {
  if (options.addon && isAddon(options.addon)) return options.addon;
  if (process.platform !== "win32") throw new Error("keystore: DPAPI CurrentUser exige Windows");
  const modulePath = dpapiAddonPath(options.modulePath);
  try {
    const loaded: unknown = require(modulePath);
    if (!isAddon(loaded)) throw new Error("módulo sem contrato DPAPI");
    return loaded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`keystore: addon DPAPI CurrentUser indisponível (${modulePath}): ${message}`, { cause: error });
  }
}

export function dpapiCurrentUserBackend(options: DpapiBackendOptions = {}): CryptoBackend {
  const addon = loadDpapiAddon(options);
  return {
    name: DPAPI_CURRENT_USER_BACKEND,
    encrypt(value: string): Buffer {
      const plain = Buffer.from(value, "utf8");
      try {
        const cipher = addon.protect(plain);
        return Buffer.concat([PAYLOAD_TAG, cipher]);
      } finally {
        plain.fill(0);
      }
    },
    decrypt(payload: Buffer): string {
      if (payload.length <= PAYLOAD_TAG.length || !payload.subarray(0, PAYLOAD_TAG.length).equals(PAYLOAD_TAG)) {
        throw new Error("keystore: payload DPAPI CurrentUser inválido");
      }
      const cipher = Buffer.from(payload.subarray(PAYLOAD_TAG.length));
      try {
        const plain = addon.unprotect(cipher);
        try {
          return plain.toString("utf8");
        } finally {
          plain.fill(0);
        }
      } finally {
        cipher.fill(0);
      }
    },
  };
}

/** Leitor compatível com blobs DPAPI antigos gravados pelo safeStorage. */
export function dpapiLegacyReadBackend(options: DpapiBackendOptions = {}): CryptoBackend {
  const addon = loadDpapiAddon(options);
  return {
    name: "electron-safe-storage",
    encrypt(): Buffer {
      throw new Error("keystore: backend DPAPI legado é somente leitura");
    },
    decrypt(payload: Buffer): string {
      const cipher = Buffer.from(payload);
      try {
        const plain = addon.unprotect(cipher);
        try {
          return plain.toString("utf8");
        } finally {
          plain.fill(0);
        }
      } finally {
        cipher.fill(0);
      }
    },
  };
}

export function isDpapiPayload(payload: Buffer): boolean {
  return payload.length > PAYLOAD_TAG.length && payload.subarray(0, PAYLOAD_TAG.length).equals(PAYLOAD_TAG);
}
