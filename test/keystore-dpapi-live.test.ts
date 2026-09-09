import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dpapiCurrentUserBackend, loadDpapiAddon } from "../src/keystore/dpapi.js";
import { createKeystore, migrateLocalFileToDpapi, writeScopedSecretsFile } from "../src/keystore/index.js";
import { localFileBackend, providerApiKeyKey } from "../src/keystore/backend.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DPAPI CurrentUser", () => {
  it.skipIf(process.platform !== "win32" || process.env.OPENBOT_RUN_DPAPI_LIVE !== "1")("live: write, restart, reveal, delete e plaintext ausente do disco", async () => {
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeTruthy();
    for (const script of ["build", "verify:backend-artifacts", "verify:dpapi-artifacts"]) {
      execFileSync(process.execPath, [npmCli!, "run", script], { stdio: "pipe" });
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "openbot-dpapi-live-"));
    roots.push(root);
    const addonPath = path.resolve("native", "dpapi", `win32-${process.arch}`, "openbot-dpapi.node");
    expect(existsSync(addonPath)).toBe(true);
    const backend = dpapiCurrentUserBackend();
    const first = createKeystore({ dir: root, writeBackend: backend, legacyReadBackend: backend });
    await first.upsert("openai", "live-secret-not-on-disk");
    const raw = await readFile(first.getFile(), "utf8");
    expect(raw).not.toContain("live-secret-not-on-disk");
    const child = execFileSync(process.execPath, ["-e", [
      "import { createKeystore } from './dist/keystore/index.js';",
      "const ks = createKeystore({ dir: process.env.OPENBOT_LIVE_DIR });",
      "const value = await ks.reveal('openai');",
      "if (value !== 'live-secret-not-on-disk') throw new Error('unexpected reveal value');",
      "process.stdout.write('REVEALED');",
    ].join("\n")], { env: { ...process.env, OPENBOT_LIVE_DIR: root, OPENBOT_KEYSTORE_MEMORY: undefined, VITEST: undefined, NODE_ENV: "production" }, encoding: "utf8" });
    expect(child).toBe("REVEALED");
    expect(await first.delete("openai")).toBe(true);
    expect(await first.reveal("openai")).toBeNull();
  });

  it("unitário: backend recebe payload tagueado e zera contrato sem plaintext", () => {
    let protectedPlain: Buffer | undefined;
    let unprotectedCipher: Buffer | undefined;
    let returnedPlain: Buffer | undefined;
    const addon = {
      protect: (input: Buffer) => {
        protectedPlain = input;
        return Buffer.from(input).reverse();
      },
      unprotect: (input: Buffer) => {
        unprotectedCipher = input;
        returnedPlain = Buffer.from(input).reverse();
        return returnedPlain;
      },
    };
    const backend = dpapiCurrentUserBackend({ addon });
    const payload = backend.encrypt("unit-secret");
    expect(backend.name).toBe("dpapi-current-user");
    expect(payload.toString("utf8")).not.toContain("unit-secret");
    expect(protectedPlain).toEqual(Buffer.alloc(Buffer.byteLength("unit-secret")));
    expect(backend.decrypt(payload)).toBe("unit-secret");
    expect(unprotectedCipher).toEqual(Buffer.alloc(Buffer.byteLength("unit-secret")));
    expect(returnedPlain).toEqual(Buffer.alloc(Buffer.byteLength("unit-secret")));
  });

  it("falha fechado quando o addon não carrega", () => {
    expect(() => loadDpapiAddon({ modulePath: path.join(os.tmpdir(), "missing-openbot-dpapi.node") })).toThrow(/addon DPAPI CurrentUser indisponível/);
  });

  it("falha pós-rename restaura o arquivo legado promovido", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openbot-dpapi-rollback-red-"));
    roots.push(root);
    const master = randomBytes(32);
    await writeFile(path.join(root, ".master.key"), master);
    const legacy = localFileBackend(master);
    const openai = legacy.encrypt("legacy-openai");
    const xai = legacy.encrypt("legacy-xai");
    await writeScopedSecretsFile(path.join(root, "sand-secrets.json"), {
      version: 2,
      scopes: { "openbot-default": {
        [providerApiKeyKey("openai")]: { backend: "local-file", data: openai.toString("base64") },
        [providerApiKeyKey("xai")]: { backend: "local-file", data: xai.toString("base64") },
      } },
    });
    openai.fill(0); xai.fill(0); master.fill(0);
    const before = await readFile(path.join(root, "sand-secrets.json"));
    const failing = {
      name: "dpapi-current-user",
      encrypt: (value: string) => Buffer.from(value, "utf8").reverse(),
      decrypt: () => { throw new Error("injected-post-rename-verification"); },
    };
    await expect(migrateLocalFileToDpapi({ dir: root, dpapiBackend: failing })).rejects.toThrow("injected-post-rename-verification");
    // Regression: post-promotion verification failure must restore exact AES
    // bytes instead of leaving the promoted DPAPI shape behind.
    expect(await readFile(path.join(root, "sand-secrets.json"))).toEqual(before);
    await expect(stat(path.join(root, ".master.key"))).resolves.toBeTruthy();
    await expect((await import("node:fs/promises")).readdir(root)).resolves.not.toEqual(expect.arrayContaining([expect.stringMatching(/migration-(?:tmp|backup)/)]));
  });

  it("migração transacional preserva chave e arquivo antes do rename e arquiva após verificação", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openbot-dpapi-migration-"));
    roots.push(root);
    const master = randomBytes(32);
    await writeFile(path.join(root, ".master.key"), master);
    const legacy = localFileBackend(master);
    const oldValue = "legacy-secret";
    const encrypted = legacy.encrypt(oldValue);
    await writeScopedSecretsFile(path.join(root, "sand-secrets.json"), {
      version: 2,
      scopes: { "openbot-default": { [providerApiKeyKey("openai")]: { backend: "local-file", data: encrypted.toString("base64") } } },
    });
    encrypted.fill(0);
    master.fill(0);
    const fake = dpapiCurrentUserBackend({
      addon: {
        protect: (input) => Buffer.from(input).reverse(),
        unprotect: (input) => Buffer.from(input).reverse(),
      },
    });
    const file = path.join(root, "sand-secrets.json");
    const keyFile = path.join(root, ".master.key");
    const before = await readFile(file);
    await expect(migrateLocalFileToDpapi({ dir: root, dpapiBackend: fake, beforeRename: () => { throw new Error("injected-before-rename"); } })).rejects.toThrow("injected-before-rename");
    expect(await readFile(file)).toEqual(before);
    await expect(stat(keyFile)).resolves.toBeTruthy();
    await expect(migrateLocalFileToDpapi({ dir: root, dpapiBackend: fake })).resolves.toBe(true);
    const migrated = JSON.parse(await readFile(file, "utf8")) as { scopes: Record<string, Record<string, { backend: string }>> };
    expect(migrated.scopes["openbot-default"]![providerApiKeyKey("openai")]!.backend).toBe("dpapi-current-user");
    await expect(stat(keyFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect((await import("node:fs/promises")).readdir(root)).resolves.toEqual(expect.arrayContaining([expect.stringMatching(/^\.master\.key\.migrated-/)]));
    const migratedPayload = Buffer.from(
      (JSON.parse(await readFile(file, "utf8")) as { scopes: Record<string, Record<string, { data: string }>> }).scopes["openbot-default"]![providerApiKeyKey("openai")]!.data,
      "base64",
    );
    expect(fake.decrypt(migratedPayload)).toBe(oldValue);
    migratedPayload.fill(0);
  });
});
