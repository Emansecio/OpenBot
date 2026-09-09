/**
 * T4 — Testes de integração das rotas de secrets no gateway
 * (POST /api/setBoxSecrets e POST /api/getBoxSecretsStatus).
 *
 * Contrato (plano §3 T4 / spec §3.3 / mapa-funcoes §4.5):
 *   - setBoxSecrets: upsert/delete de chaves por provider → {synced, upserted, deleted}
 *   - getBoxSecretsStatus: SÓ NOMES, nunca valores → BoxSecretsStatus {secrets: string[]}
 *   - a chave cifrada nunca vaza na resposta (nem no envelope RPC)
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GATEWAY_HOST, startServer, stopServer, type ServerHandle } from "../src/main.js";
import { providerApiKeyKey, type CryptoBackend,
  injectElectronSafeStorage,
  type ElectronSafeStorage } from "../src/keystore/backend.js";
import { createKeystore, DEFAULT_KEYSTORE_SCOPE, type Keystore } from "../src/keystore/index.js";

let activeHandles: ServerHandle[] = [];
let tmpDirs: string[] = [];

afterEach(async () => {
  injectElectronSafeStorage(null);
  const handles = activeHandles;
  activeHandles = [];
  await Promise.all(handles.map((h) => stopServer(h)));
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.promises.rm(d, { recursive: true, force: true })),
  );
});

function makeFakeSafeStorage(): ElectronSafeStorage {
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

async function bootPersistent(): Promise<ServerHandle> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openbot-ks-gw-"));
  tmpDirs.push(dir);
  injectElectronSafeStorage(makeFakeSafeStorage());
  const handle = await startServer(0, {
    startedAt: "2026-08-11T00:00:00.000Z",
    keystoreDir: dir,
    configPath: path.join(dir, "config.json"),
    storePath: path.join(dir, "store.db"),
    runtimeRoot: path.join(dir, "runtime"),
    browserRoot: path.join(dir, "browser"),
    workspacesRoot: path.join(dir, "workspaces"),
    allowUnauthenticatedLocalGateway: true,
  });
  activeHandles.push(handle);
  return handle;
}

async function bootMemory(): Promise<ServerHandle> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openbot-ks-gw-mem-"));
  tmpDirs.push(dir);
  const handle = await startServer(0, {
    startedAt: "2026-08-11T00:00:00.000Z",
    keystoreDir: dir,
    configPath: path.join(dir, "config.json"),
    storePath: path.join(dir, "store.db"),
    runtimeRoot: path.join(dir, "runtime"),
    browserRoot: path.join(dir, "browser"),
    workspacesRoot: path.join(dir, "workspaces"),
    allowUnauthenticatedLocalGateway: true,
  });
  activeHandles.push(handle);
  return handle;
}

function makeInjectableBackend(failOnEncrypt = Number.POSITIVE_INFINITY): CryptoBackend {
  let encryptions = 0;
  return {
    name: "test-backend",
    encrypt(value: string): Buffer {
      encryptions += 1;
      if (encryptions === failOnEncrypt) throw new Error("injected encryption failure");
      return Buffer.from(`cipher:${value}`, "utf8");
    },
    decrypt(payload: Buffer): string {
      return payload.toString("utf8").slice("cipher:".length);
    },
  };
}

async function bootWithKeystore(keystore: Keystore): Promise<ServerHandle> {
  const dir = keystore.getDir();
  const handle = await startServer(0, {
    startedAt: "2026-08-15T00:00:00.000Z",
    keystore,
    keystoreDir: dir,
    disableAgentHome: true,
    configPath: path.join(dir, "config.json"),
    storePath: path.join(dir, "store.db"),
    runtimeRoot: path.join(dir, "runtime"),
    browserRoot: path.join(dir, "browser"),
    workspacesRoot: path.join(dir, "workspaces"),
    allowUnauthenticatedLocalGateway: true,
  });
  activeHandles.push(handle);
  return handle;
}

async function request(
  handle: ServerHandle,
  pathname: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: GATEWAY_HOST,
        port: handle.port,
        path: pathname,
        method: "POST",
        headers: { "content-type": "application/json" },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) as Record<string, unknown> });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("T4 gateway — setBoxSecrets (upsert/delete por provider)", () => {
  it("upsert → {ok,value:{synced:true,upserted:[...]}} e chave cifrada no disco", async () => {
    const h = await bootPersistent();
    const res = await request(h, "/api/setBoxSecrets", {
      entries: [{ provider: "openai", apiKey: "sk-super-secreta-1" }],
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const value = res.json.value as { synced: boolean; upserted: string[]; deleted: string[] };
    expect(value.synced).toBe(true);
    expect(value.upserted).toEqual(["openai"]);
    expect(value.deleted).toEqual([]);

    // chave NUNCA vaza na resposta
    const raw = JSON.stringify(res.json);
    expect(raw).not.toContain("sk-super-secreta-1");

    // disco: registros cifrados, sem plaintext
    const file = path.join(h.keystore.getDir(), "sand-secrets.json");
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).not.toContain("sk-super-secreta-1");
    const parsed = JSON.parse(onDisk) as { scopes: Record<string, Record<string, { backend: string; data: string }>> };
    const entry = parsed.scopes[DEFAULT_KEYSTORE_SCOPE]?.[providerApiKeyKey("openai")];
    if (entry === undefined) throw new Error("openai secret was not persisted");
    expect(entry.backend).toBe("electron-safe-storage");
  });

  it("upsert múltiplo + delete → {synced, upserted, deleted}", async () => {
    const h = await bootPersistent();
    const up = await request(h, "/api/setBoxSecrets", {
      entries: [
        { provider: "openai", apiKey: "sk-a" },
        { provider: "xai", apiKey: "xai-b" },
        { provider: "openai-compat", apiKey: "lm-c" },
      ],
    });
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({
      ok: true,
      value: { synced: true, upserted: ["openai", "xai", "openai-compat"], deleted: [] },
    });

    const del = await request(h, "/api/setBoxSecrets", { delete: ["openai"] });
    expect(del.status).toBe(200);
    const value = del.json.value as { synced: boolean; upserted: string[]; deleted: string[] };
    expect(value.synced).toBe(true);
    expect(value.upserted).toEqual([]);
    expect(value.deleted).toEqual(["openai"]);
    const status = await request(h, "/api/getBoxSecretsStatus", {});
    expect(status.json).toMatchObject({
      ok: true,
      value: { secrets: ["openai-compat", "xai"] },
    });
  });

  it("corpo inválido → 400 {ok:false,failure}", async () => {
    const h = await bootPersistent();
    const electronNoop = await request(h, "/api/setBoxSecrets", { secrets: {} });
    expect(electronNoop.status).toBe(200);
    expect(electronNoop.json).toMatchObject({
      ok: true,
      value: { synced: true, upserted: [], deleted: [] },
    });

    const empty = await request(h, "/api/setBoxSecrets", {});
    expect(empty.status).toBe(400);
    expect(empty.json).toMatchObject({ ok: false, failure: expect.stringMatching(/nada para fazer/iu) });

    const bad = await request(h, "/api/setBoxSecrets", { entries: [{ provider: "openai" }] });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false, failure: expect.stringMatching(/provider e apiKey/iu) });

    const badName = await request(h, "/api/setBoxSecrets", {
      entries: [{ provider: "open ai", apiKey: "x" }],
    });
    expect(badName.status).toBe(400);
    expect(badName.json).toMatchObject({ ok: false, failure: expect.stringMatching(/provider ou apiKey inv[aá]lido/iu) });
  });

  it("falha intermediária não deixa lote parcialmente persistido", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openbot-ks-gw-fail-"));
    tmpDirs.push(dir);
    const backend = makeInjectableBackend(3);
    const keystore = createKeystore({ dir, writeBackend: backend, legacyReadBackend: backend });
    const h = await bootWithKeystore(keystore);

    await request(h, "/api/setBoxSecrets", {
      entries: [{ provider: "openai", apiKey: "old-openai" }],
    });
    const failed = await request(h, "/api/setBoxSecrets", {
      entries: [
        { provider: "xai", apiKey: "xai-partial" },
        { provider: "openai-compat", apiKey: "compat-fails" },
      ],
    });

    expect(failed.status).toBe(500);
    expect(await keystore.reveal("openai")).toBe("old-openai");
    expect(await keystore.reveal("xai")).toBeNull();
    expect(await keystore.reveal("openai-compat")).toBeNull();
    const onDisk = JSON.parse(fs.readFileSync(keystore.getFile(), "utf8")) as { scopes: Record<string, Record<string, unknown>> };
    expect(Object.keys(onDisk.scopes[DEFAULT_KEYSTORE_SCOPE] ?? {})).toEqual([providerApiKeyKey("openai")]);
  });

  it("aplica lote misto de upserts e delete de uma vez", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openbot-ks-gw-mixed-"));
    tmpDirs.push(dir);
    const backend = makeInjectableBackend();
    const keystore = createKeystore({ dir, writeBackend: backend, legacyReadBackend: backend });
    const h = await bootWithKeystore(keystore);
    await keystore.upsert("openai-compat", "old-compat");

    const applied = await request(h, "/api/setBoxSecrets", {
      entries: [
        { provider: "openai", apiKey: "new-openai" },
        { provider: "xai", apiKey: "new-xai" },
      ],
      delete: ["openai-compat"],
    });

    expect(applied.status).toBe(200);
    expect(applied.json.value).toMatchObject({
      synced: true,
      upserted: ["openai", "xai"],
      deleted: ["openai-compat"],
    });
    expect(await keystore.list()).toEqual(["openai", "xai"]);
    expect(await keystore.reveal("openai")).toBe("new-openai");
    expect(await keystore.reveal("xai")).toBe("new-xai");
    expect(await keystore.reveal("openai-compat")).toBeNull();
  });
});

describe("T4 gateway — getBoxSecretsStatus (só nomes, nunca valores)", () => {
  it("vazio → {ok,value:{secrets:[]}}", async () => {
    const h = await bootPersistent();
    const res = await request(h, "/api/getBoxSecretsStatus", {});
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.value).toEqual({ secrets: [], keys: [], isApplied: true, lastAppliedAtMs: null });
  });

  it("com chaves → lista só nomes, nenhum valor no envelope", async () => {
    const h = await bootPersistent();
    await request(h, "/api/setBoxSecrets", {
      entries: [
        { provider: "openai", apiKey: "sk-openai-valor-secreto" },
        { provider: "xai", apiKey: "xai-outro-valor-secreto" },
      ],
    });
    const res = await request(h, "/api/getBoxSecretsStatus", {});
    expect(res.status).toBe(200);
    const value = res.json.value as { secrets: string[] };
    expect(value.secrets).toEqual(["openai", "xai"]);

    // nunca valores
    const raw = JSON.stringify(res.json);
    expect(raw).not.toContain("sk-openai-valor-secreto");
    expect(raw).not.toContain("xai-outro-valor-secreto");
    expect(raw).not.toContain("apiKey");
  });

  it("modo memória (Node puro): mesmo contrato, sem tocar disco", async () => {
    const h = await bootMemory();
    const up = await request(h, "/api/setBoxSecrets", {
      entries: [{ provider: "openai", apiKey: "sk-memoria" }],
    });
    expect(up.status).toBe(200);

    const res = await request(h, "/api/getBoxSecretsStatus", {});
    expect((res.json.value as { secrets: string[] }).secrets).toEqual(["openai"]);

    // arquivo NUNCA é criado no modo memória
    expect(fs.existsSync(path.join(h.keystore.getDir(), "sand-secrets.json"))).toBe(false);
  });
});
