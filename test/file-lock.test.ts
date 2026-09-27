import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withFileLock, withFileLockSync } from "../src/shared/file-lock.js";

const roots: string[] = [];

function target(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-file-lock-"));
  roots.push(dir);
  return join(dir, "state.json");
}

/** Makes a lock file look `ageMs` old. */
function age(file: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("withFileLockSync", () => {
  it("runs the task, returns its value and removes the lock", () => {
    const file = target();
    expect(withFileLockSync(file, () => 42)).toBe(42);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("reclaims a lock whose owner process is gone", () => {
    const file = target();
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2 ** 30, token: "dead-owner" }));
    expect(withFileLockSync(file, () => "ok", { timeoutMs: 200 })).toBe("ok");
  });

  it("reclaims an old lock even when its PID is alive (PID reuse, failed release)", () => {
    const file = target();
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "stale-token" }));
    age(`${file}.lock`, 10_000);
    expect(withFileLockSync(file, () => "ok", { timeoutMs: 500, staleMs: 1_000 })).toBe("ok");
  });

  it("waits for a fresh lock held by a live owner and times out with a labelled error", () => {
    const file = target();
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "live-token" }));
    expect(() => withFileLockSync(file, () => "never", { timeoutMs: 50, staleMs: 60_000, label: "config" }))
      .toThrow(/^config: timeout aguardando lock/);
    expect(JSON.parse(readFileSync(`${file}.lock`, "utf8"))).toMatchObject({ token: "live-token" });
  });

  it("reclaims an unreadable lock only after it becomes stale", () => {
    const file = target();
    writeFileSync(`${file}.lock`, "{torn");
    expect(() => withFileLockSync(file, () => "never", { timeoutMs: 30, staleMs: 60_000 })).toThrow(/timeout/);
    age(`${file}.lock`, 120_000);
    expect(withFileLockSync(file, () => "ok", { timeoutMs: 200, staleMs: 60_000 })).toBe("ok");
  });

  it("keeps the task outcome when the lock was replaced by another owner", () => {
    const file = target();
    const result = withFileLockSync(file, () => {
      // Another process reclaimed the lock: release must not remove its lock.
      writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "other-owner" }));
      return "committed";
    });
    expect(result).toBe("committed");
    expect(JSON.parse(readFileSync(`${file}.lock`, "utf8"))).toMatchObject({ token: "other-owner" });
  });
});

describe("withFileLock", () => {
  it("serializes concurrent tasks", async () => {
    const file = target();
    const order: string[] = [];
    const run = (name: string) => withFileLock(file, async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`${name}:end`);
    });
    await Promise.all([run("a"), run("b")]);
    expect(order).toEqual(order[0] === "a:start"
      ? ["a:start", "a:end", "b:start", "b:end"]
      : ["b:start", "b:end", "a:start", "a:end"]);
  });

  it("reclaims an old lock with a live PID", async () => {
    const file = target();
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "stale-token" }));
    age(`${file}.lock`, 10_000);
    await expect(withFileLock(file, async () => "ok", { timeoutMs: 500, staleMs: 1_000 })).resolves.toBe("ok");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("propagates the task error and still releases the lock", async () => {
    const file = target();
    await expect(withFileLock(file, async () => { throw new Error("task failed"); })).rejects.toThrow("task failed");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});
