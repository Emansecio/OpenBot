import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
  calls: [] as Array<{ executable: string; argv: readonly string[]; options: Record<string, unknown> }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: ((executable: string, argv: readonly string[], options: Record<string, unknown>) => {
      spawnState.calls.push({ executable, argv: [...argv], options });
      return (original.spawn as (...args: any[]) => unknown)(executable, argv, options);
    }) as typeof original.spawn,
  };
});

import { MAX_WHATSAPP_OUTPUT_BYTES, type ExecutionRequest } from "../src/execution/contracts.js";
import { WhatsappHostBackend, composeWhatsappHostBackend, defaultWacliPath, hostWhatsappEnv, hostWhatsappPath, spawnWhatsappProcess } from "../src/host/whatsapp.js";

const tempRoots: string[] = [];

afterEach(() => {
  spawnState.calls.splice(0);
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WhatsappHostBackend", () => {
  it("returns a clear error when the host CLI is missing", async () => {
    const backend = new WhatsappHostBackend({
      wacliPath: join(tmpdir(), "missing-wacli.exe"),
      scriptsDir: join(tmpdir(), "missing-scripts"),
    });
    await expect(backend.execute({ operation: "whatsapp", op: "doctor" })).resolves.toMatchObject({
      ok: false,
      operation: "whatsapp",
      code: "not_found",
    });
  });

  it("passes the exact doctor spec to the injected runner and disables the host shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-wacli-"));
    tempRoots.push(dir);
    const exe = join(dir, "wacli.exe");
    writeFileSync(exe, "stub");
    const seen: string[][] = [];
    const backend = new WhatsappHostBackend({
      wacliPath: exe,
      scriptsDir: dir,
      runner: {
        async run(spec) {
          seen.push([spec.executable, ...spec.argv]);
          return { stdout: "{\"ok\":true}", stderr: "", exitCode: 0, durationMs: 4, outputLimitExceeded: false };
        },
      },
    });
    await expect(backend.execute({ operation: "whatsapp", op: "doctor" })).resolves.toMatchObject({
      ok: true,
      operation: "whatsapp",
      op: "doctor",
      stdout: "{\"ok\":true}",
      exitCode: 0,
    });
    expect(seen).toEqual([[exe, "doctor", "--read-only", "--json"]]);
    await expect(spawnWhatsappProcess({
      executable: process.execPath,
      argv: ["-e", "process.stdout.write('host-runner-ok')"],
      cwd: dir,
      timeoutMs: 2_000,
    })).resolves.toMatchObject({ stdout: "host-runner-ok", stderr: "", exitCode: 0 });
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0]).toMatchObject({
      executable: process.execPath,
      argv: ["-e", "process.stdout.write('host-runner-ok')"],
      options: { cwd: dir, windowsHide: true, shell: false },
    });
    expect(hostWhatsappPath(exe, "C:\\\\Windows")).toMatch(/wacli/i);
    const env = hostWhatsappEnv(exe);
    expect(env.PATH).toMatch(/wacli/i);
    expect(env.SYSTEMROOT || env.SystemRoot).toBeTruthy();
    expect(env.PATHEXT).toMatch(/EXE/i);
    expect(env.TEMP || env.TMP).toBeTruthy();
    for (const key of ["SYSTEMROOT", "SystemRoot", "WINDIR", "PATHEXT", "TEMP"]) {
      if (process.env[key]) expect(env[key]).toBe(process.env[key]);
    }
  });

  it("stops a host process when stdout exceeds the byte limit", async () => {
    const result = await spawnWhatsappProcess({
      executable: process.execPath,
      argv: ["-e", `process.stdout.write(Buffer.alloc(${MAX_WHATSAPP_OUTPUT_BYTES + 1}, 120))`],
      cwd: tmpdir(),
      timeoutMs: 2_000,
    });

    expect(result.outputLimitExceeded).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MAX_WHATSAPP_OUTPUT_BYTES);
  });

  it("stops a host process when stderr exceeds the byte limit", async () => {
    const result = await spawnWhatsappProcess({
      executable: process.execPath,
      argv: ["-e", `process.stderr.write(Buffer.alloc(${MAX_WHATSAPP_OUTPUT_BYTES + 1}, 120))`],
      cwd: tmpdir(),
      timeoutMs: 2_000,
    });

    expect(result.outputLimitExceeded).toBe(true);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(MAX_WHATSAPP_OUTPUT_BYTES);
  });

  it("maps runner output overflow to the stable output_limit error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbot-wacli-limit-"));
    tempRoots.push(dir);
    const exe = join(dir, "wacli.exe");
    writeFileSync(exe, "stub");
    const backend = new WhatsappHostBackend({
      wacliPath: exe,
      scriptsDir: dir,
      runner: {
        async run() {
          return { stdout: "", stderr: "", exitCode: null, durationMs: 1, outputLimitExceeded: true };
        },
      },
    });

    await expect(backend.execute({ operation: "whatsapp", op: "doctor" })).resolves.toMatchObject({
      ok: false,
      operation: "whatsapp",
      code: "output_limit",
    });
  });

  it("delegates non-whatsapp requests", async () => {
    const calls: ExecutionRequest[] = [];
    const composed = composeWhatsappHostBackend({
      async execute(request) {
        calls.push(request);
        return { ok: true, operation: "file.list", entries: [] };
      },
    }, new WhatsappHostBackend({ wacliPath: join(tmpdir(), "missing-wacli.exe") }));
    await expect(composed.execute({ operation: "file.list", path: "." })).resolves.toMatchObject({ operation: "file.list" });
    expect(calls).toEqual([{ operation: "file.list", path: "." }]);
  });

  it.skipIf(!existsSync(defaultWacliPath()))("live doctor talks to the installed host CLI", async () => {
    const backend = new WhatsappHostBackend();
    const result = await backend.execute({ operation: "whatsapp", op: "doctor" });
    expect(result.operation).toBe("whatsapp");
    if (result.ok) {
      expect(result).toMatchObject({ op: "doctor", exitCode: 0, durationMs: expect.any(Number) });
    } else {
      expect(result.code).not.toBe("not_found");
      expect(["io_error", "timed_out"]).toContain(result.code);
    }
  });
});
