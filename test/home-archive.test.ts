import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HOME_ARCHIVE_MAX_BYTES,
  DEFAULT_HOME_ARCHIVE_MAX_ENTRIES,
  HOME_ARCHIVE_CHUNK_BYTES,
  HOME_ARCHIVE_MAX_METADATA_BYTES,
  exportHomeArchive,
  materializeHomeArchive,
  readHomeArchiveSummary,
  validateHomeArchive,
  type HomeArchiveDocument,
  type HomeArchiveManifest,
} from "../src/execution/home-archive.js";
import { AgentHomeStore } from "../src/execution/home.js";
import { DEFAULT_WORKSPACE_QUOTA } from "../src/execution/quota.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openbot-stream-archive-"));
  roots.push(root);
  const store = await AgentHomeStore.create(join(root, "workspaces"), {
    acl: { async apply() { return { status: "not-applicable", platform: "linux" }; } },
  });
  const home = await store.ensure("portable");
  return { root, store, home };
}

async function legacyDocument(root: string, manifest: HomeArchiveManifest): Promise<HomeArchiveDocument> {
  const entries = await Promise.all(manifest.entries.map(async (entry) => entry.type === "directory" ? entry : {
    ...entry, contentBase64: (await readFile(join(root, ...entry.path.split("/")))).toString("base64"),
  }));
  return { format: "openbot-home-archive", version: 1, manifest: { ...manifest, entries } };
}

// Reframe a small fixture header without changing any raw file bodies.
function replaceHeader(bytes: Buffer, change: (document: HomeArchiveDocument) => void): Buffer {
  const prefixSize = bytes.indexOf(0) + 2;
  const length = bytes.readUInt32LE(prefixSize);
  const start = prefixSize + 4;
  const document = JSON.parse(bytes.subarray(start, start + length).toString("utf8")) as HomeArchiveDocument;
  change(document);
  const header = Buffer.from(JSON.stringify(document));
  const prefix = Buffer.from(bytes.subarray(0, start));
  prefix.writeUInt32LE(header.length, prefixSize);
  return Buffer.concat([prefix, header, bytes.subarray(start + length)]);
}

describe("streamed home archives", () => {
  it("aligns default limits with the existing workspace quota", () => {
    expect(DEFAULT_HOME_ARCHIVE_MAX_BYTES).toBe(DEFAULT_WORKSPACE_QUOTA.maxBytes);
    expect(DEFAULT_HOME_ARCHIVE_MAX_ENTRIES).toBe(DEFAULT_WORKSPACE_QUOTA.maxEntries);
  });

  it("round-trips a multi-chunk binary file with bounded allocations and unchanged SHA-256", async () => {
    const { root, home } = await fixture();
    const file = await open(join(home.root, "Projects", "large.bin"), "wx");
    const chunk = Buffer.alloc(HOME_ARCHIVE_CHUNK_BYTES, 0xa5);
    const digest = createHash("sha256");
    const fileBytes = 16 * 1024 * 1024;
    try {
      for (let offset = 0; offset < fileBytes; offset += chunk.length) {
        await file.write(chunk);
        digest.update(chunk);
      }
    } finally { await file.close(); }
    await writeFile(join(home.root, "Projects", "empty.bin"), "");
    const archive = join(root, "large.obhome");
    const allocation = vi.spyOn(Buffer, "allocUnsafe");
    const exported = await exportHomeArchive(home.root, "portable", archive);
    const checked = await validateHomeArchive(archive, "portable");
    const stage = join(root, "stage");
    await materializeHomeArchive(checked, stage);
    const maxAllocation = Math.max(...allocation.mock.calls.map(([size]) => size));
    allocation.mockRestore();
    expect(maxAllocation).toBeLessThanOrEqual(HOME_ARCHIVE_CHUNK_BYTES);
    expect(checked.version).toBe(2);
    expect(exported.manifest.entries.every((entry) => entry.contentBase64 === undefined)).toBe(true);
    expect(exported.manifest.entries.find((entry) => entry.path === "Projects/large.bin")).toMatchObject({ size: fileBytes, sha256: digest.digest("hex") });
    expect((await stat(archive)).size).toBeLessThan(exported.manifest.totalBytes + 16_384);
    expect(createHash("sha256").update(await readFile(join(stage, "Projects", "large.bin"))).digest("hex"))
      .toBe(exported.manifest.entries.find((entry) => entry.path === "Projects/large.bin")!.sha256);
    expect((await stat(join(stage, "Projects", "empty.bin"))).size).toBe(0);
  });

  it("reads v1 JSON hashes and mixed legacy/new snapshots without migrating user files", async () => {
    const { root, store, home } = await fixture();
    await writeFile(join(home.root, "Documents", "keep.txt"), "legacy-state");
    const first = await store.snapshot("portable");
    expect(first.path).toMatch(/1\.obhome$/u);
    const legacy = await legacyDocument(home.root, first.manifest);
    const legacyPath = join(dirname(first.path), "2.json");
    await writeFile(legacyPath, JSON.stringify(legacy));
    const checked = await validateHomeArchive(legacyPath, "portable");
    expect(checked.version).toBe(1);
    expect(checked.manifest.entries.find((entry) => entry.path === "Documents/keep.txt")?.sha256).toBe(createHash("sha256").update("legacy-state").digest("hex"));
    expect((await store.listSnapshots("portable")).map((entry) => entry.seq)).toEqual([1, 2]);
    await writeFile(join(home.root, "Documents", "keep.txt"), "current-state");
    const restored = await store.restoreSnapshot("portable", 2);
    expect(await readFile(join(restored.root, "Documents", "keep.txt"), "utf8")).toBe("legacy-state");
    expect((await store.snapshot("portable")).seq).toBe(3);
    legacy.manifest.entries.find((entry) => entry.path === "Documents/keep.txt")!.sha256 = "0".repeat(64);
    await writeFile(join(root, "bad-legacy.json"), JSON.stringify(legacy));
    await expect(validateHomeArchive(join(root, "bad-legacy.json"), "portable")).rejects.toMatchObject({ code: "integrity_error" });
  });

  it("keeps listing metadata-only and rechecks changed bodies during materialization", async () => {
    const { root, home } = await fixture();
    const archive = join(root, "changed.obhome");
    await exportHomeArchive(home.root, "portable", archive);
    const checked = await validateHomeArchive(archive, "portable");
    const bytes = await readFile(archive);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(archive, bytes);
    await expect(readHomeArchiveSummary(archive, "portable")).resolves.toMatchObject({ agentId: "portable" });
    await expect(materializeHomeArchive(checked, join(root, "unpublished"))).rejects.toMatchObject({ code: "integrity_error" });
    await expect(validateHomeArchive(archive, "portable")).rejects.toMatchObject({ code: "integrity_error" });
  });

  it("rejects traversal, aliases, collisions, count mismatch and truncation before publication", async () => {
    const { root, store, home } = await fixture();
    const archive = join(root, "invalid.obhome");
    await exportHomeArchive(home.root, "portable", archive);
    const original = await readFile(archive);
    const badHeaders: Array<(document: HomeArchiveDocument) => void> = [
      (document) => { document.manifest.entries[0]!.path = "../outside"; },
      (document) => { document.manifest.entries[1]!.path = document.manifest.entries[0]!.path.toUpperCase(); },
      (document) => { document.manifest.entryCount += 1; },
      (document) => { document.manifest.entries.find((entry) => entry.type === "directory")!.path = "Projects/Bem-vindo.md/child"; },
    ];
    for (const change of badHeaders) {
      await writeFile(archive, replaceHeader(original, change));
      await expect(validateHomeArchive(archive, "portable")).rejects.toBeTruthy();
    }
    await writeFile(archive, original.subarray(0, original.length - 1));
    await expect(validateHomeArchive(archive, "portable")).rejects.toMatchObject({ code: "integrity_error" });
    expect(await readdir(store.stagingRoot)).toEqual([]);
    expect(await readFile(join(home.root, "Projects", "Bem-vindo.md"), "utf8")).toContain("Computador");
  });

  it("rejects oversized metadata, configured limits and invalid limits without output residues", async () => {
    const { root, home } = await fixture();
    const archive = join(root, "limits.obhome");
    for (const options of [{ maxBytes: -1 }, { maxEntries: 0 }, { maxBytes: 1 }, { maxEntries: 1 }]) {
      await expect(exportHomeArchive(home.root, "portable", archive, options)).rejects.toMatchObject({ code: "invalid_archive" });
      await expect(stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await exportHomeArchive(home.root, "portable", archive);
    await expect(validateHomeArchive(archive, "portable", { maxBytes: 1 })).rejects.toMatchObject({ code: "invalid_archive" });
    const bytes = await readFile(archive);
    bytes.writeUInt32LE(HOME_ARCHIVE_MAX_METADATA_BYTES + 1, bytes.indexOf(0) + 2);
    await writeFile(archive, bytes);
    await expect(validateHomeArchive(archive, "portable")).rejects.toMatchObject({ code: "invalid_archive" });
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("publishes without clobbering competing exports and preserves unrelated files on overwrite", async () => {
    const { root, home } = await fixture();
    const archive = join(root, "competing.json");
    const results = await Promise.allSettled([
      exportHomeArchive(home.root, "portable", archive),
      exportHomeArchive(home.root, "portable", archive),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    const validated = await validateHomeArchive(archive, "portable");
    expect(validated.version).toBe(2);
    // Existing v1 destinations remain eligible for an explicit overwrite.
    await writeFile(archive, JSON.stringify(await legacyDocument(home.root, validated.manifest)));
    await exportHomeArchive(home.root, "portable", archive, { overwrite: true });
    await expect(validateHomeArchive(archive, "portable")).resolves.toMatchObject({ version: 2 });
    const unrelated = join(root, "user.json");
    const sentinel = JSON.stringify({ note: "openbot-home-archive is not proof of an archive" });
    await writeFile(unrelated, sentinel);
    await expect(exportHomeArchive(home.root, "portable", unrelated, { overwrite: true })).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(unrelated, "utf8")).toBe(sentinel);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("does not materialize over an existing staging directory", async () => {
    const { root, home } = await fixture();
    const archive = join(root, "existing-stage.obhome");
    await exportHomeArchive(home.root, "portable", archive);
    const document = await validateHomeArchive(archive, "portable");
    const stage = join(root, "stage");
    await mkdir(stage);
    await writeFile(join(stage, "sentinel.txt"), "keep");
    await expect(materializeHomeArchive(document, stage)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(stage, "sentinel.txt"), "utf8")).toBe("keep");
  });
});
