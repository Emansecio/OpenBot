/**
 * T4 — Testes da keystore de providers (src/keystore/).
 *
 * Done (plano §3 T4):
 *   - round-trip encrypt/decrypt (upsert → reveal devolve o mesmo valor);
 *   - NENHUMA chave aparece em claro no disco (scan do arquivo sand-secrets.json);
 *   - fallback em memória: sem keyring, upsert/reveal/delete/list funcionam e
 *     nada é gravado em disco;
 *   - leitura somente-leitura de registros legados `electron-safe-storage`;
 *   - API por provider com validação de nome/valor.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { providerApiKeyKey, type CryptoBackend, localFileBackend } from "../src/keystore/backend.js";
import { createKeystore, DEFAULT_KEYSTORE_SCOPE, type Keystore, defaultKeystoreDir, defaultSecretsFile } from "../src/keystore/index.js";
import { randomBytes } from "node:crypto";
import { TempRoots } from "./helpers/temp-roots.js";

// ── helpers de teste ─────────────────────────────────────────────────────

/**
 * Backend FAKE determinístico — simula o DPAPI do Windows (testes). Prefixo +
 * reverse: cifra suficiente para round-trip e scan (nunca contém o plaintext).
 */
function makeFakeDpapi(name = "fake-dpapi"): CryptoBackend {
  return {
    name,
    encrypt: (plainText: string) =>
      Buffer.from(`DPAPI-FAKE::${Buffer.from(plainText, "utf8").reverse().toString("base64")}`, "utf8"),
    decrypt: (encrypted: Buffer) => {
      const s = encrypted.toString("utf8");
      if (!s.startsWith("DPAPI-FAKE::")) throw new Error("payload desconhecido");
      return Buffer.from(s.slice("DPAPI-FAKE::".length), "base64").reverse().toString("utf8");
    },
  };
}

/** Leitor somente-leitura de registros `electron-safe-storage` gravados com o fake. */
function legacyReader(fake: CryptoBackend): CryptoBackend {
  return {
    name: "electron-safe-storage",
    encrypt: () => { throw new Error("legado é somente leitura"); },
    decrypt: (payload: Buffer) => fake.decrypt(payload),
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

  it("namespace da chave: scoped:v1:provider:<name>:apiKey", async () => {
    expect(providerApiKeyKey("openai")).toBe("scoped:v1:provider:openai:apiKey");
    expect(providerApiKeyKey("openai-compat")).toBe(
      "scoped:v1:provider:openai-compat:apiKey",
    );
  });
});

describe("T4 keystore — persistência criptografada (backend DPAPI simulado)", () => {
  let dir: string;
  let ks: Keystore;
  const fake = makeFakeDpapi();
  const open = (): Keystore => createKeystore({ dir, writeBackend: fake });

  beforeEach(async () => {
    dir = await makeDir();
    ks = open();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("round-trip persistente: upsert → reveal; arquivo criado com registros cifrados", async () => {
    await ks.upsert("openai", "sk-ant-1234567890");
    expect(ks.getWriteBackendName()).toBe("fake-dpapi");
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
      expect(entry.backend).toBe("fake-dpapi");
      expect(typeof entry.data).toBe("string");
      expect(entry.data).not.toContain(s.key);
    }
  });

  it("re-leitura: nova instância lê do disco (persistência entre sessões)", async () => {
    await ks.upsert("openai", "sk-persistente-777");
    const ks2 = open();
    expect(await ks2.reveal("openai")).toBe("sk-persistente-777");
    expect(await ks2.list()).toEqual(["openai"]);
  });

  it("hidrata a cache de redaction de registros cifrados antes do primeiro reveal", async () => {
    await ks.upsert("openai", "sk-hydrate-777");
    const ks2 = open();
    expect(ks2.sensitiveValues()).toEqual([]);
    ks2.hydrateSensitiveValues();
    expect(ks2.sensitiveValues()).toContain("sk-hydrate-777");
  });

  it("hidratação recusa arquivo de segredos corrompido com erro claro e sem sobrescrevê-lo", () => {
    const file = path.join(dir, "sand-secrets.json");
    fs.writeFileSync(file, "{\"version\":2,\"scopes\":{", "utf8");
    const ks2 = open();
    expect(() => ks2.hydrateSensitiveValues()).toThrow(/sand-secrets\.json não é um objeto JSON válido/);
    expect(fs.readFileSync(file, "utf8")).toBe("{\"version\":2,\"scopes\":{");
  });

  it("delete remove do disco; instância nova não vê mais a chave", async () => {
    await ks.upsert("openai", "sk-para-deletar");
    expect(await ks.delete("openai")).toBe(true);
    const ks2 = open();
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
    const other = open();

    await Promise.all([
      ks.upsert("openai", "sk-first-instance"),
      other.upsert("xai", "xai-second-instance"),
    ]);

    const reopened = open();
    expect(await reopened.reveal("openai")).toBe("sk-first-instance");
    expect(await reopened.reveal("xai")).toBe("xai-second-instance");
  });
});

describe("T4 keystore — legado electron-safe-storage (somente leitura)", () => {
  let dir: string;
  const fake = makeFakeDpapi("electron-safe-storage");

  beforeEach(async () => {
    dir = await makeDir();
    // Sessão antiga: registros gravados com a tag `electron-safe-storage`.
    const first = createKeystore({ dir, writeBackend: fake });
    await first.upsert("openai", "sk-legado-dpapi-42");
  });

  afterEach(async () => {
    await cleanup();
  });

  it("registro legado continua legível via leitor dedicado; novos writes NUNCA gravam plaintext", async () => {
    // Sessão atual em memória, com leitor somente-leitura dos blobs legados.
    const ks = createKeystore({ dir, legacyReadBackend: legacyReader(fake) });
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

  it("delete remove o registro persistido mesmo em fallback memória", async () => {
    const ks = createKeystore({ dir, legacyReadBackend: legacyReader(fake) });
    expect(await ks.delete("openai")).toBe(true);
    const ks2 = createKeystore({ dir, legacyReadBackend: legacyReader(fake) });
    expect(await ks2.reveal("openai")).toBeNull();
  });

  it("sem leitor compatível: registro legado fica indecifrável (erro claro) — nunca vaza plaintext", async () => {
    const unavailable: CryptoBackend = {
      name: "electron-safe-storage",
      encrypt: () => { throw new Error("legado é somente leitura"); },
      decrypt: () => { throw new Error("perfil DPAPI indisponível"); },
    };
    const ks = createKeystore({ dir, legacyReadBackend: unavailable });
    await expect(ks.reveal("openai")).rejects.toThrow(/decifrar/);
  });
});

describe("T4 keystore — chave-mestra local", () => {
  const withoutMemoryFallback = <T>(run: () => T): T => {
    const previous = process.env.OPENBOT_KEYSTORE_MEMORY;
    const previousBackend = process.env.OPENBOT_KEYSTORE_BACKEND;
    delete process.env.OPENBOT_KEYSTORE_MEMORY;
    process.env.OPENBOT_KEYSTORE_BACKEND = "local-file";
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.OPENBOT_KEYSTORE_MEMORY;
      else process.env.OPENBOT_KEYSTORE_MEMORY = previous;
      if (previousBackend === undefined) delete process.env.OPENBOT_KEYSTORE_BACKEND;
      else process.env.OPENBOT_KEYSTORE_BACKEND = previousBackend;
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
    let injected = false;
    const originalRead = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      const [target] = args;
      if (target === file && !injected) {
        injected = true;
        fs.writeFileSync(file, winner, { flag: "wx", mode: 0o600 });
        throw Object.assign(new Error("another process won"), { code: "ENOENT" });
      }
      return originalRead(...(args as Parameters<typeof fs.readFileSync>));
    }));

    const first = withoutMemoryFallback(() => createKeystore({ dir }));
    readSpy.mockRestore();
    expect(injected).toBe(true);
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

describe("T4 keystore — formato do arquivo", () => {
  afterEach(async () => {
    await cleanup();
  });

  it("recusa uma versão desconhecida em vez de lê-la como legado vazio", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "sand-secrets.json");
    const future = JSON.stringify({ version: 3, scopes: { [DEFAULT_KEYSTORE_SCOPE]: { x: { backend: "memory", data: "AAAA" } } } });
    fs.writeFileSync(file, future, "utf8");
    const ks = createKeystore({ dir, writeBackend: makeFakeDpapi() });

    await expect(ks.reveal("openai")).rejects.toThrow(/versão não suportada: 3/);
    await expect(ks.upsert("openai", "sk-nao-sobrescreve")).rejects.toThrow(/versão não suportada/);
    expect(fs.readFileSync(file, "utf8")).toBe(future);
  });

  it("lista providers a partir de uma única leitura do arquivo", async () => {
    const dir = await makeDir();
    const fake = makeFakeDpapi();
    const writer = createKeystore({ dir, writeBackend: fake });
    await writer.upsert("openai", "sk-a");
    await writer.upsert("xai", "xai-b");
    const readSpy = vi.spyOn(fs.promises, "readFile");
    try {
      const reader = createKeystore({ dir, writeBackend: fake });
      expect(await reader.list()).toEqual(["openai", "xai"]);
      const secretReads = () => readSpy.mock.calls.filter(([file]) => String(file).endsWith("sand-secrets.json")).length;
      expect(secretReads()).toBe(1);
      // list() decrypted both entries; reveal is now served from the process cache.
      expect(await reader.reveal("xai")).toBe("xai-b");
      expect(secretReads()).toBe(1);
    } finally {
      readSpy.mockRestore();
    }
  });
});

describe("local-file backend persistence", () => {
  const temp = new TempRoots();
  afterEach(async () => {
    await temp.cleanup();
  });

  it("persists across keystore instances and deletes from disk", async () => {
    const dir = temp.make("openbot-keystore-local-file-");
    const key = randomBytes(32);
    const first = createKeystore({ dir, writeBackend: localFileBackend(key) });
    expect(first.isPersistent()).toBe(true);
    await first.upsert("xai", "xai-persist-1");
    const raw = fs.readFileSync(first.getFile(), "utf8");
    expect(raw).not.toContain("xai-persist-1");
    const second = createKeystore({ dir, writeBackend: localFileBackend(key) });
    expect(await second.reveal("xai")).toBe("xai-persist-1");
    expect(await second.delete("xai")).toBe(true);
    const third = createKeystore({ dir, writeBackend: localFileBackend(key) });
    expect(await third.reveal("xai")).toBeNull();
  });
});
