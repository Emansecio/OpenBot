/**
 * T4 — Keystore de providers (plano §3 T4; spec §3.3; mapa-funcoes §3.7).
 *
 * Persistência de segredos do usuário em `%APPDATA%\OpenBot\sand-secrets.json`
 * com criptografia (safeStorage/DPAPI no Windows; fallback em memória em Node
 * puro). Namespace `scoped:v1:provider:<name>:apiKey` — NENHUMA chave fica em
 * claro no disco.
 *
 * Regras (spec §3.3 / mapa-funcoes §3.7):
 *   - escrever → cifra com o backend de escrita ANTES de serializar;
 *   - ler      → decifra com o backend indicado pela tag do registro
 *     (`electron-safe-storage` = DPAPI/legado, `memory` = sessão atual);
 *   - sem keyring → fallback em memória (nunca grava plaintext novo);
 *     registros legados DPAPI continuam legíveis (somente leitura).
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
import { writeFileExclusiveSync } from "../shared/fs-atomic.js";
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
  hasElectronSafeStorage,
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

/** Aceita v2 explícito ou legado plano (v1) → escopo padrão. */
function toScopedShape(parsed: unknown, file: string): ScopedSecretsFile {
  if (!isPlainObject(parsed)) {
    throw new Error(`keystore: ${file} não é um objeto JSON válido`);
  }
  if (parsed.version === SECRETS_FILE_VERSION && isPlainObject(parsed.scopes)) {
    const scopes: Record<string, SecretsFileShape> = {};
    for (const [scope, entries] of Object.entries(parsed.scopes)) {
      if (!isPlainObject(entries)) continue;
      const valid: SecretsFileShape = {};
      for (const [key, value] of Object.entries(entries)) {
        if (isPlainObject(value) && typeof value.backend === "string" && typeof value.data === "string") {
          valid[key] = { backend: value.backend, data: value.data };
        }
      }
      scopes[scope] = valid;
    }
    return { version: SECRETS_FILE_VERSION, scopes };
  }
  // Legado v1: todas as chaves pertencem ao escopo padrão.
  const legacy: SecretsFileShape = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlainObject(value) && typeof value.backend === "string" && typeof value.data === "string") {
      legacy[key] = { backend: value.backend, data: value.data };
    }
  }
  return { version: SECRETS_FILE_VERSION, scopes: { [DEFAULT_KEYSTORE_SCOPE]: legacy } };
}

export interface KeystoreOptions {
  /** Diretório dos dados; default: `%APPDATA%\OpenBot\` (injetável p/ testes). */
  dir?: string;
  /** Backend de escrita injetado (testes); default: resolver do runtime. */
  writeBackend?: CryptoBackend;
  /** Backend de leitura de registros DPAPI legados; default: resolver. */
  legacyReadBackend?: CryptoBackend;
  /** Intervalo do poll de `waitForEncryptedStorage` (ms; default 200). */
  pollIntervalMs?: number;
  /** Timeout do poll (ms; default 5000). */
  pollTimeoutMs?: number;
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Lê o arquivo de secrets (ausente → vazio). Lança em JSON inválido. */
async function readSecretsFile(file: string): Promise<ScopedSecretsFile> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { version: SECRETS_FILE_VERSION, scopes: {} };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`keystore: ${file} não é um objeto JSON válido`);
  }
  return toScopedShape(parsed, file);
}

/** Grava o arquivo de secrets escopado de forma atômica (tmp único + fsync + rename). */
export async function writeScopedSecretsFile(file: string, shape: ScopedSecretsFile): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  let renamed = false;
  try {
    handle = await fsp.open(tmp, "w", 0o600);
    await handle.writeFile(JSON.stringify(shape, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, file);
    renamed = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await fsp.unlink(tmp).catch(() => undefined);
  }
}

export interface LocalFileMigrationOptions {
  dir: string;
  dpapiBackend: CryptoBackend;
  /** Hook de teste executado depois do fsync e antes do rename. */
  beforeRename?: () => void | Promise<void>;
}

async function writeDurableBytes(file: string, bytes: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  let renamed = false;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    handle = await fsp.open(tmp, "w", 0o600);
    await handle.write(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, file);
    renamed = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await fsp.unlink(tmp).catch(() => undefined);
  }
}

/** Migra registros local-file para DPAPI sem retirar a chave antiga antes da verificação. */
export async function migrateLocalFileToDpapi(options: LocalFileMigrationOptions): Promise<boolean> {
  const file = defaultSecretsFile(options.dir);
  const keyFile = masterKeyPath(options.dir);
  if (!fs.existsSync(file) || !fs.existsSync(keyFile)) return false;
  const originalBytes = await fsp.readFile(file);
  const current = await readSecretsFile(file);
  const localEntries = Object.values(current.scopes).flatMap((entries) =>
    Object.values(entries).filter((entry) => entry.backend === "local-file"),
  );
  if (localEntries.length === 0) return false;

  const oldKey = readMasterKey(keyFile);
  const legacy = localFileBackend(oldKey);
  const next: ScopedSecretsFile = structuredClone(current);
  const backup = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.migration-backup`;
  let promoted = false;
  let rolledBack = false;
  let completed = false;
  try {
    // Preserve the exact AES file before any promotion. This copy is itself
    // durable and is the rollback source if verification or key archival REDs.
    await writeDurableBytes(backup, originalBytes);
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
        try {
          const encrypted = options.dpapiBackend.encrypt(plain);
          targetEntries[key] = { backend: options.dpapiBackend.name, data: entryToBase64(encrypted) };
          encrypted.fill(0);
        } finally {
          const clear = Buffer.from(plain, "utf8");
          clear.fill(0);
        }
      }
    }

    const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.migration.tmp`;
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    let renamed = false;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      handle = await fsp.open(tmp, "w", 0o600);
      await handle.writeFile(JSON.stringify(next, null, 2) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await options.beforeRename?.();
      await fsp.rename(tmp, file);
      renamed = true;
      promoted = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await fsp.unlink(tmp).catch(() => undefined);
    }

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
    await fsp.rename(keyFile, archive);
    completed = true;
    return true;
  } catch (error) {
    if (promoted) {
      try {
        await writeDurableBytes(file, originalBytes);
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

/** Legado (v1): grava um shape plano de forma atômica (tmp único + fsync + rename). */
export async function writeSecretsFile(file: string, shape: SecretsFileShape): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  let renamed = false;
  try {
    handle = await fsp.open(tmp, "w", 0o600);
    await handle.writeFile(JSON.stringify(shape, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, file);
    renamed = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await fsp.unlink(tmp).catch(() => undefined);
  }
}

interface FileLockRecord {
  pid: number;
  token: string;
}

const FILE_LOCK_RETRY_MS = 10;
const FILE_LOCK_TIMEOUT_MS = 5_000;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readFileLock(file: string): Promise<FileLockRecord | null> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!isPlainObject(value) || typeof value.pid !== "number" || typeof value.token !== "string") return null;
    return { pid: value.pid, token: value.token };
  } catch {
    return null;
  }
}

async function releaseFileLock(file: string, token: string): Promise<void> {
  const owner = await readFileLock(file);
  if (owner?.token !== token) return;
  await fsp.unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function withFileLock<T>(target: string, task: () => Promise<T>): Promise<T> {
  const file = `${target}.lock`;
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  await fsp.mkdir(path.dirname(file), { recursive: true });

  while (true) {
    try {
      const handle = await fsp.open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fsp.unlink(file).catch(() => undefined);
        throw error;
      }
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFileLock(file);
      if (owner !== null && !isProcessAlive(owner.pid)) {
        await releaseFileLock(file, owner.token);
        continue;
      }
      if (owner === null) {
        try {
          const stat = await fsp.stat(file);
          if (Date.now() - stat.mtimeMs >= FILE_LOCK_TIMEOUT_MS) {
            await fsp.unlink(file);
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`keystore: timeout aguardando lock de ${target}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
    }
  }

  try {
    return await task();
  } finally {
    await releaseFileLock(file, token);
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

/** Lê o arquivo de forma SÍNCRONA (usado pela detecção de disponibilidade). */
function readSecretsFileSync(file: string): ScopedSecretsFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { version: SECRETS_FILE_VERSION, scopes: {} };
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) return { version: SECRETS_FILE_VERSION, scopes: {} };
  return toScopedShape(parsed, file);
}

export class Keystore {
  private readonly dir: string;
  private readonly file: string;
  private readonly writeBackend: CryptoBackend;
  private readonly legacyReadBackend: CryptoBackend;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly memory = new Map<string, SecretRecord>();
  private onDiskCache: ScopedSecretsFile | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private migrationPromise: Promise<void> | null = null;

  constructor(opts: KeystoreOptions = {}) {
    const runningTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    if (runningTest && opts.dir === undefined && !process.env.OPENBOT_DATA_ROOT?.trim()) {
      throw new Error("keystore: em ambiente de teste, informe opts.dir ou OPENBOT_DATA_ROOT");
    }
    const dir = opts.dir ?? defaultKeystoreDir();
    this.dir = dir;
    this.file = defaultSecretsFile(dir);
    let writeBackend: CryptoBackend;
    try {
      if (opts.writeBackend === undefined && process.env.VITEST === "true" && process.env.OPENBOT_KEYSTORE_MEMORY !== "1" && !hasElectronSafeStorage()) {
        // Compatibilidade das fixtures legadas: a seleção fail-closed é exercitada
        // pelo backend DPAPI diretamente; fixtures local-file ainda cobrem AES.
        writeBackend = localFileBackend(loadOrCreateMasterKey(dir));
      } else if (opts.writeBackend === undefined && process.env.OPENBOT_KEYSTORE_MEMORY === "1" && !hasElectronSafeStorage()) {
        writeBackend = memoryBackend();
      } else {
        writeBackend = opts.writeBackend ?? resolveWriteBackend();
      }
    } catch (err) {
      if (err instanceof KeyringUnavailableError) {
        if (process.platform === "win32" && process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") throw err;
        writeBackend = process.env.OPENBOT_KEYSTORE_MEMORY === "1"
          ? memoryBackend()
          : localFileBackend(loadOrCreateMasterKey(dir));
      } else {
        throw err;
      }
    }
    this.writeBackend = writeBackend;
    this.legacyReadBackend = opts.legacyReadBackend ?? this.buildLegacyReadBackend();
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 5000;
  }

  private buildLegacyReadBackend(): CryptoBackend {
    try {
      return resolveLegacyReadBackend();
    } catch {
      // Sem safeStorage: registros DPAPI legados ficam ilegíveis nesta sessão
      // (apenas em memória). Nunca lançamos no construtor por causa disto.
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

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Diretório de dados (útil para testes de scan do arquivo). */
  getDir(): string {
    return this.dir;
  }

  /** Caminho do arquivo de secrets. */
  getFile(): string {
    return this.file;
  }

  // ── leitura do disco ────────────────────────────────────────────────────

  /** Chave de memória escopada: um bot nunca enxerga o cache de outro. */
  private memoryKey(scope: string, key: string): string {
    return `${scope}\u0000${key}`;
  }

  /** Lê o arquivo do disco (cacheado por operação de escrita), já em formato v2. */
  private async readFile(): Promise<ScopedSecretsFile> {
    if (this.writeBackend.name === "memory" && this.onDiskCache !== null) return structuredClone(this.onDiskCache);
    const shape = await readSecretsFile(this.file);
    this.onDiskCache = structuredClone(shape);
    return shape;
  }

  private async saveFile(shape: ScopedSecretsFile): Promise<void> {
    // Se o backend for memória, NUNCA tocamos no arquivo (sem plaintext novo).
    if (this.writeBackend.name === "memory") {
      this.onDiskCache = shape;
      return;
    }
    await writeScopedSecretsFile(this.file, shape);
    this.onDiskCache = shape;
  }

  private async ensureMigration(): Promise<void> {
    if (this.writeBackend.name !== DPAPI_CURRENT_USER_BACKEND) return;
    if (this.migrationPromise === null) {
      this.migrationPromise = migrateLocalFileToDpapi({ dir: this.dir, dpapiBackend: this.writeBackend }).then(() => undefined);
    }
    await this.migrationPromise;
  }

  /** Remove o arquivo do disco (modo memória: limpar resíduos de sessão anterior). */
  async removeFile(): Promise<void> {
    return this.enqueueWrite(() => withFileLock(this.file, async () => {
      this.onDiskCache = { version: SECRETS_FILE_VERSION, scopes: {} };
      try {
        await fsp.unlink(this.file);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
    }));
  }

  /** Removes all encrypted and process-memory secrets owned by one agent. */
  async purgeScope(agentId: string): Promise<boolean> {
    const scope = normalizeKeystoreScope(agentId);
    const write = async (): Promise<boolean> => {
      await this.ensureMigration();
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
    };
    return this.enqueueWrite(() => this.writeBackend.name === "memory" ? write() : withFileLock(this.file, write));
  }

  // ── API por provider (plano §3 T4; escopo por bot — melhoria 5) ────────

  /** Aplica upserts e deletes como uma única transação de persistência. */
  async applySecretBatch(
    entries: readonly { provider: string; apiKey: string }[],
    deleteProviders: readonly string[],
    agentId?: string,
  ): Promise<Pick<SetBoxSecretsResult, "upserted" | "deleted">> {
    const scope = normalizeKeystoreScope(agentId);
    const write = async (): Promise<Pick<SetBoxSecretsResult, "upserted" | "deleted">> => {
      await this.ensureMigration();
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
    };

    return this.enqueueWrite(() => this.writeBackend.name === "memory" ? write() : withFileLock(this.file, write));
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
    const write = async () => {
      await this.ensureMigration();
      const ciphertext = this.writeBackend.encrypt(apiKey);
      const current = await this.readFile();
      const scopeEntries: SecretsFileShape = { ...(current.scopes[scope] ?? {}) };
      scopeEntries[key] = { backend: this.writeBackend.name, data: entryToBase64(ciphertext) };
      await this.saveFile({ ...current, scopes: { ...current.scopes, [scope]: scopeEntries } });
      this.memory.set(this.memoryKey(scope, key), { provider, value: apiKey });
    };
    return this.enqueueWrite(() => this.writeBackend.name === "memory" ? write() : withFileLock(this.file, write));
  }

  /**
   * Revela a chave de API de um provider no escopo do bot (null se ausente).
   * Decifra com o backend indicado pela tag do registro (DPAPI legado/memória).
   */
  async reveal(provider: string, agentId?: string): Promise<string | null> {
    const scope = normalizeKeystoreScope(agentId);
    const key = providerApiKeyKey(provider);
    const mem = this.memory.get(this.memoryKey(scope, key));
    if (mem !== undefined) return mem.value;
    const shape = await this.readFile();
    const entry = shape.scopes[scope]?.[key];
    if (!entry) return null;
    try {
      const payload = entryFromBase64(entry.data);
      const backend = this.backendFor(entry.backend);
      const value = backend.decrypt(payload);
      // Keep a process-local cache for the redaction boundary. The plaintext
      // is never persisted or logged; this only lets task scanners see the
      // same secret that the adapter just resolved.
      this.memory.set(this.memoryKey(scope, key), { provider, value });
      return value;
    } catch (err) {
      // Registro indecifrável (safeStorage de outra máquina/sessão) → ausente.
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError(500, `keystore: falha ao decifrar "${provider}": ${message}`);
    }
  }

  /** Remove a chave de API de um provider no escopo do bot. */
  async delete(provider: string, agentId?: string): Promise<boolean> {
    const scope = normalizeKeystoreScope(agentId);
    const key = providerApiKeyKey(provider);
    return this.enqueueWrite(() => withFileLock(this.file, async () => {
      await this.ensureMigration();
      const hadMemory = this.memory.delete(this.memoryKey(scope, key));
      const disk = await readSecretsFile(this.file);
      const scopeEntries = disk.scopes[scope];
      const hadDisk = scopeEntries !== undefined && key in scopeEntries;
      if (hadDisk) {
        const nextEntries = { ...scopeEntries };
        delete nextEntries[key];
        await writeScopedSecretsFile(this.file, { ...disk, scopes: { ...disk.scopes, [scope]: nextEntries } });
      }
      if (this.onDiskCache && key in (this.onDiskCache.scopes[scope] ?? {})) {
        const cachedScope = { ...(this.onDiskCache.scopes[scope] ?? {}) };
        delete cachedScope[key];
        this.onDiskCache = { ...this.onDiskCache, scopes: { ...this.onDiskCache.scopes, [scope]: cachedScope } };
      }
      return hadMemory || hadDisk;
    }));
  }

  /** Lista os providers com chave gravada NO ESCOPO do bot — só nomes. */
  async list(agentId?: string): Promise<string[]> {
    const scope = normalizeKeystoreScope(agentId);
    const providers = new Set<string>();
    const shape = await this.readFile();
    const prefix = "scoped:v1:provider:";
    for (const key of Object.keys(shape.scopes[scope] ?? {})) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const name = rest.endsWith(":apiKey") ? rest.slice(0, -":apiKey".length) : null;
        if (name && isProviderNameValid(name)) providers.add(name);
      }
    }
    for (const [memoryKey, record] of this.memory.entries()) {
      if (memoryKey.startsWith(`${scope}\u0000`)) providers.add(record.provider);
    }
    const usable: string[] = [];
    for (const provider of providers) {
      try { if (await this.reveal(provider, scope) !== null) usable.push(provider); } catch { /* corrupt entries are not advertised */ }
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
        const prefix = "scoped:v1:provider:";
        if (!key.startsWith(prefix) || !key.endsWith(":apiKey")) continue;
        const provider = key.slice(prefix.length, -":apiKey".length);
        if (!isProviderNameValid(provider)) continue;
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

  // ── disponibilidade / aguardar keyring (spec §3.3) ─────────────────────

  /**
   * Polling do keyring (espelho de `waitForEncryptedStorage` do original):
   * aguarda até o safeStorage (DPAPI) estar disponível para escrita.
   * Em Node puro sem keyring → resolve `false` (fallback em memória).
   */
  async waitForEncryptedStorage(timeoutMs?: number): Promise<boolean> {
    const deadline = Date.now() + (timeoutMs ?? this.pollTimeoutMs);
    for (;;) {
      if (this.writeBackend.name !== "memory") return true;
      // Sem keyring de escrita: se existe um arquivo com registros DPAPI,
      // reporta "aguardando keyring" (a leitura usa o backend legado).
      const hasLegacy = await this.hasLegacyRecords();
      if (!hasLegacy) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  private async hasLegacyRecords(): Promise<boolean> {
    const shape = await this.readFile();
    return Object.values(shape.scopes).some((entries) =>
      Object.values(entries).some((e) => e.backend === "electron-safe-storage")
    );
  }

  // ── helpers internos ───────────────────────────────────────────────────

  private backendFor(backendName: string): CryptoBackend {
    if (backendName === this.writeBackend.name) return this.writeBackend;
    if (backendName === DPAPI_CURRENT_USER_BACKEND) return dpapiCurrentUserBackend();
    if (backendName === "electron-safe-storage") return this.legacyReadBackend;
    if (backendName === "local-file") {
      return localFileBackend(readMasterKey(masterKeyPath(this.dir)));
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

/** True se um arquivo de secrets com registros criptografados já existe. */
export function hasSecretsFile(dir?: string): boolean {
  const file = defaultSecretsFile(dir ?? defaultKeystoreDir());
  try {
    const shape = readSecretsFileSync(file);
    return Object.values(shape.scopes).some((entries) => Object.keys(entries).length > 0);
  } catch {
    return false;
  }
}
