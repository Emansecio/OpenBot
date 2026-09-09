import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});

import * as fsp from "node:fs/promises";
import { renameOrCopy } from "../src/execution/safe-tree.js";

const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fsp.rename).mockImplementation(actual.rename);
  vi.mocked(fsp.rm).mockImplementation(actual.rm);
  await Promise.all(roots.splice(0).map((entry) => actual.rm(entry, { recursive: true, force: true })));
});

describe("renameOrCopy", () => {
  it("keeps the destination copy when EXDEV source removal fails", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "openbot-exdev-"));
    roots.push(root);
    const source = join(root, "source.txt");
    const destination = join(root, "dest.txt");
    await writeFile(source, "payload-bytes");

    vi.mocked(fsp.rename).mockImplementationOnce(async () => {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    });
    vi.mocked(fsp.rm).mockImplementation(async (target, options) => {
      if (String(target) === source) {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      return actual.rm(target, options);
    });

    await expect(renameOrCopy(source, destination)).rejects.toMatchObject({
      name: "SafeTreeError",
      code: "io_error",
    });
    await expect(readFile(destination, "utf8")).resolves.toBe("payload-bytes");
    await expect(readFile(source, "utf8")).resolves.toBe("payload-bytes");
  });
});
