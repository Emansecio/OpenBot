/**
 * T4 — Testes da keystore de providers (src/keystore/).
 *
 * Done (plano §3 T4):
 *   - round-trip encrypt/decrypt (upsert → reveal devolve o mesmo valor);
 *   - NENHUMA chave aparece em claro no disco (scan do arquivo sand-secrets.json);
 *   - fallback em memória: sem keyring, upsert/reveal/delete/list funcionam e
 *     nada é gravado em disco;
 *   - migração de registros legados (DPAPI) quando o safeStorage volta;
 *   - waitForEncryptedStorage (espelho do original, spec §3.3);
 *   - API por provider com validação de nome/valor.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { providerApiKeyKey,
  injectElectronSafeStorage,
  nodeLegacyBackend,
  type ElectronSafeStorage } from "../src/keystore/backend.js";
import { createKeystore, DEFAULT_KEYSTORE_SCOPE, type Keystore, writeSecretsFile,defaultKeystoreDir,defaultSecretsFile } from "../src/keystore/index.js";

// ── helpers de teste ─────────────────────────────────────────────────────

/** SafeStorage FAKE determinístico — simula o DPAPI do Windows (testes). */
function makeFakeSafeStorage(): ElectronSafeStorage {
  // prefixo + reverse: cifra "determinística" suficiente para os testes de
  // round-trip e de scan (nunca contém o plaintext).
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) =>
      Buffer.from(`DPAPI-FAKE::${Buffer.from(plainText, "utf8").reverse().toString("base64")}`, "utf8"),
    decryptString: (encrypted: Buffer) => {
      const s = encrypted.toString("utf8");
      if (!s.startsWith("DPAPI-FAKE::")) throw new Error("payload desconhecido");
      return Buffer.from(s.slice("DPAPI-FAKE::".length), "base64").reverse().toString("utf8");
    },
  };
}

const tmpDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openbot-keystore-"));
  tmpDirs.push(dir);
  return dir;
}

async function cleanup(): Promise<void> {
  await Promise.all(
    tmpDirs.splice(0).map(async (dir) => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }),
  );
}

// ── suíte ────────────────────────────────────────────────────────────────

describe("T4 keystore — fallback em memória (Node puro, sem keyring)", () => {
  let dir: string;
  let ks: Keystore;

  beforeEach(async () => {
    dir = await makeDir();
    ks = createKeystore({ dir });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("sem keyring: backend é memória e nada é gravado em disco", async () => {
    expect(ks.getWriteBackendName()).toBe("memory");
    expect(ks.isPersistent()).toBe(false);

    await ks.upsert("openai", "sk-secreta-123");
    await ks.upsert("xai", "xai-secreta-456");

    // Arquivo não deve existir — fallback em memória NUNCA grava plaintext novo.
    expect(fs.existsSync(ks.getFile())).toBe(false);
  });

  it("round-trip: upsert → reveal devolve o mesmo valor; list só nomes", async () => {
    await ks.upsert("openai", "sk-ant-abc123");
    await ks.upsert("xai", "xai-xyz789");
    await ks.upsert("openai-compat", "lm-studio-local");

    expect(await ks.reveal("openai")).toBe("sk-ant-abc123");
    expect(await ks.reveal("xai")).toBe("xai-xyz789");
    expect(await ks.reveal("openai-compat")).toBe("lm-studio-local");

    const list = await ks.list();
    expect(list).toEqual(["openai", "openai-compat", "xai"]);
  });

  it("upsert sobrescreve; reveal de provider ausente → null", async () => {
    await ks.upsert("openai", "v1");
    await ks.upsert("openai", "v2");
    expect(await ks.reveal("openai")).toBe("v2");
    expect(await ks.reveal("anthropic")).toBeNull();
  });

  it("delete remove a chave e o nome da lista", async () => {
    await ks.upsert("openai", "sk-a");
    await ks.upsert("xai", "xai-b");
    expect(await ks.delete("openai")).toBe(true);
    expect(await ks.reveal("openai")).toBeNull();
    expect(await ks.list()).toEqual(["xai"]);
    // delete de ausente → false
    expect(await ks.delete("openai")).toBe(false);
  });

  it("valida nome de provider (rejeita `:` que quebraria o namespace)", async () => {
    await expect(ks.upsert("open ai", "x")).rejects.toThrow(/inválido/);
    await expect(ks.upsert("openai:evil", "x")).rejects.toThrow(/inválido/);
    await expect(ks.upsert("", "x")).rejects.toThrow(/inválido/);
  });

  it("valida valor (apiKey não vazia e com limite de tamanho)", async () => {
    await expect(ks.upsert("openai", "")).rejects.toThrow(/não vazia/);
    await expect(ks.upsert("openai", "x".repeat(9000))).rejects.toThrow(/muito longa/);
  });

  it("waitForEncryptedStorage → false (sem keyring, nada legado em disco)", async () => {
    expect(await ks.waitForEncryptedStorage(50)).toBe(false);
  });

  it("namespace da chave: scoped:v1:provider:<name>:apiKey", async () => {
    expect(providerApiKeyKey("openai")).toBe("scoped:v1:provider:openai:apiKey");
    expect(providerApiKeyKey("openai-compat")).toBe(
      "scoped:v1:provider:openai-compat:apiKey",
    );
  });
});

describe("T4 keystore — persistência criptografada (safeStorage/DPAPI injetado)", () => {
  let dir: string;
  let ks: Keystore;

  beforeEach(async () => {
    dir = await makeDir();
    injectElectronSafeStorage(makeFakeSafeStorage());
    ks = createKeystore({ dir });
  });

  afterEach(async () => {
    injectElectronSafeStorage(null);
    await cleanup();
  });

  it("round-trip persistente: upsert → reveal; arquivo criado com registros cifrados", async () => {
    await ks.upsert("openai", "sk-ant-1234567890");
    expect(ks.getWriteBackendName()).toBe("electron-safe-storage");
    expect(ks.isPersistent()).toBe(true);
    expect(fs.existsSync(ks.getFile())).toBe(true);

    expect(await ks.reveal("openai")).toBe("sk-ant-1234567890");
    expect(await ks.list()).toEqual(["openai"]);
  });

  it("nenhuma chave aparece em claro no disco (scan do arquivo)", async () => {
    const secrets = [
      { provider: "openai", key: "sk-OPENAI-ULTRA-SECRETA-1" },
      { provider: "xai", key: "xai-ANOTHER-SECRET-2" },
      { provider: "openai-compat", key: "lm-COMPAT-SECRET-3" },
    ];
    for (const s of secrets) {
      await ks.upsert(s.provider, s.key);
    }

    // varre o arquivo bruto — nenhum plaintext de chave pode aparecer
    const raw = fs.readFileSync(ks.getFile(), "utf8");
    for (const s of secrets) {
      expect(raw).not.toContain(s.key);
      // nem substrings significativas da chave
      expect(raw).not.toContain("ULTRA-SECRETA");
      expect(raw).not.toContain("ANOTHER-SECRET");
      expect(raw).not.toContain("COMPAT-SECRET");
    }
    // e o JSON parseado só contém {backend, data} — nunca o valor (formato v2 escopado)
    const parsed = JSON.parse(raw) as { version: number; scopes: Record<string, Record<string, { backend: string; data: string }>> };
    const defaultScope = parsed.scopes[DEFAULT_KEYSTORE_SCOPE] ?? {};
    for (const s of secrets) {
      const entry = defaultScope[providerApiKeyKey(s.provider)]!;
      expect(entry).toBeDefined();
      expect(entry.backend).toBe("electron-safe-storage");
      expect(typeof entry.data).toBe("string");
      expect(entry.data).not.toContain(s.key);
    }
  });

  it("re-leitura: nova instância lê do disco (persistência entre sessões)", async () => {
    await ks.upsert("openai", "sk-persistente-777");
    const ks2 = createKeystore({ dir });
    expect(await ks2.reveal("openai")).toBe("sk-persistente-777");
    expect(await ks2.list()).toEqual(["openai"]);
  });

  it("hidrata a cache de redaction de registros cifrados antes do primeiro reveal", async () => {
    await ks.upsert("openai", "sk-hydrate-777");
    const ks2 = createKeystore({ dir });
    expect(ks2.sensitiveValues()).toEqual([]);
    ks2.hydrateSensitiveValues();
    expect(ks2.sensitiveValues()).toContain("sk-hydrate-777");
  });

  it("delete remove do disco; instância nova não vê mais a chave", async () => {
    await ks.upsert("openai", "sk-para-deletar");
    expect(await ks.delete("openai")).toBe(true);
    const ks2 = createKeystore({ dir });
    expect(await ks2.reveal("openai")).toBeNull();
  });

  it("upserts concorrentes não corrompem o JSON", async () => {
    await Promise.all([
      ks.upsert("openai", "sk-conc-1"),
      ks.upsert("xai", "xai-conc-2"),
      ks.upsert("openai-compat", "compat-conc-3"),
    ]);
    const raw = fs.readFileSync(ks.getFile(), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(await ks.reveal("openai")).toBe("sk-conc-1");
    expect(await ks.reveal("xai")).toBe("xai-conc-2");
    expect(await ks.list()).toEqual(["openai", "openai-compat", "xai"]);
  });

  it("preserva upserts concorrentes de instâncias distintas", async () => {
    const other = createKeystore({ dir });

    await Promise.all([
      ks.upsert("openai", "sk-first-instance"),
      other.upsert("xai", "xai-second-instance"),
    ]);

    const reopened = createKeystore({ dir });
    expect(await reopened.reveal("openai")).toBe("sk-first-instance");
    expect(await reopened.reveal("xai")).toBe("xai-second-instance");
  });
});

describe("T4 keystore — legado DPAPI sem keyring (somente leitura)", () => {
  let dir: string;
  let fake: ElectronSafeStorage;

  beforeEach(async () => {
    dir = await makeDir();
    fake = makeFakeSafeStorage();
    // Sessão "Electron": grava com safeStorage real (fake DPAPI).
    injectElectronSafeStorage(fake);
    const first = createKeystore({ dir });
    await first.upsert("openai", "sk-legado-dpapi-42");
    // Sessão "Node puro": sem keyring para ESCREVER.
    injectElectronSafeStorage(null);
  });

  afterEach(async () => {
    injectElectronSafeStorage(null);
    await cleanup();
  });

  it("registro DPAPI continua legível via ponte legada; novos writes NUNCA gravam plaintext", async () => {
    // Ponte de LEITURA para blobs DPAPI gravados por sessão Electron (o main
    // injeta o safeStorage; aqui simulamos com nodeLegacyBackend + fake).
    const ks = createKeystore({ dir, legacyReadBackend: nodeLegacyBackend(fake) });
    expect(ks.getWriteBackendName()).toBe("memory");
    expect(await ks.reveal("openai")).toBe("sk-legado-dpapi-42");
    expect(await ks.list()).toEqual(["openai"]);

    // novo upsert em memória: arquivo não é tocado (sem plaintext novo)
    await ks.upsert("xai", "xai-novo");
    const raw = fs.readFileSync(ks.getFile(), "utf8");
    expect(raw).not.toContain("xai-novo");
    // registro legado permanece: tag + data base64 que decodifica para o blob DPAPI
    expect(raw).toContain('"backend": "electron-safe-storage"');
    const parsed = JSON.parse(raw) as { scopes: Record<string, Record<string, { backend: string; data: string }>> };
    const blob = Buffer.from(parsed.scopes[DEFAULT_KEYSTORE_SCOPE]![providerApiKeyKey("openai")]!.data, "base64").toString("utf8");
    expect(blob.startsWith("DPAPI-FAKE::")).toBe(true);
  });

  it("waitForEncryptedStorage reporta aguardando keyring quando há legado", async () => {
    const ks = createKeystore({ dir, pollIntervalMs: 20 });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      expect(await ks.waitForEncryptedStorage(45)).toBe(false); // timeout sem keyring
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 20);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("delete remove o registro persistido mesmo em fallback memória", async () => {
    const ks = createKeystore({ dir, legacyReadBackend: nodeLegacyBackend(fake) });
    expect(await ks.delete("openai")).toBe(true);
    const ks2 = createKeystore({ dir, legacyReadBackend: nodeLegacyBackend(fake) });
    expect(await ks2.reveal("openai")).toBeNull();
  });

  it("sem ponte: registro legado fica indecifrável (erro claro) — nunca vaza plaintext", async () => {
    const ks = createKeystore({ dir });
    await expect(ks.reveal("openai")).rejects.toThrow(/decifrar/);
  });
});

describe("T4 keystore — chave-mestra local", () => {
  const withoutMemoryFallback = <T>(run: () => T): T => {
    const previous = process.env.OPENBOT_KEYSTORE_MEMORY;
    delete process.env.OPENBOT_KEYSTORE_MEMORY;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.OPENBOT_KEYSTORE_MEMORY;
      else process.env.OPENBOT_KEYSTORE_MEMORY = previous;
    }
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it("falha claramente em .master.key de tamanho inválido e nunca o sobrescreve", async () => {
    const dir = await makeDir();
    const file = path.join(dir, ".master.key");
    const invalid = Buffer.from("invalid-key");
    fs.writeFileSync(file, invalid);

    expect(() => withoutMemoryFallback(() => createKeystore({ dir }))).toThrow(/master\.key.*32 bytes.*não foi alterado/i);
    expect(fs.readFileSync(file)).toEqual(invalid);
  });

  it("cria .master.key exclusivamente e adota a chave vencedora de outra criação", async () => {
    const dir = await makeDir();
    const file = path.join(dir, ".master.key");
    const winner = Buffer.alloc(32, 0x5a);
    const originalWrite = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((...args: unknown[]) => {
      const [target, , options] = args;
      expect(target).toBe(file);
      expect(options).toMatchObject({ flag: "wx", mode: 0o600 });
      originalWrite(file, winner, { flag: "wx", mode: 0o600 });
      throw Object.assign(new Error("another process won"), { code: "EEXIST" });
    }));

    const first = withoutMemoryFallback(() => createKeystore({ dir }));
    writeSpy.mockRestore();
    await first.upsert("openai", "race-safe-secret");
    const second = withoutMemoryFallback(() => createKeystore({ dir }));
    await expect(second.reveal("openai")).resolves.toBe("race-safe-secret");
    expect(fs.readFileSync(file)).toEqual(winner);
  });

  it("restringe permissões da chave quando modos POSIX são suportados", async () => {
    const dir = await makeDir();
    withoutMemoryFallback(() => createKeystore({ dir }));
    const file = path.join(dir, ".master.key");
    expect(fs.readFileSync(file)).toHaveLength(32);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});

describe("T4 keystore — utilidades", () => {
  it("sob Vitest rejeita default sem OPENBOT_DATA_ROOT antes de qualquer I/O", async () => {
    const appData = await makeDir();
    const missingAppData = path.join(appData, "missing-appdata");
    const masterKey = path.join(missingAppData, "OpenBot", ".master.key");
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVitest = process.env.VITEST;
    const previousOpenBotDataRoot = process.env.OPENBOT_DATA_ROOT;
    const previousMemoryFallback = process.env.OPENBOT_KEYSTORE_MEMORY;
    const previousAppData = process.env.APPDATA;
    process.env.NODE_ENV = "production";
    process.env.VITEST = "true";
    delete process.env.OPENBOT_DATA_ROOT;
    delete process.env.OPENBOT_KEYSTORE_MEMORY;
    process.env.APPDATA = missingAppData;
    try {
      expect(fs.existsSync(path.dirname(masterKey))).toBe(false);
      expect(() => createKeystore()).toThrow(/OPENBOT_DATA_ROOT|dir/u);
      expect(fs.existsSync(path.dirname(masterKey))).toBe(false);
      expect(fs.existsSync(masterKey)).toBe(false);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousOpenBotDataRoot === undefined) delete process.env.OPENBOT_DATA_ROOT;
      else process.env.OPENBOT_DATA_ROOT = previousOpenBotDataRoot;
      if (previousMemoryFallback === undefined) delete process.env.OPENBOT_KEYSTORE_MEMORY;
      else process.env.OPENBOT_KEYSTORE_MEMORY = previousMemoryFallback;
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      await cleanup();
    }
  });

  it("defaultKeystoreDir resolve APPDATA e OPENBOT_DATA_ROOT temporários", async () => {
    const appData = await makeDir();
    const previousOpenBotDataRoot = process.env.OPENBOT_DATA_ROOT;
    const previousAppData = process.env.APPDATA;
    delete process.env.OPENBOT_DATA_ROOT;
    process.env.APPDATA = appData;
    try {
      expect(defaultKeystoreDir()).toBe(path.join(appData, "OpenBot"));
      expect(defaultSecretsFile()).toBe(
        path.join(appData, "OpenBot", "sand-secrets.json"),
      );

      const isolatedRoot = path.join(appData, "isolated-openbot-data");
      process.env.OPENBOT_DATA_ROOT = isolatedRoot;
      expect(defaultKeystoreDir()).toBe(isolatedRoot);
      expect(defaultSecretsFile()).toBe(path.join(isolatedRoot, "sand-secrets.json"));
    } finally {
      if (previousOpenBotDataRoot === undefined) delete process.env.OPENBOT_DATA_ROOT;
      else process.env.OPENBOT_DATA_ROOT = previousOpenBotDataRoot;
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      await cleanup();
    }
  });

  it("memoryBackend round-trip isola dados entre instâncias (nunca toca disco)", async () => {
    const { memoryBackend } = await import("../src/keystore/backend.js");
    const b1 = memoryBackend();
    const b2 = memoryBackend();
    const enc = b1.encrypt("segredo");
    expect(b1.decrypt(enc)).toBe("segredo");
    // outro backend (outra chave aleatória) NÃO decifra
    expect(() => b2.decrypt(enc)).toThrow();
  });
});

describe("T4 keystore — writeSecretsFile", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it("remove o temporário quando a escrita falha e preserva o destino", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "sand-secrets.json");
    const previous = '{"old":{"backend":"memory","data":"old"}}\n';
    await fs.promises.writeFile(file, previous, "utf8");
    const writeFailure = new Error("injected write failure");
    const originalOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        handle.writeFile = async () => { throw writeFailure; };
      }
      return handle;
    });

    await expect(writeSecretsFile(file, { next: { backend: "memory", data: "next" } })).rejects.toBe(writeFailure);
    openSpy.mockRestore();

    expect(await fs.promises.readFile(file, "utf8")).toBe(previous);
    const names = await fs.promises.readdir(dir);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("não remove o destino depois do rename bem-sucedido", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "sand-secrets.json");
    const unlinkSpy = vi.spyOn(fs.promises, "unlink");

    await writeSecretsFile(file, { next: { backend: "memory", data: "next" } });

    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(file, "utf8")).toContain('"next"');
  });
});
