import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createKeystore,
  DEFAULT_KEYSTORE_SCOPE,
  normalizeKeystoreScope,
} from "../src/keystore/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "openbot-keystore-scope-"));
  dirs.push(dir);
  return dir;
};

describe("scoped keystore (melhoria 5)", () => {
  it("isolates secrets between agent scopes", async () => {
    const ks = createKeystore({ dir: await makeDir() });
    await ks.upsert("openai", "sk-bot-a", "agent-a");
    await ks.upsert("openai", "sk-bot-b", "agent-b");

    expect(await ks.reveal("openai", "agent-a")).toBe("sk-bot-a");
    expect(await ks.reveal("openai", "agent-b")).toBe("sk-bot-b");
    // Sem escopo → escopo padrão, que não vê nenhum dos dois.
    expect(await ks.reveal("openai")).toBeNull();
    expect(await ks.list("agent-a")).toEqual(["openai"]);
    expect(await ks.list("agent-b")).toEqual(["openai"]);
    expect(await ks.list()).toEqual([]);
  });

  it("delete is scoped: removing in one bot keeps the other", async () => {
    const ks = createKeystore({ dir: await makeDir() });
    await ks.upsert("xai", "shared-name-1", "agent-a");
    await ks.upsert("xai", "shared-name-2", "agent-b");
    expect(await ks.delete("xai", "agent-a")).toBe(true);
    expect(await ks.reveal("xai", "agent-a")).toBeNull();
    expect(await ks.reveal("xai", "agent-b")).toBe("shared-name-2");
  });

  it("migrates and rewrites v1 files with an injected deterministic backend", async () => {
    const dir = await makeDir();
    const file = join(dir, "sand-secrets.json");
    const cipher = (value: string): string => Buffer.from(`CIPHER::${value}`).toString("base64");
    const decipher = (payload: Buffer): string => {
      const decoded = payload.toString("utf8");
      if (!decoded.startsWith("CIPHER::")) throw new Error("not ours");
      return decoded.slice("CIPHER::".length);
    };
    const backend = {
      name: "unit-cipher",
      encrypt: (value: string) => Buffer.from(cipher(value), "utf8"),
      decrypt: (payload: Buffer) => decipher(payload),
    };
    // v1 file whose entries were written by this same deterministic backend.
    await writeFile(file, `${JSON.stringify({
      "scoped:v1:provider:openai:apiKey": { backend: "unit-cipher", data: cipher("legacy-secret") },
    })}\n`);
    const ks = createKeystore({ dir, writeBackend: backend });
    expect(await ks.reveal("openai")).toBe("legacy-secret");

    // Primeiro write no escopo padrão regrava o arquivo em formato v2.
    await ks.upsert("xai", "new-secret");
    const onDisk = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      scopes: Record<string, Record<string, { backend: string; data: string }>>;
    };
    expect(onDisk.version).toBe(2);
    expect(Object.keys(onDisk.scopes)).toEqual([DEFAULT_KEYSTORE_SCOPE]);
    expect(await ks.reveal("openai")).toBe("legacy-secret");
    // Escopo diferente não vê o legado migrado.
    expect(await ks.reveal("openai", "agent-b")).toBeNull();
  });

  it("applySecretBatch and list honor the scope", async () => {
    const ks = createKeystore({ dir: await makeDir() });
    await ks.applySecretBatch(
      [{ provider: "openai", apiKey: "a-1" }],
      [],
      "agent-a",
    );
    await ks.applySecretBatch(
      [{ provider: "xai", apiKey: "b-1" }],
      ["openai"],
      "agent-b",
    );
    expect(await ks.list("agent-a")).toEqual(["openai"]);
    expect(await ks.list("agent-b")).toEqual(["xai"]);
  });

  it("rejects invalid scopes", () => {
    expect(normalizeKeystoreScope(undefined)).toBe(DEFAULT_KEYSTORE_SCOPE);
    expect(() => normalizeKeystoreScope("../escape")).toThrow(/inválido/i);
    expect(() => normalizeKeystoreScope("has space")).toThrow(/inválido/i);
  });
});
