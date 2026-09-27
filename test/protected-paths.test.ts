import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import { HomeWorkspaceBackend } from "../src/execution/home-backend.js";
import { PROTECTED_PATH_MESSAGE, ProtectedPaths } from "../src/execution/protected-paths.js";
import { AgentRuntimeBackend } from "../src/execution/runtime/agent-backend.js";
import type { AgentRuntimeManager } from "../src/execution/runtime/contracts.js";
import { inheritableEnvironment } from "../src/execution/runtime/local/environment.js";
import { classifyAgentPath, resolveBrowserUploadTarget } from "../src/execution/user-files.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();
afterEach(() => temp.cleanup());

/** state/ (OpenBot data), workspaces/ with two bot homes, and an unrelated outside/ folder. */
async function layout() {
  const root = await temp.makeAsync("openbot-protected-");
  const state = join(root, "state");
  await mkdir(state);
  await writeFile(join(state, "sand-secrets.json"), "needle-secret");
  await writeFile(join(state, "store.db-wal"), "needle-wal");
  const homes = await AgentHomeStore.create(join(root, "workspaces"));
  const own = await homes.ensure("bot-a");
  const other = await homes.ensure("bot-b");
  await writeFile(join(own.root, "Documents", "mine.txt"), "needle-own");
  await writeFile(join(other.root, "Documents", "theirs.txt"), "needle-other");
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "notes.txt"), "needle-outside");
  const protectedPaths = new ProtectedPaths({ directories: [state, homes.root], files: [join(root, "store.db")] });
  return { root, state, own, other, outside, homes, protectedPaths };
}

describe("ProtectedPaths", () => {
  it("covers directories, files with SQLite sidecars, case variants and aliases, but not the exempt home", async () => {
    const { root, state, own, other, outside, protectedPaths } = await layout();
    const scoped = protectedPaths.forHome(own.root);
    expect(scoped.blocks(join(state, "sand-secrets.json"))).toBe(true);
    expect(scoped.blocks(state.toUpperCase())).toBe(true);
    expect(scoped.blocks(join(root, "store.db"))).toBe(true);
    expect(scoped.blocks(join(root, "store.db-wal"))).toBe(true);
    expect(scoped.blocks(join(root, "store.dbx"))).toBe(false);
    expect(scoped.blocks(join(other.root, "Documents"))).toBe(true);
    expect(scoped.blocks(join(own.root, "Documents", "mine.txt"))).toBe(false);
    expect(scoped.blocks(join(outside, "notes.txt"))).toBe(false);
    expect(scoped.blocks(`${state}-sibling`)).toBe(false);
    expect(scoped.blocks(join(own.root, ".."))).toBe(true);
    expect(scoped.blocksDescent(join(own.root, ".."))).toBe(false);
    expect(scoped.blocksDescent(other.root)).toBe(true);

    const alias = join(outside, "state-alias");
    await symlink(state, alias, "junction");
    expect(scoped.blocks(alias)).toBe(false);
    expect(scoped.blocksResolved(alias)).toBe(true);
    expect(scoped.blocksResolved(join(alias, "not-created-yet", "planted.txt"))).toBe(true);
  });

  it("refuses an 8.3 short-name spelling of OpenBot data through the file tools", async () => {
    const { state, own, protectedPaths } = await layout();
    const short = execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${state}") do @echo %~sI`], { encoding: "utf8" }).trim();
    if (short.toLowerCase() === state.toLowerCase()) return expect(short).toBeTruthy();
    const backend = await HomeWorkspaceBackend.create(own.root, { agentId: "bot-a", protectedPaths });
    await expect(backend.execute({ operation: "file.read", path: join(short, "sand-secrets.json"), encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false });
    await expect(backend.execute({ operation: "file.write", path: join(short, "planted.txt"), content: "x", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false });
    await expect(readFile(join(state, "planted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("protected paths in the home backend", () => {
  it("refuses OpenBot data and sibling homes by absolute path while keeping the own home and the rest of the host", async () => {
    const { state, own, other, outside, protectedPaths } = await layout();
    const backend = await HomeWorkspaceBackend.create(own.root, { agentId: "bot-a", protectedPaths });
    const denied = { ok: false, code: "access_denied", message: PROTECTED_PATH_MESSAGE };

    await expect(backend.execute({ operation: "file.read", path: join(state, "sand-secrets.json"), encoding: "utf8" })).resolves.toMatchObject(denied);
    await expect(backend.execute({ operation: "file.list", path: state })).resolves.toMatchObject(denied);
    await expect(backend.execute({ operation: "file.read", path: join(other.root, "Documents", "theirs.txt"), encoding: "utf8" })).resolves.toMatchObject(denied);
    await expect(backend.execute({ operation: "file.write", path: join(state, "planted.txt"), content: "x", encoding: "utf8" })).resolves.toMatchObject(denied);
    await expect(backend.execute({ operation: "file.copy", source: join(outside, "notes.txt"), destination: join(state, "copied.txt") })).resolves.toMatchObject(denied);

    await expect(backend.execute({ operation: "file.read", path: join(own.root, "Documents", "mine.txt"), encoding: "utf8" })).resolves.toMatchObject({ ok: true });
    await expect(backend.execute({ operation: "file.read", path: join(outside, "notes.txt"), encoding: "utf8" })).resolves.toMatchObject({ ok: true });
  });

  it("skips protected subtrees when a search starts from a common ancestor", async () => {
    const { root, own, protectedPaths } = await layout();
    const backend = await HomeWorkspaceBackend.create(own.root, { agentId: "bot-a", protectedPaths });
    const found = await backend.execute({
      operation: "command.run",
      command: "search.text",
      cwd: ".",
      params: { pattern: "needle", mode: "fixed", paths: [root] },
    });
    expect(found).toMatchObject({ ok: true, operation: "command.run" });
    const stdout = found.ok && found.operation === "command.run" ? found.stdout : "";
    expect(stdout).toContain("needle-outside");
    expect(stdout).toContain("needle-own");
    expect(stdout).not.toContain("needle-secret");
    expect(stdout).not.toContain("needle-wal");
    expect(stdout).not.toContain("needle-other");
  });

  it("keeps protected paths when a shared:// cwd makes the request load per-operation mounts", async () => {
    const { root, state, own, other, protectedPaths } = await layout();
    const profile = join(root, "profile");
    await mkdir(join(profile, "Documents"), { recursive: true });
    const backend = await HomeWorkspaceBackend.create(own.root, { agentId: "bot-a", userProfile: profile, protectedPaths });
    for (const target of [state, other.root]) {
      const found = await backend.execute({
        operation: "command.run",
        command: "search.text",
        cwd: "shared://Documents",
        params: { pattern: "needle", mode: "fixed", paths: [target] },
      });
      expect(JSON.stringify(found)).not.toMatch(/needle-(?:secret|wal|other)/u);
      expect(found).toMatchObject({ ok: false });
    }
  });

  it("refuses searching or uploading the home's own .openbot through an absolute or relative path", async () => {
    const { own, protectedPaths } = await layout();
    const backend = await HomeWorkspaceBackend.create(own.root, { agentId: "bot-a", protectedPaths });
    const found = await backend.execute({
      operation: "command.run",
      command: "search.text",
      cwd: ".",
      params: { pattern: "bot-a", mode: "fixed", paths: [join(own.root, ".openbot")] },
    });
    expect(found).toMatchObject({ ok: false, code: "access_denied" });
    await expect(resolveBrowserUploadTarget(own.root, ".openbot/home.json", new Map())).rejects.toMatchObject({ code: "access_denied" });
    await expect(resolveBrowserUploadTarget(own.root, join(own.root, ".openbot", "home.json"), new Map())).rejects.toBeInstanceOf(Error);
    await expect(resolveBrowserUploadTarget(own.root, "Documents/mine.txt", new Map())).resolves.toMatchObject({ path: "Documents/mine.txt" });
  });

  it("refuses UNC paths that loop back to this machine or reach an administrative share", () => {
    for (const unc of [
      "\\\\localhost\\C$\\Users",
      "\\\\127.0.0.1\\share\\file.txt",
      "\\\\[::1]\\share\\file.txt",
      `\\\\${hostname()}\\share\\file.txt`,
      "\\\\fileserver\\ADMIN$\\x",
    ]) {
      expect(() => classifyAgentPath(unc), unc).toThrow(/network shares/u);
    }
    expect(classifyAgentPath("\\\\fileserver\\team\\notes.txt")).toMatchObject({ kind: "host", relative: "notes.txt" });
  });

  it("blocks loopback and administrative shares for process paths, and leaves remote shares unresolved", async () => {
    const { own, protectedPaths } = await layout();
    const scoped = protectedPaths.forHome(own.root);
    expect(scoped.blocksResolved("\\\\localhost\\C$\\Windows")).toBe(true);
    expect(scoped.blocksResolved("//127.0.0.1/share/tool.exe")).toBe(true);
    expect(scoped.blocksResolved(`\\\\${hostname()}\\public\\x`)).toBe(true);
    const started = Date.now();
    expect(scoped.blocksResolved("\\\\openbot-unreachable.invalid\\share\\tool.exe")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("protected paths for process_run", () => {
  const manager = (): AgentRuntimeManager => ({
    ensure: vi.fn(), acquire: vi.fn(), status: vi.fn(), stop: vi.fn(), repair: vi.fn(), close: vi.fn(),
  } as unknown as AgentRuntimeManager);

  it("refuses a protected cwd or executable before acquiring a runtime lease", async () => {
    const { state, other, own, protectedPaths } = await layout();
    const runtime = manager();
    const runner = { run: vi.fn() };
    const backend = await AgentRuntimeBackend.create({ agentId: "bot-a", homeRoot: own.root, manager: runtime, runner, protectedPaths });
    const run = (cwd: string, executable = "powershell.exe") => backend.execute({
      operation: "process.run", executable, argv: [], cwd, timeoutMs: 1_000, networkProfile: "host",
    });

    await expect(run(state)).resolves.toMatchObject({ ok: false, code: "access_denied", message: PROTECTED_PATH_MESSAGE });
    await expect(run(join(other.root, "Documents"))).resolves.toMatchObject({ ok: false, code: "access_denied" });
    await expect(run(".", join(state, "tool.exe"))).resolves.toMatchObject({ ok: false, code: "access_denied" });
    expect(runtime.acquire).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    await expect(readFile(join(state, "sand-secrets.json"), "utf8")).resolves.toBe("needle-secret");
  });
});

describe("inherited process environment", () => {
  it("withholds credentials and OpenBot/launcher plumbing but keeps ordinary variables", () => {
    const inherited = inheritableEnvironment({
      PATH: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      SSH_AUTH_SOCK: "\\\\.\\pipe\\openssh-ssh-agent",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_secret",
      DB_PASSWORD: "hunter2",
      AWS_SECRET_ACCESS_KEY: "aws",
      SAND_HOST_GATEWAY_TOKEN: "gateway",
      SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1340",
      OPENBOT_DATA_ROOT: "C:\\data",
    });
    expect(inherited).toEqual({ PATH: "C:\\Windows", SystemRoot: "C:\\Windows", SSH_AUTH_SOCK: "\\\\.\\pipe\\openssh-ssh-agent" });
  });
});
