/**
 * T4 — Backends de criptografia da keystore (src/keystore/).
 *
 * A keystore NUNCA vê o segredo em claro no disco. Todo valor é cifrado pelo
 * backend antes de ser serializado em `sand-secrets.json`. Os backends:
 *
 *   - `electronSafeStorageBackend`  — PRODUÇÃO (Windows): delega para o
 *     `safeStorage` real do Electron (DPAPI). Este módulo roda em Node puro
 *     (shim standalone, MVP), então o safeStorage NÃO existe aqui — o main do
 *     Electron injeta a implementação na integração (utilityProcess), ver
 *     "Integração Electron (utilityProcess)" no fim deste arquivo.
 *   - `nodeLegacyBackend`           — fallback somente para LEITURA: descriptografa
 *     registros já gravados por uma sessão anterior do Electron safeStorage
 *     (DPAPI) quando esta sessão roda em Node puro sem safeStorage. Só tem
 *     `decrypt`; NUNCA grava nada (nenhum plaintext novo é gravado).
 *   - `memoryBackend`               — fallback em MEMÓRIA quando não existe
 *     keyring utilizável (Windows sem perfil de usuário / winlogon off, Linux
 *     `basic_text` não opt-in etc.). Mesmo assim o valor NUNCA é gravado em
 *     disco: ele vive apenas no processo. Persistência entre restarts NÃO é
 *     garantida nesse modo (documentado; spec §3.3 — "fallback em memória
 *     quando o keyring não está disponível (nunca grava plaintext novo)").
 *
 * Formato dos registros no arquivo:
 *   { "scoped:v1:provider:<name>:apiKey": { "backend":"electron-safe-storage", "data":"<base64>" } }
 * A tag `backend` permite escolher o backend de decrypt correto na leitura
 * (um registro gravado com safeStorage só pode ser lido por ele).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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

/** Deriva uma chave de 32 bytes para um dado `secret` (SHA-256). */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * SafeStorage do Electron — a assinatura real é
 * `encryptString(plainText: string): Buffer` e `decryptString(buffer: Buffer): string`.
 */
export interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Backend de PRODUÇÃO (Windows, DPAPI). Em Node puro não instanciamos isto —
 * o main do Electron injeta via `injectElectronSafeStorage` na integração.
 */
export function electronSafeStorageBackend(
  ss: ElectronSafeStorage,
): CryptoBackend {
  return {
    name: "electron-safe-storage",
    encrypt(value: string): Buffer {
      return ss.encryptString(value);
    },
    decrypt(payload: Buffer): string {
      return ss.decryptString(payload);
    },
  };
}

/**
 * Backend de LEGADO (somente leitura): descriptografa registros gravados por
 * uma sessão anterior do Electron safeStorage (DPAPI) quando esta sessão roda
 * em Node puro sem acesso ao safeStorage. `encrypt` NUNCA é chamado — ele
 * lança, garantindo que nenhum plaintext novo seja gravado por este backend.
 */
export function nodeLegacyBackend(ss: ElectronSafeStorage): CryptoBackend {
  return {
    name: "electron-safe-storage",
    encrypt(): Buffer {
      throw new Error(
        "keystore: legacy backend é somente leitura — nunca grava plaintext novo",
      );
    },
    decrypt(payload: Buffer): string {
      return ss.decryptString(payload);
    },
  };
}

const AES_ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Backend de MEMÓRIA (fallback seguro): cifra o valor com AES-256-GCM usando
 * uma chave aleatória gerada por processo — o valor NUNCA chega ao disco.
 * Destruir a keystore (processo termina) invalida os dados, como esperado
 * para um fallback em memória.
 */
export function memoryBackend(): CryptoBackend {
  const key = randomBytes(32);
  return {
    name: "memory",
    encrypt(value: string): Buffer {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(AES_ALGO, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, ciphertext]);
    },
    decrypt(payload: Buffer): string {
      if (payload.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error("keystore: payload cifrado inválido (memória)");
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
 * Backend em memória derivado de uma SEMENTE estável (hash do nome do host) —
 * usado APENAS para garantir round-trip em testes que precisam de um backend
 * determinístico; o fallback de produção é o `memoryBackend` (chave aleatória).
 */
export function seededMemoryBackend(seed: string): CryptoBackend {
  const key = deriveKey(`openbot-seeded:${seed}`);
  return {
    name: "memory",
    encrypt(value: string): Buffer {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(AES_ALGO, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, ciphertext]);
    },
    decrypt(payload: Buffer): string {
      if (payload.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error("keystore: payload cifrado inválido (memória)");
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
 * Exceção única de estado: "o keyring não está disponível". A keystore usa
 * isto para decidir entre o fallback em memória e o modo somente leitura.
 */
export class KeyringUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringUnavailableError";
  }
}

/**
 * DETECÇÃO do safeStorage do Electron a partir de Node puro.
 *
 * O shim roda como processo Node puro (MVP) — não há módulo `electron` no
 * runtime, então `import("electron")` lança. A heurística abaixo é um
 * "escape hatch" para AMBIENTES DE TESTE / shims que queiram imitar o DPAPI:
 *   - se `process.env.OPENBOT_KEYSTORE_BACKEND === "electron-safe-storage"`
 *     E a variável global `openbotInjectedSafeStorage` existir, usa o objeto
 *     injetado (mesma interface do safeStorage real);
 *   - caso contrário lança `KeyringUnavailableError`.
 *
 * Em produção (Electron utilityProcess) NUNCA confiamos nisto — o main injeta
 * a implementação explicitamente (ver "Integração Electron" abaixo).
 */
export function detectElectronSafeStorageFromNode(): ElectronSafeStorage {
  const wanted = process.env.OPENBOT_KEYSTORE_BACKEND;
  if (wanted === "electron-safe-storage") {
    const g = globalThis as { openbotInjectedSafeStorage?: unknown };
    const injected = g.openbotInjectedSafeStorage;
    if (isElectronSafeStorage(injected)) return injected;
  }
  throw new KeyringUnavailableError(
    "keystore: safeStorage (Electron/DPAPI) indisponível em Node puro",
  );
}

function isElectronSafeStorage(v: unknown): v is ElectronSafeStorage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.isEncryptionAvailable === "function" &&
    typeof o.encryptString === "function" &&
    typeof o.decryptString === "function"
  );
}

/** Converte um payload Buffer para base64 (formato do arquivo). */
export function entryToBase64(payload: Buffer): string {
  return payload.toString("base64");
}

/** Converte base64 do arquivo de volta para Buffer. */
export function entryFromBase64(data: string): Buffer {
  return Buffer.from(data, "base64");
}

/**
 * ── Integração Electron (utilityProcess) — documentação do contrato ────────
 *
 * No fork completo, o shim roda dentro de um `utilityProcess` do Electron
 * (plano §1 — mesmo runtime do ecossistema). O safeStorage REAL só existe no
 * processo main do Electron (é ele quem tem acesso ao keyring do Windows via
 * DPAPI). O caminho de integração, sem tocar em nada deste arquivo:
 *
 *   1. No ELECTRON-MAIN, importe `electron.safeStorage` e passe uma função
 *      `getSafeStorage()` para o utilityProcess (via `child.send()` ou env).
 *      Exemplo (main):
 *        const { utilityProcess, safeStorage } = require("electron");
 *        const child = utilityProcess.fork(join(__dirname, "shim-main.js"));
 *        child.postMessage({ type: "keystore-safe-storage",
 *          impl: safeStorage });  // MessagePort/structured-clone não clona
 *        // funções — use uma ponte de mensagens síncrona (ex.: IPC via
 *        // port.postMessage com request/response) OU re-exporte o módulo
 *        // `electron` no utilityProcess (o Electron expõe safeStorage no
 *        // utilityProcess apenas em alguns builds; verifique).
 *
 *   2. No SHIM (este processo), receba a implementação e chame:
 *        injectElectronSafeStorage(ss);
 *      A partir daí `createKeystore()` usa o safeStorage real (DPAPI).
 *
 *   3. Se o keyring não estiver disponível
 *      (`safeStorage.isEncryptionAvailable() === false`) OU o main não tiver
 *      injetado nada (roda standalone em Node puro), a keystore cai no
 *      fallback em memória (novos writes) + leitura de legado DPAPI via
 *      `nodeLegacyBackend` (registros já gravados por sessão Electron).
 *
 *   4. `waitForEncryptedStorage()` espelha o comportamento do original
 *      (spec §3.3 / mapa-funcoes §3.7): em Electron-main, o safeStorage pode
 *      demorar a ficar pronto logo após o login do Windows — o main deve
 *      aguardar `isEncryptionAvailable() === true` antes de injetar.
 *
 * Este módulo também aceita um objeto injetado via variável global
 * (`globalThis.openbotInjectedSafeStorage` + env
 * `OPENBOT_KEYSTORE_BACKEND=electron-safe-storage`) — usado apenas por testes
 * que simulam o DPAPI em Node puro.
 */

/** Estado global da implementação injetada do safeStorage (ver acima). */
let injected: ElectronSafeStorage | null = null;

/**
 * Injeta a implementação real do safeStorage (Electron-main → shim).
 * Passar `null` limpa a injeção (usado por testes para restaurar o estado).
 */
export function injectElectronSafeStorage(ss: ElectronSafeStorage | null): void {
  injected = ss;
}

/** True se uma implementação real do safeStorage foi injetada. */
export function hasElectronSafeStorage(): boolean {
  return injected !== null;
}

/** Backend de escrita do processo: safeStorage injetado ou erro claro. */
/**
 * Backend persistente em disco (AES-256-GCM). A chave-mestra fica em
 * `<dir>/.master.key` com modo 0o600. Não é DPAPI, mas sobrevive a `npm start`
 * em Node puro — o Electron continua preferível quando injetado.
 */
export function localFileBackend(masterKey: Buffer): CryptoBackend {
  if (masterKey.length !== 32) throw new Error("keystore: chave-mestra deve ter 32 bytes");
  const key = Buffer.from(masterKey);
  return {
    name: "local-file",
    encrypt(value: string): Buffer {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(AES_ALGO, key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, ciphertext]);
    },
    decrypt(payload: Buffer): string {
      if (payload.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error("keystore: payload cifrado inválido (local-file)");
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

export function resolveWriteBackend(): CryptoBackend {
  if (injected !== null && injected.isEncryptionAvailable()) {
    return electronSafeStorageBackend(injected);
  }
  // Em Node puro, tenta o escape hatch de teste (variável global + env).
  try {
    const detected = detectElectronSafeStorageFromNode();
    if (detected.isEncryptionAvailable()) {
      return electronSafeStorageBackend(detected);
    }
  } catch {
    // KeyringUnavailableError — no Windows não há fallback persistente.
  }
  if (process.platform === "win32") return dpapiCurrentUserBackend();
  throw new KeyringUnavailableError(
    "keystore: nenhum keyring disponível — use o fallback em memória",
  );
}

/** Backend de leitura de registros `electron-safe-storage` (legado DPAPI). */
export function resolveLegacyReadBackend(): CryptoBackend {
  if (injected !== null) {
    return nodeLegacyBackend(injected);
  }
  try {
    const detected = detectElectronSafeStorageFromNode();
    return nodeLegacyBackend(detected);
  } catch {
    if (process.platform === "win32") {
      try { return dpapiLegacyReadBackend(); } catch { /* sem addon */ }
    }
    throw new KeyringUnavailableError(
      "keystore: safeStorage indisponível para ler registros legados (DPAPI)",
    );
  }
}
