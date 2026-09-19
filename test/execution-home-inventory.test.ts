import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inventoryHome } from "../src/execution/home-inventory.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temp = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "openbot-home-inventory-"));
  roots.push(root);
  return root;
};

describe("inventoryHome", () => {
  it("recusa arquivo acima do orçamento antes de abrir seu conteúdo", async () => {
    const root = await temp();
    const file = join(root, "large.bin");
    await writeFile(file, Buffer.alloc(64));
    const probe = await open(file, "r");
    const read = vi.spyOn(Object.getPrototypeOf(probe), "read");
    try {
      await expect(inventoryHome(root, "agent-a", 100, 16)).rejects.toMatchObject({ code: "invalid_archive" });
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

  it("rejeita mutação detectada durante o streaming do hash", async () => {
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
      await expect(inventoryHome(root, "agent-a")).rejects.toMatchObject({ code: "io_error" });
    } finally {
      read.mockRestore();
      await probe.close();
    }
    await expect(readFile(file)).resolves.toEqual(Buffer.alloc(128 * 1024, 2));
  });

  it("interrompe antes de enumerar quando o sinal já foi cancelado", async () => {
    const root = await temp();
    await writeFile(join(root, "small.txt"), "x");
    const controller = new AbortController();
    controller.abort();
    await expect(inventoryHome(root, "agent-a", 100, 100, controller.signal)).rejects.toMatchObject({ code: "io_error" });
  });
});
