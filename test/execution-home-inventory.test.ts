import { createHash } from "node:crypto";
import { mkdir, open, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inventoryHome, validateHomeTree } from "../src/execution/home-inventory.js";
import { TempRoots } from "./helpers/temp-roots.js";

const tempRoots = new TempRoots();
afterEach(async () => {
  await tempRoots.cleanup();
});

const temp = async (): Promise<string> => {
  const root = await tempRoots.makeAsync("openbot-home-inventory-");
  return root;
};

describe("inventoryHome", () => {
  it("para no arquivo acima do orçamento sem abrir seu conteúdo e marca o inventário incompleto", async () => {
    const root = await temp();
    const file = join(root, "large.bin");
    await writeFile(file, Buffer.alloc(64));
    const probe = await open(file, "r");
    const read = vi.spyOn(Object.getPrototypeOf(probe), "read");
    try {
      await expect(inventoryHome(root, "agent-a", 100, 16)).resolves.toMatchObject({ files: 0, bytes: 0, entries: [], complete: false });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      await probe.close();
    }
  });

  it("calcula o hash em blocos e preserva a saída para arquivos pequenos", async () => {
    const root = await temp();
    const content = Buffer.from("inventory-content");
    await writeFile(join(root, "small.txt"), content);

    const inventory = await inventoryHome(root, "agent-a");
    expect(inventory).toMatchObject({ agentId: "agent-a", files: 1, bytes: content.byteLength, complete: true });
    expect(inventory.entries).toContainEqual({
      path: "small.txt",
      type: "file",
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  });

  it("não registra hash de arquivo alterado durante o streaming e marca o inventário incompleto", async () => {
    const root = await temp();
    const file = join(root, "changing.bin");
    await writeFile(file, Buffer.alloc(128 * 1024, 1));
    const probe = await open(file, "r");
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    const originalRead = prototype.read;
    let changed = false;
    const invokeRead = originalRead as unknown as (this: typeof probe, ...args: unknown[]) => Promise<{ bytesRead: number }>;
    const read = vi.spyOn(prototype, "read").mockImplementation((async function (this: typeof probe, ...args: unknown[]) {
      const result = await invokeRead.apply(this, args);
      if (!changed) {
        changed = true;
        await writeFile(file, Buffer.alloc(128 * 1024, 2));
      }
      return result;
    }) as unknown as typeof prototype.read);
    try {
      await expect(inventoryHome(root, "agent-a")).resolves.toMatchObject({ files: 0, entries: [], complete: false });
    } finally {
      read.mockRestore();
      await probe.close();
    }
    await expect(readFile(file)).resolves.toEqual(Buffer.alloc(128 * 1024, 2));
  });

  it("trata junctions como opacas: não segue, não lista e não recusa a home", async () => {
    const root = await temp();
    const outside = await temp();
    await writeFile(join(outside, "outside.txt"), "fora");
    await mkdir(join(root, "Projects"));
    await writeFile(join(root, "Projects", "own.txt"), "dentro");
    await symlink(outside, join(root, "Projects", "node_modules"), "junction");
    await expect(validateHomeTree(root)).resolves.toBeUndefined();
    const inventory = await inventoryHome(root, "agent-a");
    expect(inventory.entries.map((entry) => entry.path)).toEqual(["Projects", "Projects/own.txt"]);
    expect(inventory.complete).toBe(false);
  });

  it("interrompe antes de enumerar quando o sinal já foi cancelado", async () => {
    const root = await temp();
    await writeFile(join(root, "small.txt"), "x");
    const controller = new AbortController();
    controller.abort();
    await expect(inventoryHome(root, "agent-a", 100, 100, controller.signal)).rejects.toMatchObject({ code: "io_error" });
  });
});
