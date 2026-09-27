/**
 * T4 — Backends de criptografia da keystore (src/keystore/).
 *
 * A keystore NUNCA vê o segredo em claro no disco. Todo valor é cifrado pelo
 * backend antes de ser serializado em `sand-secrets.json`. Os backends:
 *
 *   - `dpapi-current-user` (dpapi.ts) — PRODUÇÃO no Windows: DPAPI do usuário
 *     atual através do addon nativo em `native/dpapi`.
 *   - `electron-safe-storage` (dpapi.ts) — somente LEITURA de registros antigos
 *     gravados pelo safeStorage do Electron, que também são blobs DPAPI.
 *   - `local-file` — AES-256-GCM com a chave em `<dir>/.master.key`. Formato
 *     anterior ao DPAPI; os registros migram para DPAPI no primeiro uso.
 *     Também é o backend explícito fora do Windows (`OPENBOT_KEYSTORE_BACKEND`).
 *   - `memory` — AES-256-GCM com chave aleatória por processo. Nada chega ao
 *     disco e nada sobrevive ao restart; usado por testes e diagnósticos.
 *
 * Formato dos registros no arquivo:
 *   { "scoped:v1:provider:<name>:apiKey": { "backend":"dpapi-current-user", "data":"<base64>" } }
 * A tag `backend` escolhe o backend de decrypt correto na leitura.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dpapiCurrentUserBackend, dpapiLegacyReadBackend } from "./dpapi.js";

/** Interface única que a keystore usa para cifrar/decifrar valores. */
export interface CryptoBackend {
  /** Nome canônico do backend — gravado como tag no arquivo de secrets. */
  readonly name: string;
  encrypt(value: string): Buffer;
  decrypt(payload: Buffer): string;
}

/** Formato on-disk de um único registro cifrado. */
export interface EncryptedEntry {
  backend: string;
  data: string; // base64
}

/** Chave do namespace de provider (spec §3.3 / plano §3 T4). */
export const PROVIDER_API_KEY_NAMESPACE =
  "scoped:v1:provider" as const;

/**
 * Monta a chave completa de um segredo de provider.
 * `scoped:v1:provider:<name>:apiKey` — o `<name>` é o provider (openai, xai,
 * openai-compat), validado com o mesmo padrão de `isProviderNameValid`.
 */
export function providerApiKeyKey(provider: string): string {
  return `${PROVIDER_API_KEY_NAMESPACE}:${provider}:apiKey`;
}

/**
 * Valida o nome de um provider. Aceita minúsculas, dígitos e hífens
 * (ex.: `openai`, `xai`, `openai-compat`, `lm-studio`). Rejeita `:` (quebraria
 * o namespace), espaço e outros caracteres de controle.
 */
export function isProviderNameValid(provider: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(provider);
}

const AES_ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** AES-256-GCM com layout `iv || tag || ciphertext`, compartilhado pelos backends em software. */
function aesGcmBackend(name: string, key: Buffer): CryptoBackend {
  return {
    name,
    encrypt(value: string): Buffer {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(AES_ALGO, key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(payload: Buffer): string {
      if (payload.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error(`keystore: payload cifrado inválido (${name})`);
      }
      const iv = payload.subarray(0, IV_LENGTH);
      const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
      const decipher = createDecipheriv(AES_ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}

/**
 * Backend de MEMÓRIA: cifra com uma chave aleatória por processo — o valor
 * NUNCA chega ao disco e o término do processo invalida os dados.
 */
export function memoryBackend(): CryptoBackend {
  return aesGcmBackend("memory", randomBytes(32));
}

/**
 * Backend persistente em disco (AES-256-GCM). A chave-mestra fica em
 * `<dir>/.master.key`. Não é DPAPI; no Windows os registros migram para DPAPI.
 */
export function localFileBackend(masterKey: Buffer): CryptoBackend {
  if (masterKey.length !== 32) throw new Error("keystore: chave-mestra deve ter 32 bytes");
  return aesGcmBackend("local-file", Buffer.from(masterKey));
}

/**
 * Exceção única de estado: "o keyring não está disponível". A keystore usa
 * isto para escolher o backend persistente em software fora do Windows.
 */
export class KeyringUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringUnavailableError";
  }
}

/** Converte um payload Buffer para base64 (formato do arquivo). */
export function entryToBase64(payload: Buffer): string {
  return payload.toString("base64");
}

/** Converte base64 do arquivo de volta para Buffer. */
export function entryFromBase64(data: string): Buffer {
  return Buffer.from(data, "base64");
}

/** Backend de escrita do processo: DPAPI no Windows. */
export function resolveWriteBackend(): CryptoBackend {
  if (process.platform === "win32") return dpapiCurrentUserBackend();
  throw new KeyringUnavailableError("keystore: DPAPI indisponível fora do Windows");
}

/** Backend de leitura dos registros `electron-safe-storage` (blobs DPAPI antigos). */
export function resolveLegacyReadBackend(): CryptoBackend {
  if (process.platform === "win32") return dpapiLegacyReadBackend();
  throw new KeyringUnavailableError("keystore: registros DPAPI legados exigem Windows");
}
