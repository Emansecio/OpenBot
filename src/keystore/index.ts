/**
 * T4 — Keystore de providers (plano §3 T4; spec §3.3; mapa-funcoes §3.7).
 *
 * Persistência de segredos do usuário em `%APPDATA%\OpenBot\sand-secrets.json`
 * com criptografia (DPAPI CurrentUser no Windows). Namespace
 * `scoped:v1:provider:<name>:apiKey` — NENHUMA chave fica em claro no disco.
 *
 * Regras (spec §3.3 / mapa-funcoes §3.7):
 *   - escrever → cifra com o backend de escrita ANTES de serializar;
 *   - ler      → decifra com o backend indicado pela tag do registro;
 *   - backend `memory` → nada é gravado; os segredos vivem só no processo.
 *
 * Integração ao gateway (plano §3 T4):
 *   - `registerKeystoreHandlers(gateway)` pluga:
 *       POST /api/setBoxSecrets      → upsert/delete de chaves por provider
 *       POST /api/getBoxSecretsStatus → {secrets: string[]} — SÓ NOMES
 *     (métodos já declarados em RPC_METHOD_TABLE, gateway.ts T3).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { BoxSecretsStatus } from "../shared/contracts.js";
import { renameWithRetry, writeFileAtomic, writeFileExclusiveSync } from "../shared/fs-atomic.js";
import { withFileLock } from "../shared/file-lock.js";
import type { Gateway, RpcHandler } from "../server/gateway.js";
import { RpcError } from "../server/gateway.js";
import {
  type CryptoBackend,
  type EncryptedEntry,
  KeyringUnavailableError,
  entryFromBase64,
  entryToBase64,
  isProviderNameValid,
  localFileBackend,
  memoryBackend,
  providerApiKeyKey,
  resolveLegacyReadBackend,
  resolveWriteBackend,
} from "./backend.js";
import { DPAPI_CURRENT_USER_BACKEND, dpapiCurrentUserBackend } from "./dpapi.js";

/** Diretório padrão dos dados do fork: `%APPDATA%\OpenBot\` (plano §1 / T14). */
export function defaultKeystoreDir(): string {
  const explicitRoot = process.env.OPENBOT_DATA_ROOT?.trim();
  if (explicitRoot) return explicitRoot;
  const appData = process.env.APPDATA;
  if (appData && appData.length > 0) return path.join(appData, "OpenBot");
  return path.join(os.homedir(), "AppData", "Roaming", "OpenBot");
}

/** Caminho do arquivo de secrets (spec §3.3). */
export function defaultSecretsFile(dir = defaultKeystoreDir()): string {
  return path.join(dir, "sand-secrets.json");
}

/** Formato on-disk v1 (legado): mapa chave → registro cifrado (nunca plaintext). */
export type SecretsFileShape = Record<string, EncryptedEntry>;

/**
 * Formato on-disk v2 (melhoria 5): segredos escopados por `agentId`.
 * Um bot nunca lê o escopo de outro. Arquivos no formato v1 migram na
 * leitura para o escopo padrão e são regravados no primeiro write.
 */
export const SECRETS_FILE_VERSION = 2;
export const DEFAULT_KEYSTORE_SCOPE = "openbot-default";
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const PROVIDER_KEY_PREFIX = "scoped:v1:provider:";
const PROVIDER_KEY_SUFFIX = ":apiKey";
const LOCK_OPTIONS = { label: "keystore", timeoutMs: 5_000 } as const;

export interface ScopedSecretsFile {
  version: typeof SECRETS_FILE_VERSION;
  scopes: Record<string, SecretsFileShape>;
}

/** Valida e normaliza o escopo; ausente → escopo padrão. */
export function normalizeKeystoreScope(agentId?: string): string {
  if (agentId === undefined || agentId.length === 0) return DEFAULT_KEYSTORE_SCOPE;
  if (!SCOPE_PATTERN.test(agentId)) {
    throw new RpcError(400, `keystore: agentId inválido: "${agentId}"`);
  }
  return agentId;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validEntries(entries: Record<string, unknown>): SecretsFileShape {
  const valid: SecretsFileShape = {};
  for (const [key, value] of Object.entries(entries)) {
    if (isPlainObject(value) && typeof value.backend === "string" && typeof value.data === "string") {
      valid[key] = { backend: value.backend, data: value.data };
    }
  }
  return valid;
}

/**
 * Aceita v2 explícito ou legado plano (v1, sem campo `version`) → escopo
 * padrão. Uma versão desconhecida é recusada: lê-la como v1 produziria um
 * arquivo vazio que o próximo write gravaria por cima dos segredos.
 */
function toScopedShape(parsed: unknown, file: string): ScopedSecretsFile {
  if (!isPlainObject(parsed)) {
    throw new Error(`keystore: ${file} não é um objeto JSON válido`);
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "version")) {
    if (parsed.version !== SECRETS_FILE_VERSION) {
      throw new Error(`keystore: ${file} usa uma versão não suportada: ${String(parsed.version)}`);
    }
    if (!isPlainObject(parsed.scopes)) throw new Error(`keystore: ${file} não tem escopos válidos`);
    const scopes: Record<string, SecretsFileShape> = {};
    for (const [scope, entries] of Object.entries(parsed.scopes)) {
      if (isPlainObject(entries)) scopes[scope] = validEntries(entries);
    }
    return { version: SECRETS_FILE_VERSION, scopes };
  }
  // Legado v1: todas as chaves pertencem ao escopo padrão.
  return { version: SECRETS_FILE_VERSION, scopes: { [DEFAULT_KEYSTORE_SCOPE]: validEntries(parsed) } };
}

function parseSecretsText(raw: string, file: string): ScopedSecretsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`keystore: ${file} não é um objeto JSON válido`, { cause: error });
  }
  return toScopedShape(parsed, file);
}

const emptySecrets = (): ScopedSecretsFile => ({ version: SECRETS_FILE_VERSION, scopes: {} });

/** Lê o arquivo de secrets (ausente → vazio). Lança em JSON inválido. */
async function readSecretsFile(file: string): Promise<ScopedSecretsFile> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptySecrets();
    throw err;
  }
  return parseSecretsText(raw, file);
}

/** Variante síncrona, usada pela hidratação da cache de redaction no boot. */
function readSecretsFileSync(file: string): ScopedSecretsFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptySecrets();
    throw err;
  }
  return parseSecretsText(raw, file);
}

const serializeSecrets = (shape: ScopedSecretsFile): string => JSON.stringify(shape, null, 2) + "\n";

/** Grava o arquivo de secrets escopado de forma atômica e durável. */
export async function writeScopedSecretsFile(file: string, shape: ScopedSecretsFile): Promise<void> {
  await writeFileAtomic(file, serializeSecrets(shape));
}

/** Provider name encoded in a `scoped:v1:provider:<name>:apiKey` key, if valid. */
function providerFromKey(key: string): string | null {
  if (!key.startsWith(PROVIDER_KEY_PREFIX) || !key.endsWith(PROVIDER_KEY_SUFFIX)) return null;
  const name = key.slice(PROVIDER_KEY_PREFIX.length, -PROVIDER_KEY_SUFFIX.length);
  return isProviderNameValid(name) ? name : null;
}

export interface LocalFileMigrationOptions {
  dir: string;
  dpapiBackend: CryptoBackend;
  /** Hook de teste executado depois do fsync e antes do rename. */
  beforeRename?: () => void | Promise<void>;
}

/** Migra registros local-file para DPAPI sem retirar a chave antiga antes da verificação. */
export async function migrateLocalFileToDpapi(options: LocalFileMigrationOptions): Promise<boolean> {
  const file = defaultSecretsFile(options.dir);
  const keyFile = masterKeyPath(options.dir);
  if (!fs.existsSync(file) || !fs.existsSync(keyFile)) return false;
  const originalBytes = await fsp.readFile(file);
  const current = await readSecretsFile(file);
  const hasLocalEntries = Object.values(current.scopes).some((entries) =>
    Object.values(entries).some((entry) => entry.backend === "local-file"),
  );
  if (!hasLocalEntries) return false;

  const oldKey = readMasterKey(keyFile);
  const legacy = localFileBackend(oldKey);
  const next: ScopedSecretsFile = structuredClone(current);
  const backup = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.migration-backup`;
  let promoted = false;
  let rolledBack = false;
  let completed = false;
  try {
    // Preserve the exact AES file before any promotion. This copy is itself
    // durable and is the rollback source if verification or key archival fails.
    await writeFileAtomic(backup, originalBytes);
    for (const [scope, entries] of Object.entries(current.scopes)) {
      const targetEntries = next.scopes[scope]!;
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.backend !== "local-file") continue;
        const payload = entryFromBase64(entry.data);
        let plain: string;
        try {
          plain = legacy.decrypt(payload);
        } finally {
          payload.fill(0);
        }
        const encrypted = options.dpapiBackend.encrypt(plain);
        targetEntries[key] = { backend: options.dpapiBackend.name, data: entryToBase64(encrypted) };
        encrypted.fill(0);
      }
    }

    await writeFileAtomic(file, serializeSecrets(next), 0o600, {
      beforeRename: options.beforeRename,
    });
    promoted = true;

    // Verifica o arquivo já renomeado antes de tocar na chave legada.
    const verified = await readSecretsFile(file);
    for (const entries of Object.values(verified.scopes)) {
      for (const entry of Object.values(entries)) {
        if (entry.backend !== DPAPI_CURRENT_USER_BACKEND) continue;
        const payload = entryFromBase64(entry.data);
        try { options.dpapiBackend.decrypt(payload); } finally { payload.fill(0); }
      }
    }
    const archive = `${keyFile}.migrated-${Date.now()}-${process.pid}`;
    await renameWithRetry(keyFile, archive);
    completed = true;
    return true;
  } catch (error) {
    if (promoted) {
      try {
        await writeFileAtomic(file, originalBytes);
        rolledBack = true;
      } catch (rollbackError) {
        throw new Error(
          `keystore: migração falhou e rollback não foi confirmado; backup preservado em ${backup}: ${
            error instanceof Error ? error.message : String(error)
          }; rollback=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    oldKey.fill(0);
    if (completed || rolledBack || !promoted) await fsp.unlink(backup).catch(() => undefined);
  }
}

function masterKeyPath(dir: string): string {
  return path.join(dir, ".master.key");
}

function readMasterKey(file: string): Buffer {
  const raw = fs.readFileSync(file);
  if (raw.length !== 32) {
    throw new Error(
      `keystore: .master.key inválida: esperado 32 bytes, encontrado ${raw.length}; arquivo não foi alterado`,
    );
  }
  // POSIX modes do not map to useful ACL restrictions on Windows.
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return raw;
}

function loadOrCreateMasterKey(dir: string): Buffer {
  const file = masterKeyPath(dir);
  try {
    return readMasterKey(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    // O_EXCL/CREATE_NEW makes first creation atomic between processes. A
    // loser reads the winner's key instead of replacing it.
    writeFileExclusiveSync(file, key);
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return readMasterKey(file);
  }
}

export interface KeystoreOptions {
  /** Diretório dos dados; default: `%APPDATA%\OpenBot\` (injetável p/ testes). */
  dir?: string;
  /** Backend de escrita injetado (testes); default: {@link selectWriteBackend}. */
  writeBackend?: CryptoBackend;
  /** Backend de leitura dos registros `electron-safe-storage`; default: DPAPI legado. */
  legacyReadBackend?: CryptoBackend;
}

/**
 * Escolhe o backend de escrita padrão:
 *   - `OPENBOT_KEYSTORE_MEMORY=1` → memória (nada em disco);
 *   - `OPENBOT_KEYSTORE_BACKEND=local-file` → AES com `.master.key`;
 *   - Windows → DPAPI CurrentUser; outras plataformas → AES com `.master.key`.
 */
function selectWriteBackend(dir: string): CryptoBackend {
  if (process.env.OPENBOT_KEYSTORE_MEMORY === "1") return memoryBackend();
  if (process.env.OPENBOT_KEYSTORE_BACKEND === "local-file") return localFileBackend(loadOrCreateMasterKey(dir));
  try {
    return resolveWriteBackend();
  } catch (err) {
    if (!(err instanceof KeyringUnavailableError)) throw err;
    return localFileBackend(loadOrCreateMasterKey(dir));
  }
}

/** Resultado de `setBoxSecrets` no gateway (espelho do retorno dos IPC de secrets). */
export interface SetBoxSecretsResult {
  synced: boolean;
  /** Providers cuja chave foi escrita/atualizada. */
  upserted: string[];
  /** Providers cuja chave foi removida. */
  deleted: string[];
}

/** Estado interno de um registro mantido em memória (decifrado). */
interface SecretRecord {
  provider: string;
  value: string;
}

export class Keystore {
  private readonly dir: string;
  private readonly file: string;
  private readonly writeBackend: CryptoBackend;
  private readonly legacyReadBackend: CryptoBackend;
  private readonly memory = new Map<string, SecretRecord>();
  /** Source of truth for the `memory` backend, which never touches the file. */
  private memoryShape: ScopedSecretsFile | null = null;
  private localFileReader: CryptoBackend | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private migrationPromise: Promise<void> | null = null;

  constructor(opts: KeystoreOptions = {}) {
    // Guard: a test that forgot `dir` must never touch the real profile.
    const runningTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    if (runningTest && opts.dir === undefined && !process.env.OPENBOT_DATA_ROOT?.trim()) {
      throw new Error("keystore: em ambiente de teste, informe opts.dir ou OPENBOT_DATA_ROOT");
    }
    this.dir = opts.dir ?? defaultKeystoreDir();
    this.file = defaultSecretsFile(this.dir);
    this.writeBackend = opts.writeBackend ?? selectWriteBackend(this.dir);
    this.legacyReadBackend = opts.legacyReadBackend ?? this.buildLegacyReadBackend();
  }

  private buildLegacyReadBackend(): CryptoBackend {
    try {
      return resolveLegacyReadBackend();
    } catch {
      // Sem DPAPI (outra plataforma ou addon ausente): registros legados ficam
      // indecifráveis e o reveal falha com erro claro. Nunca lançamos aqui.
      return memoryBackend();
    }
  }

  /** Backend de escrita em uso (ex.: testes — deve ser `memory`). */
  getWriteBackendName(): string {
    return this.writeBackend.name;
  }

  /** True se os writes são persistidos em disco (não apenas memória). */
  isPersistent(): boolean {
    return this.writeBackend.name !== "memory";
  }

  /** Diretório de dados (útil para testes de scan do arquivo). */
  getDir(): string {
    return this.dir;
  }

  /** Caminho do arquivo de secrets. */
  getFile(): string {
    return this.file;
  }

  /**
   * Migrates records written by the pre-DPAPI `local-file` backend. The
   * bootstrap calls it so profiles that never write a secret also retire the
   * `.master.key`; writes call it too. A failure is not cached: the next call
   * retries.
   */
  migrateLegacySecrets(): Promise<void> {
    if (this.writeBackend.name !== DPAPI_CURRENT_USER_BACKEND) return Promise.resolve();
    if (this.migrationPromise === null) {
      const running = withFileLock(this.file, () => migrateLocalFileToDpapi({ dir: this.dir, dpapiBackend: this.writeBackend }), LOCK_OPTIONS)
        .then(() => undefined);
      this.migrationPromise = running;
      running.catch(() => {
        if (this.migrationPromise === running) this.migrationPromise = null;
      });
    }
    return this.migrationPromise;
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Serializes a write in-process and, for persistent backends, across processes. */
  private write<T>(task: () => Promise<T>): Promise<T> {
    if (!this.isPersistent()) return this.enqueueWrite(task);
    return this.enqueueWrite(async () => {
      await this.migrateLegacySecrets();
      return withFileLock(this.file, task, LOCK_OPTIONS);
    });
  }

  /** Chave de memória escopada: um bot nunca enxerga o cache de outro. */
  private memoryKey(scope: string, key: string): string {
    return `${scope}\u0000${key}`;
  }

  /** Current secrets, already in the v2 shape; the caller owns the result. */
  private async readFile(): Promise<ScopedSecretsFile> {
    if (!this.isPersistent()) return structuredClone(this.memoryShape ?? await readSecretsFile(this.file));
    return readSecretsFile(this.file);
  }

  private async saveFile(shape: ScopedSecretsFile): Promise<void> {
    // Backend de memória NUNCA toca no arquivo (sem plaintext novo).
    if (!this.isPersistent()) {
      this.memoryShape = shape;
      return;
    }
    await writeScopedSecretsFile(this.file, shape);
  }

  /** Removes all encrypted and process-memory secrets owned by one agent. */
  async purgeScope(agentId: string): Promise<boolean> {
    const scope = normalizeKeystoreScope(agentId);
    return this.write(async () => {
      const current = await this.readFile();
      const existed = Object.prototype.hasOwnProperty.call(current.scopes, scope);
      if (existed) {
        const scopes = { ...current.scopes };
        delete scopes[scope];
        await this.saveFile({ ...current, scopes });
      }
      const prefix = `${scope}\u0000`;
      for (const key of this.memory.keys()) {
        if (key.startsWith(prefix)) this.memory.delete(key);
      }
      return existed;
    });
  }

  // ── API por provider (plano §3 T4; escopo por bot — melhoria 5) ────────

  /** Aplica upserts e deletes como uma única transação de persistência. */
  async applySecretBatch(
    entries: readonly { provider: string; apiKey: string }[],
    deleteProviders: readonly string[],
    agentId?: string,
  ): Promise<Pick<SetBoxSecretsResult, "upserted" | "deleted">> {
    const scope = normalizeKeystoreScope(agentId);
    return this.write(async () => {
      const current = await this.readFile();
      const scopeEntries: SecretsFileShape = { ...(current.scopes[scope] ?? {}) };
      const next: ScopedSecretsFile = { ...current, scopes: { ...current.scopes, [scope]: scopeEntries } };
      const upserted: string[] = [];
      let shouldSave = entries.length > 0;

      for (const entry of entries) {
        const key = providerApiKeyKey(entry.provider);
        const ciphertext = this.writeBackend.encrypt(entry.apiKey);
        scopeEntries[key] = { backend: this.writeBackend.name, data: entryToBase64(ciphertext) };
        upserted.push(entry.provider);
      }

      const deleted: string[] = [];
      const removedKeys = new Set<string>();
      for (const provider of deleteProviders) {
        const key = providerApiKeyKey(provider);
        const hadDisk = key in scopeEntries;
        const removed = !removedKeys.has(key) && (hadDisk || this.memory.has(this.memoryKey(scope, key)));
        delete scopeEntries[key];
        removedKeys.add(key);
        if (hadDisk) shouldSave = true;
        if (removed) deleted.push(provider);
      }

      if (shouldSave) await this.saveFile(next);
      for (const entry of entries) {
        this.memory.set(this.memoryKey(scope, providerApiKeyKey(entry.provider)), { provider: entry.provider, value: entry.apiKey });
      }
      for (const provider of deleteProviders) this.memory.delete(this.memoryKey(scope, providerApiKeyKey(provider)));
      return { upserted, deleted };
    });
  }

  /**
   * Grava/atualiza a chave de API de um provider no escopo do bot. O valor é
   * cifrado com o backend de escrita ANTES de qualquer I/O — nunca em claro.
   */
  async upsert(provider: string, apiKey: string, agentId?: string): Promise<void> {
    const scope = normalizeKeystoreScope(agentId);
    if (!isProviderNameValid(provider)) {
      throw new RpcError(400, `keystore: nome de provider inválido: "${provider}"`);
    }
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new RpcError(400, "keystore: apiKey deve ser uma string não vazia");
    }
    if (apiKey.length > 8192) {
      throw new RpcError(400, "keystore: apiKey muito longa (máx 8192)");
    }
    const key = providerApiKeyKey(provider);
    return this.write(async () => {
      const ciphertext = this.writeBackend.encrypt(apiKey);
      const current = await this.readFile();
      const scopeEntries: SecretsFileShape = { ...(current.scopes[scope] ?? {}) };
      scopeEntries[key] = { backend: this.writeBackend.name, data: entryToBase64(ciphertext) };
      await this.saveFile({ ...current, scopes: { ...current.scopes, [scope]: scopeEntries } });
      this.memory.set(this.memoryKey(scope, key), { provider, value: apiKey });
    });
  }

  /**
   * Revela a chave de API de um provider no escopo do bot (null se ausente).
   * Decifra com o backend indicado pela tag do registro.
   */
  async reveal(provider: string, agentId?: string): Promise<string | null> {
    const scope = normalizeKeystoreScope(agentId);
    const key = providerApiKeyKey(provider);
    const mem = this.memory.get(this.memoryKey(scope, key));
    if (mem !== undefined) return mem.value;
    return this.revealFrom(await this.readFile(), scope, key, provider);
  }

  /** Decrypts one entry of an already-read shape and caches the plaintext for redaction. */
  private revealFrom(shape: ScopedSecretsFile, scope: string, key: string, provider: string): string | null {
    const entry = shape.scopes[scope]?.[key];
    if (!entry) return null;
    try {
      const value = this.backendFor(entry.backend).decrypt(entryFromBase64(entry.data));
      // Keep a process-local cache for the redaction boundary. The plaintext
      // is never persisted or logged; this only lets task scanners see the
      // same secret that the adapter just resolved.
      this.memory.set(this.memoryKey(scope, key), { provider, value });
      return value;
    } catch (err) {
      // Registro indecifrável (DPAPI de outra máquina/usuário) → erro claro.
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError(500, `keystore: falha ao decifrar "${provider}": ${message}`);
    }
  }

  /**
   * Remove a chave de API de um provider no escopo do bot. A remoção vale
   * também para o arquivo com o backend de memória: apagar retira um registro
   * cifrado e nunca grava um novo.
   */
  async delete(provider: string, agentId?: string): Promise<boolean> {
    const scope = normalizeKeystoreScope(agentId);
    const key = providerApiKeyKey(provider);
    const withoutKey = (shape: ScopedSecretsFile): ScopedSecretsFile | null => {
      const entries = shape.scopes[scope];
      if (entries === undefined || !(key in entries)) return null;
      const nextEntries = { ...entries };
      delete nextEntries[key];
      return { ...shape, scopes: { ...shape.scopes, [scope]: nextEntries } };
    };
    return this.enqueueWrite(async () => {
      if (this.isPersistent()) await this.migrateLegacySecrets();
      return withFileLock(this.file, async () => {
        const hadMemory = this.memory.delete(this.memoryKey(scope, key));
        const onDisk = withoutKey(await readSecretsFile(this.file));
        if (onDisk !== null) await writeScopedSecretsFile(this.file, onDisk);
        const inMemory = this.memoryShape === null ? null : withoutKey(this.memoryShape);
        if (inMemory !== null) this.memoryShape = inMemory;
        return hadMemory || onDisk !== null || inMemory !== null;
      }, LOCK_OPTIONS);
    });
  }

  /** Lista os providers com chave utilizável NO ESCOPO do bot — só nomes. */
  async list(agentId?: string): Promise<string[]> {
    const scope = normalizeKeystoreScope(agentId);
    const shape = await this.readFile();
    const providers = new Set<string>();
    for (const key of Object.keys(shape.scopes[scope] ?? {})) {
      const name = providerFromKey(key);
      if (name !== null) providers.add(name);
    }
    for (const [memoryKey, record] of this.memory.entries()) {
      if (memoryKey.startsWith(`${scope}\u0000`)) providers.add(record.provider);
    }
    const usable: string[] = [];
    for (const provider of providers) {
      const key = providerApiKeyKey(provider);
      try {
        const value = this.memory.get(this.memoryKey(scope, key))?.value ?? this.revealFrom(shape, scope, key, provider);
        if (value !== null) usable.push(provider);
      } catch {
        // Corrupt entries are not advertised.
      }
    }
    return usable.sort();
  }

  /**
   * Returns the currently revealed plaintext values from the process-local
   * cache for redaction. It intentionally does not read or return ciphertext
   * from disk, and callers must not persist or log the result.
   */
  sensitiveValues(agentId?: string): readonly string[] {
    const scope = agentId === undefined ? null : normalizeKeystoreScope(agentId);
    const prefix = scope === null ? "" : `${scope}\u0000`;
    return [...this.memory.entries()]
      .filter(([memoryKey]) => scope === null || memoryKey.startsWith(prefix))
      .map(([, record]) => record.value)
      .filter((value) => value.length > 0);
  }

  /** Hydrates all decryptable on-disk entries into the process-local cache. */
  hydrateSensitiveValues(): void {
    const shape = readSecretsFileSync(this.file);
    for (const [scope, entries] of Object.entries(shape.scopes)) {
      for (const [key, entry] of Object.entries(entries)) {
        const provider = providerFromKey(key);
        if (provider === null) continue;
        try {
          const value = this.backendFor(entry.backend).decrypt(entryFromBase64(entry.data));
          this.memory.set(this.memoryKey(scope, key), { provider, value });
        } catch {
          // An entry encrypted by an unavailable user profile remains absent;
          // the normal reveal path will fail closed when that provider is used.
        }
      }
    }
  }

  // ── helpers internos ───────────────────────────────────────────────────

  private backendFor(backendName: string): CryptoBackend {
    if (backendName === this.writeBackend.name) return this.writeBackend;
    if (backendName === DPAPI_CURRENT_USER_BACKEND) return dpapiCurrentUserBackend();
    if (backendName === "electron-safe-storage") return this.legacyReadBackend;
    if (backendName === "local-file") {
      this.localFileReader ??= localFileBackend(readMasterKey(masterKeyPath(this.dir)));
      return this.localFileReader;
    }
    if (backendName === "memory") return memoryBackend();
    throw new RpcError(500, `keystore: backend desconhecido "${backendName}"`);
  }
}

// ── integração ao gateway (plano §3 T4) ──────────────────────────────────

export interface KeystoreHandlers {
  /** POST /api/setBoxSecrets — upsert/delete de chaves por provider. */
  setBoxSecrets: RpcHandler;
  /** POST /api/getBoxSecretsStatus — {secrets: string[]} (só nomes). */
  getBoxSecretsStatus: RpcHandler;
}

/** Valida o corpo de `setBoxSecrets` e devolve entradas normalizadas. */
function parseSetBoxSecretsBody(body: unknown): {
  entries: { provider: string; apiKey: string }[];
  deleteProviders: string[];
} {
  if (!isPlainObject(body)) {
    throw new RpcError(400, "setBoxSecrets: corpo deve ser um objeto");
  }
  const entriesRaw = body.entries;
  const entries: { provider: string; apiKey: string }[] = [];
  if (entriesRaw !== undefined) {
    if (!Array.isArray(entriesRaw)) {
      throw new RpcError(400, "setBoxSecrets: entries deve ser um array");
    }
    for (const e of entriesRaw) {
      if (!isPlainObject(e)) {
        throw new RpcError(400, "setBoxSecrets: cada entry deve ser um objeto");
      }
      const provider = e.provider;
      const apiKey = e.apiKey;
      if (typeof provider !== "string" || typeof apiKey !== "string") {
        throw new RpcError(400, "setBoxSecrets: entry exige provider e apiKey (strings)");
      }
      if (!isProviderNameValid(provider) || apiKey.length === 0 || apiKey.length > 8192) {
        throw new RpcError(400, "setBoxSecrets: provider ou apiKey inválido");
      }
      entries.push({ provider, apiKey });
    }
  }
  const secretsRaw = body.secrets;
  const hasSecretSnapshot = isPlainObject(secretsRaw);
  if (hasSecretSnapshot) {
    for (const [provider, apiKey] of Object.entries(secretsRaw)) {
      if (typeof apiKey !== "string" || !isProviderNameValid(provider) || apiKey.length === 0 || apiKey.length > 8192) throw new RpcError(400, "setBoxSecrets: provider ou apiKey inválido");
      entries.push({ provider, apiKey });
    }
  }
  const deleteRaw = body.delete;
  const deleteProviders: string[] = [];
  if (deleteRaw !== undefined) {
    if (!Array.isArray(deleteRaw)) {
      throw new RpcError(400, "setBoxSecrets: delete deve ser um array");
    }
    for (const p of deleteRaw) {
      if (typeof p !== "string") {
        throw new RpcError(400, "setBoxSecrets: delete deve conter strings");
      }
      if (!isProviderNameValid(p)) throw new RpcError(400, "setBoxSecrets: provider inválido em delete");
      deleteProviders.push(p);
    }
  }
  if (entries.length === 0 && deleteProviders.length === 0 && !hasSecretSnapshot) {
    throw new RpcError(400, "setBoxSecrets: nada para fazer (entries e/ou delete)");
  }
  return { entries, deleteProviders };
}

/** Plug as duas rotas de secrets no gateway (métodos já na RPC_METHOD_TABLE). */
export function registerKeystoreHandlers(
  gateway: Gateway,
  keystore: Keystore,
  onProvidersChanged?: (providers: string[]) => void,
): KeystoreHandlers {
  const setBoxSecrets: RpcHandler = async (body) => {
    const { entries, deleteProviders } = parseSetBoxSecretsBody(body);
    const agentId = isPlainObject(body) && typeof body.agentId === "string" ? body.agentId : undefined;
    const scope = normalizeKeystoreScope(agentId);
    const { upserted, deleted } = await keystore.applySecretBatch(entries, deleteProviders, scope);
    if (agentId === undefined) onProvidersChanged?.([...upserted, ...deleted]);
    return { synced: keystore.isPersistent(), upserted, deleted } satisfies SetBoxSecretsResult;
  };

  const getBoxSecretsStatus: RpcHandler = async (body) => {
    const agentId = isPlainObject(body) && typeof body.agentId === "string" ? body.agentId : undefined;
    const secrets = await keystore.list(normalizeKeystoreScope(agentId));
    return { secrets, keys: secrets, isApplied: true, lastAppliedAtMs: null } satisfies BoxSecretsStatus;
  };

  gateway.registerHandler("setBoxSecrets", setBoxSecrets);
  gateway.registerHandler("getBoxSecretsStatus", getBoxSecretsStatus);
  return { setBoxSecrets, getBoxSecretsStatus };
}

/** Factory ergonômica (bootstrap/tests). */
export function createKeystore(opts: KeystoreOptions = {}): Keystore {
  return new Keystore(opts);
}
