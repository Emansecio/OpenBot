import * as fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", { spy: true });

// @ts-expect-error executable local helper has no declaration file.
import { atomicWriteFile } from "../scripts/release-common.mjs";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release atomic state publication", () => {
  it("preserva a versão anterior quando o retry do rename falha", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-atomic-write-recovery-"));
    roots.push(root);
    const destination = join(root, "state.json");
    await writeFile(destination, "previous state\n", "utf8");

    const rename = vi.spyOn(fs.promises, "rename");
    rename.mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EPERM" }));
    rename.mockRejectedValueOnce(Object.assign(new Error("persistent I/O failure"), { code: "EIO" }));

    await expect(atomicWriteFile(destination, "new state\n")).rejects.toMatchObject({ code: "EIO" });
    expect(rename).toHaveBeenCalledTimes(2);
    await expect(readFile(destination, "utf8")).resolves.toBe("previous state\n");
    await expect(readdir(root)).resolves.toEqual(["state.json"]);
  });

  it("publica a nova versão quando o retry tem sucesso", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-atomic-write-retry-"));
    roots.push(root);
    const destination = join(root, "state.json");
    await writeFile(destination, "previous state\n", "utf8");

    const actualRename = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, "rename");
    rename.mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EPERM" }));
    rename.mockImplementationOnce(actualRename);

    await expect(atomicWriteFile(destination, "new state\n")).resolves.toBeUndefined();
    await expect(readFile(destination, "utf8")).resolves.toBe("new state\n");
    await expect(readdir(root)).resolves.toEqual(["state.json"]);
  });
});
