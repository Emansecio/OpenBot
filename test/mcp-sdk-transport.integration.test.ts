import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it, vi } from "vitest";
import { McpManager } from "../src/mcp/manager.js";

const fixturePath = resolve(fileURLToPath(new URL("./fixtures/mcp-real-server.mjs", import.meta.url)));
const fixtureRoot = resolve(dirname(fixturePath), "..", "..");
const nodeCommand = process.execPath;

const stagedDirectories = async (): Promise<string[]> => (await readdir(tmpdir(), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("openbot-mcp-stdio-"))
  .map((entry) => join(tmpdir(), entry.name));

const stagedWorkingDirectories = async (): Promise<string[]> => (await readdir(tmpdir(), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("openbot-mcp-cwd-"))
  .map((entry) => join(tmpdir(), entry.name));

const waitForExit = (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
};

const replaceWithJunction = async (source: string, target: string): Promise<() => Promise<void>> => {
  const backup = `${source}.original`;
  await rename(source, backup);
  try {
    await symlink(target, source, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await rename(backup, source).catch(() => {});
    throw error;
  }
  return async () => {
    await rm(source, { recursive: true, force: true });
    await rename(backup, source);
  };
};

const stdioManager = (serverId: string, mode: "stdio" | "http", url?: string) => new McpManager({
  servers: [mode === "stdio"
    ? { id: serverId, transport: "stdio", command: nodeCommand, args: [fixturePath, mode], cwd: fixtureRoot }
    : { id: serverId, transport: "http", url: url! }],
  policies: { bot: { enabled: true, serverAllowlist: [serverId] } },
  stdioApprovedCwdRoots: [fixtureRoot],
  timeoutMs: 10_000,
});

const assertEcho = async (manager: McpManager, serverId: string, value: string) => {
  const tools = await manager.listProviderTools("bot");
  expect(tools.map((tool) => tool.function.name)).toEqual([`mcp__${serverId}__echo`]);
  const result = await manager.callProviderTool("bot", `mcp__${serverId}__echo`, { value });
  expect(result).toMatchObject({ content: [{ type: "text", text: `echo:${value}` }] });
};

describe("MCP SDK transport integration", () => {
  it("uses the official stdio client and server transports for listTools and callTool", async () => {
    const manager = stdioManager("stdio_fixture", "stdio");
    try {
      await assertEcho(manager, "stdio_fixture", "stdio-ok");
    } finally {
      await manager.close();
    }
  });

  it("waits for an aborted stdio handshake cleanup before manager.close resolves", async () => {
    const before = new Set(await stagedDirectories());
    const workingBefore = new Set(await stagedWorkingDirectories());
    const manager = stdioManager("stdio_abort_cleanup", "stdio");
    const abort = new AbortController();
    let handshakeStarted!: () => void;
    const handshakeStartedPromise = new Promise<void>((resolveStarted) => { handshakeStarted = resolveStarted; });
    let releaseHandshake!: () => void;
    const handshakeGate = new Promise<void>((resolveHandshake) => { releaseHandshake = resolveHandshake; });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolveClose) => { releaseClose = resolveClose; });
    const startSpy = vi.spyOn(StdioClientTransport.prototype, "start").mockImplementation(async function () {
      handshakeStarted();
      await handshakeGate;
      throw new Error("handshake gate");
    });
    const closeSpy = vi.spyOn(StdioClientTransport.prototype, "close").mockImplementation(async function () {
      await closeGate;
    });
    try {
      const listing = manager.listProviderTools("bot", { signal: abort.signal });
      await handshakeStartedPromise;
      const created = (await stagedDirectories()).filter((directory) => !before.has(directory));
      expect(created).toHaveLength(1);
      expect((await stagedWorkingDirectories()).filter((directory) => !workingBefore.has(directory))).toHaveLength(0);

      abort.abort();
      const rejected = expect(listing).rejects.toThrow();
      releaseHandshake();
      await rejected;

      let managerClosed = false;
      const closing = manager.close().then(() => { managerClosed = true; });
      await Promise.resolve();
      expect(managerClosed).toBe(false);
      expect(await stagedDirectories()).toContain(created[0]);
      expect((await stagedWorkingDirectories()).filter((directory) => !workingBefore.has(directory))).toHaveLength(0);

      releaseClose();
      await closing;
      expect(await stagedDirectories()).not.toContain(created[0]);
      expect((await stagedWorkingDirectories()).filter((directory) => !workingBefore.has(directory))).toHaveLength(0);
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      releaseHandshake();
      releaseClose();
      await manager.close();
      startSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it("fails closed when a junction swaps the cwd before the synchronous launch boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot mcp cwd race "));
    const outside = await mkdtemp(join(tmpdir(), "openbot mcp cwd outside "));
    const cwd = join(root, "cwd");
    await mkdir(cwd);
    let releaseSecret!: () => void;
    let secretStarted!: () => void;
    const secretGate = new Promise<void>((resolveGate) => { releaseSecret = resolveGate; });
    const secretStartedPromise = new Promise<void>((resolveStarted) => { secretStarted = resolveStarted; });
    const manager = new McpManager({
      servers: [{
        id: "cwd_race",
        transport: "stdio",
        command: nodeCommand,
        args: [fixturePath],
        cwd,
        env: { TOKEN: { secretRef: "test/gate" } },
      }],
      policies: { bot: { enabled: true, serverAllowlist: ["cwd_race"] } },
      stdioApprovedCwdRoots: [root],
      secretResolver: async () => {
        secretStarted();
        await secretGate;
        return "test-secret";
      },
      timeoutMs: 10_000,
    });
    let restoreSource: (() => Promise<void>) | undefined;
    try {
      const listing = manager.listProviderTools("bot");
      await secretStartedPromise;
      restoreSource = await replaceWithJunction(cwd, outside);
      releaseSecret();
      await expect(listing).rejects.toThrow(/cwd changed after validation/iu);
      expect(await stagedWorkingDirectories()).toHaveLength(0);
    } finally {
      releaseSecret();
      await manager.close();
      await restoreSource?.();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      expect(await stagedWorkingDirectories()).toHaveLength(0);
    }
  });

  it("connects with a spaced original cwd and keeps legitimate server writes visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot mcp cwd spaces "));
    const cwd = join(root, "cwd with spaces");
    await mkdir(cwd);
    const serverPath = join(fixtureRoot, "test", `mcp-cwd-write-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
    await writeFile(serverPath, `
import { readFile, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "cwd-write-fixture", version: "1.0.0" });
server.registerTool("write-cwd", { description: "write through the original cwd" }, async () => {
  await writeFile("server-write.txt", "written", "utf8");
  return { content: [{ type: "text", text: await readFile("server-write.txt", "utf8") }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);
process.stdin.once("end", () => void Promise.allSettled([server.close(), transport.close()]).finally(() => process.exit(0)));
`, "utf8");
    const manager = new McpManager({
      servers: [{ id: "cwd_write", transport: "stdio", command: nodeCommand, args: [serverPath], cwd }],
      policies: { bot: { enabled: true, serverAllowlist: ["cwd_write"] } },
      stdioApprovedCwdRoots: [root],
      timeoutMs: 10_000,
    });
    try {
      expect(await stagedWorkingDirectories()).toHaveLength(0);
      await expect(manager.listProviderTools("bot")).resolves.toEqual([
        expect.objectContaining({ serverId: "cwd_write", function: expect.objectContaining({ name: "mcp__cwd_write__write-cwd" }) }),
      ]);
      await expect(manager.callProviderTool("bot", "mcp__cwd_write__write-cwd", {})).resolves.toMatchObject({
        content: [{ type: "text", text: "written" }],
      });
      await expect(readFile(join(cwd, "server-write.txt"), "utf8")).resolves.toBe("written");
      expect(await stagedWorkingDirectories()).toHaveLength(0);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
      await rm(serverPath, { force: true });
      expect(await stagedWorkingDirectories()).toHaveLength(0);
    }
  });

  it("uses the official Streamable HTTP client and server transports over loopback", async () => {
    const child = spawn(nodeCommand, [fixturePath, "http"], {
      cwd: fixtureRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    try {
      const port = await new Promise<number>((resolvePort, reject) => {
        const timeout = setTimeout(() => reject(new Error(`HTTP fixture did not announce a port${stderr ? `: ${stderr}` : ""}`)), 5_000);
        lines.once("line", (line) => {
          clearTimeout(timeout);
          const match = /^PORT (\d+)$/u.exec(line);
          if (match === null) reject(new Error(`invalid HTTP fixture announcement: ${line}`));
          else resolvePort(Number(match[1]));
        });
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`HTTP fixture exited before startup (${code ?? "signal"})${stderr ? `: ${stderr}` : ""}`));
        });
      });
      const manager = stdioManager("http_fixture", "http", `http://127.0.0.1:${port}/mcp`);
      try {
        await assertEcho(manager, "http_fixture", "http-ok");
      } finally {
        await manager.close();
      }
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await waitForExit(child);
    }
  });
});
