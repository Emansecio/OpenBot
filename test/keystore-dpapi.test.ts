import { randomBytes } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dpapiCurrentUserBackend, loadDpapiAddon } from "../src/keystore/dpapi.js";
import { migrateLocalFileToDpapi, writeScopedSecretsFile } from "../src/keystore/index.js";
import { localFileBackend, providerApiKeyKey } from "../src/keystore/backend.js";
import { TempRoots } from "./helpers/temp-roots.js";

// The live CurrentUser round trip is in keystore-dpapi-live.test.ts (opt-in).
const temp = new TempRoots();
afterEach(async () => {
  await temp.cleanup();
});

describe("DPAPI CurrentUser backend and migration", () => {
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
    const root = await temp.makeAsync("openbot-dpapi-rollback-red-");
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
    await expect(readdir(root)).resolves.not.toEqual(expect.arrayContaining([expect.stringMatching(/migration-(?:tmp|backup)/)]));
  });

  it("migração transacional preserva chave e arquivo antes do rename e arquiva após verificação", async () => {
    const root = await temp.makeAsync("openbot-dpapi-migration-");
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
    await expect(readdir(root)).resolves.toEqual(expect.arrayContaining([expect.stringMatching(/^\.master\.key\.migrated-/)]));
    const migratedPayload = Buffer.from(
      (JSON.parse(await readFile(file, "utf8")) as { scopes: Record<string, Record<string, { data: string }>> }).scopes["openbot-default"]![providerApiKeyKey("openai")]!.data,
      "base64",
    );
    expect(fake.decrypt(migratedPayload)).toBe(oldValue);
    migratedPayload.fill(0);
  });
});
