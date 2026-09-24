import { describe, expect, it } from "vitest";

import { renameWithRetry, renameWithRetrySync } from "../src/shared/fs-atomic.js";

const failure = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });

describe("renameWithRetry", () => {
  it("repete bloqueios transitórios do Windows até o rename concluir", async () => {
    const codes = ["EPERM", "EBUSY", "EACCES"];
    const calls: string[] = [];
    await renameWithRetry("a", "b", {
      platform: "win32",
      rename: async (from, to) => {
        calls.push(`${from}->${to}`);
        const code = codes.shift();
        if (code !== undefined) throw failure(code);
      },
    });
    expect(calls).toHaveLength(4);
  });

  it("propaga imediatamente erros não transitórios", async () => {
    let calls = 0;
    await expect(renameWithRetry("a", "b", {
      platform: "win32",
      rename: async () => { calls += 1; throw failure("ENOENT"); },
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("desiste após o limite e mantém o erro original", async () => {
    let calls = 0;
    await expect(renameWithRetry("a", "b", {
      platform: "win32",
      rename: async () => { calls += 1; throw failure("EPERM"); },
    })).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(6);
  });

  it("não repete fora do Windows", async () => {
    let calls = 0;
    await expect(renameWithRetry("a", "b", {
      platform: "linux",
      rename: async () => { calls += 1; throw failure("EPERM"); },
    })).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(1);
  });

  it("variante síncrona repete bloqueios transitórios e respeita o limite", () => {
    let calls = 0;
    renameWithRetrySync("a", "b", {
      platform: "win32",
      rename: () => { calls += 1; if (calls < 3) throw failure("EBUSY"); },
    });
    expect(calls).toBe(3);

    calls = 0;
    expect(() => renameWithRetrySync("a", "b", {
      platform: "win32",
      rename: () => { calls += 1; throw failure("EPERM"); },
    })).toThrow("fixture EPERM");
    expect(calls).toBe(6);
  });
});
