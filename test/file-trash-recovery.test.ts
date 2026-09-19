import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn<typeof actual.lstat>(actual.lstat),
    rename: vi.fn<typeof actual.rename>(actual.rename),
  };
});

import * as fsp from "node:fs/promises";
import { LocalFileExecutor } from "../src/execution/files.js";
import { WorkspaceQuota, calculateWorkspaceUsage } from "../src/execution/quota.js";
import { WorkspaceSandbox } from "../src/execution/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fsp.lstat).mockImplementation(actual.lstat);
  vi.mocked(fsp.rename).mockImplementation(actual.rename);
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
});

describe("file trash recovery", () => {
  it("preserva payload e metadados quando o rollback do rename falha", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "openbot-trash-recovery-"));
    roots.push(root);
    const source = join(root, "source.txt");
    await writeFile(source, "recoverable payload");
    const workspace = await WorkspaceSandbox.create(root);
    const quota = new WorkspaceQuota(workspace, { maxBytes: 1024, maxFiles: 10, maxEntries: 20 });
    const executor = LocalFileExecutor.fromWorkspace(workspace, quota);

    let renameCalls = 0;
    let failPayloadValidation = true;
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      renameCalls += 1;
      if (renameCalls === 2) throw Object.assign(new Error("rollback unavailable"), { code: "EIO" });
      return actual.rename(from, to);
    });
    vi.mocked(fsp.lstat).mockImplementation((filename) => {
      if (failPayloadValidation && /[\\/]payload$/iu.test(String(filename))) {
        failPayloadValidation = false;
        throw Object.assign(new Error("post-rename verification failed"), { code: "EIO" });
      }
      return actual.lstat(filename);
    });

    const failedTrash = await executor.execute({ operation: "file.trash", path: "source.txt" });
    expect(failedTrash).toMatchObject({ ok: false, code: "io_error" });
    if (failedTrash.ok) throw new Error("trash unexpectedly succeeded");
    expect(failedTrash.message).toMatch(/rollback was not confirmed/iu);
    const trashId = failedTrash.message.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu)?.[0];
    if (!trashId) throw new Error("trash id missing from recovery message");

    const trashRoot = join(root, ".openbot", "trash");
    const entry = join(trashRoot, trashId);
    await expect(readFile(join(entry, "payload"), "utf8")).resolves.toBe("recoverable payload");
    await expect(readFile(join(entry, "meta.json"), "utf8")).resolves.toBe(
      JSON.stringify({ version: 1, path: "source.txt" }),
    );
    await expect(readFile(source, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(quota.usage()).resolves.toEqual(await calculateWorkspaceUsage(root));

    vi.mocked(fsp.lstat).mockImplementation(actual.lstat);
    vi.mocked(fsp.rename).mockImplementation(actual.rename);
    await expect(executor.execute({ operation: "file.restore", trashId }))
      .resolves.toEqual({ ok: true, operation: "file.restore", path: "source.txt" });
    await expect(readFile(source, "utf8")).resolves.toBe("recoverable payload");
    await expect(readFile(join(entry, "payload"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(quota.usage()).resolves.toEqual(await calculateWorkspaceUsage(root));
  });
});
