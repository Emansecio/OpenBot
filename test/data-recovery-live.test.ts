import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteTranscriptStore } from "../src/store/index.js";
import { AttachmentStagingStore } from "../src/attachments/staging.js";
import { startServer } from "../src/main.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "openbot-data-recovery-live-"));
  temporaryRoots.push(path);
  return path;
}

function seedDatabase(path: string, rows: Array<[string, string]>): void {
  const database = new Database(path);
  try {
    database.pragma("journal_mode = WAL");
    database.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
    const insert = database.prepare("INSERT OR REPLACE INTO messages (id, content) VALUES (?, ?)");
    const transaction = database.transaction((items: Array<[string, string]>) => {
      for (const row of items) insert.run(...row);
    });
    transaction(rows);
  } finally {
    database.close();
  }
}

describe("real local data recovery", () => {
  it("refuses to bootstrap an empty profile over an existing database", async () => {
    const root = await temporaryRoot();
    const source = new SqliteTranscriptStore({ path: join(root, "store.db") });
    source.append("agent-a", [{ kind: "message", id: "marker", role: "user", content: "existing-marker", timestampMs: 1, streaming: false }]);
    source.close();
    const before = await readFile(join(root, "store.db"));
    await expect(startServer(0, { stateRoot: root })).rejects.toThrow(/Configuração ausente com banco existente/);
    expect(await readFile(join(root, "store.db"))).toEqual(before);
    await expect(readFile(join(root, "openbot-config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores an attachment into another root without reading or deleting the source", async () => {
    const base = await temporaryRoot();
    const dataRoot = join(base, "source");
    const localDataRoot = join(base, "local");
    const source = new SqliteTranscriptStore({ path: join(dataRoot, "store.db") });
    const staging = new AttachmentStagingStore({ db: source.databaseForSharedStores(), root: join(dataRoot, "attachment-staging") });
    const record = await staging.stageBytes("agent-a", { filename: "marker.txt", bytes: Buffer.from("attachment-marker") });
    source.close();
    // @ts-expect-error executable local update helper has no declaration file.
    const { createDataBackup, restoreDataBackup } = await import("../scripts/update.mjs");
    const backup = await createDataBackup({ dataRoot, localDataRoot, backupRoot: join(base, "backups") });
    const destination = join(base, "destination");
    await restoreDataBackup(backup.root, { dataRoot: destination, localDataRoot: join(base, "restored-local") });
    const restored = new SqliteTranscriptStore({ path: join(destination, "store.db") });
    try {
      const attachments = new AttachmentStagingStore({ db: restored.databaseForSharedStores(), root: join(destination, "attachment-staging") });
      expect(await attachments.commit("agent-a", record.id)).toBe(true);
      expect(attachments.get("agent-b", record.id)).toBeNull();
      const result = await attachments.resolveForSend("agent-a", [`attachment:${record.id}`], { providerSupportsImages: false });
      expect(result.attachments[0]?.text).toBe("attachment-marker");
      expect(result.skipped).toEqual([]);
      expect(await readFile(record.storedPath, "utf8")).toBe("attachment-marker");
    } finally { restored.close(); }
  });

  it("backs up, verifies, and restores a real SQLite database and local state", async () => {
    const base = await temporaryRoot();
    const dataRoot = join(base, "roaming");
    const localDataRoot = join(base, "local");
    const backupRoot = join(base, "backups");
    const databasePath = join(dataRoot, "store.db");
    await mkdir(join(localDataRoot, "workspaces", "bot-a", "Documents"), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    seedDatabase(databasePath, [["m1", "original"], ["m2", "persisted"]]);
    await writeFile(join(dataRoot, "openbot-config.json"), "config-original");
    await writeFile(join(dataRoot, "sand-secrets.json"), "encrypted-fixture");
    await writeFile(join(dataRoot, ".master.key"), "fixture-master-key");
    await writeFile(join(localDataRoot, "workspaces", "bot-a", "Documents", "note.txt"), "workspace-original");

    // @ts-expect-error executable local update helper has no declaration file.
    const { createDataBackup, restoreDataBackup, verifyDataBackup } = await import("../scripts/update.mjs");
    const backup = await createDataBackup({ dataRoot, localDataRoot, backupRoot, activeVersion: "1.0.0" });
    await expect(verifyDataBackup(backup.root)).resolves.toMatchObject({ ok: true, root: backup.root });

    seedDatabase(databasePath, [["m1", "changed"], ["m3", "new"]]);
    await writeFile(join(dataRoot, "openbot-config.json"), "config-changed");
    await writeFile(join(localDataRoot, "workspaces", "bot-a", "Documents", "note.txt"), "workspace-changed");
    await restoreDataBackup(backup.root, { dataRoot, localDataRoot });

    const restored = new Database(databasePath, { readonly: true });
    try {
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(restored.prepare("SELECT id, content FROM messages ORDER BY id").all()).toEqual([
        { id: "m1", content: "original" },
        { id: "m2", content: "persisted" },
      ]);
      expect(restored.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      restored.close();
    }
    await expect(readFile(join(dataRoot, "openbot-config.json"), "utf8")).resolves.toBe("config-original");
    await expect(readFile(join(dataRoot, "sand-secrets.json"), "utf8")).resolves.toBe("encrypted-fixture");
    await expect(readFile(join(dataRoot, ".master.key"), "utf8")).resolves.toBe("fixture-master-key");
    await expect(readFile(join(localDataRoot, "workspaces", "bot-a", "Documents", "note.txt"), "utf8"))
      .resolves.toBe("workspace-original");
  });

  it("rejects a tampered backup before restore", async () => {
    const base = await temporaryRoot();
    const dataRoot = join(base, "roaming");
    const localDataRoot = join(base, "local");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(dataRoot, "openbot-config.json"), "original");
    // @ts-expect-error executable local update helper has no declaration file.
    const { createDataBackup, verifyDataBackup } = await import("../scripts/update.mjs");
    const backup = await createDataBackup({ dataRoot, localDataRoot, backupRoot: join(base, "backups") });
    await writeFile(join(backup.root, "roaming", "openbot-config.json"), "tampered");

    await expect(verifyDataBackup(backup.root)).rejects.toThrow(/checksum mismatch/i);
  });
});
