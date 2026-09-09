import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  McpSecurityError,
  resolveAndValidateHttpEndpoint,
  stageValidatedStdioExecutable,
  validateHttpUrl,
  validateStdioConfig,
} from "../src/mcp/security.js";
import type { McpHttpServerConfig, McpStdioServerConfig } from "../src/mcp/contracts.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openbot-mcp-"));
  tempRoots.push(root);
  return root;
}

describe("MCP security", () => {
  it("rejects credentials and insecure remote HTTP", async () => {
    expect(() => validateHttpUrl("https://user:pass@example.com/mcp")).toThrow(McpSecurityError);
    expect(() => validateHttpUrl("http://example.com/mcp")).toThrow(McpSecurityError);

    const remote: McpHttpServerConfig = { id: "remote", transport: "http", url: "https://example.com/mcp" };
    await expect(resolveAndValidateHttpEndpoint(remote.url, async () => ["93.184.216.34", "192.168.1.10"])).rejects.toThrow(McpSecurityError);
  });

  it("allows loopback HTTP but rejects metadata, link-local, multicast and private addresses", async () => {
    await expect(resolveAndValidateHttpEndpoint("http://127.0.0.1:8787/mcp", async () => ["127.0.0.1"])).resolves.toBeDefined();
    await expect(resolveAndValidateHttpEndpoint("http://localhost:8787/mcp", async () => ["::1"])).resolves.toBeDefined();
    for (const address of ["169.254.169.254", "169.254.170.2", "224.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "fc00::1", "fe80::1"]) {
      await expect(resolveAndValidateHttpEndpoint("https://example.com/mcp", async () => [address])).rejects.toThrow(McpSecurityError);
    }
  });

  it("requires stdio command policy and an approved real cwd", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "cwd");
    await mkdir(cwd);
    const valid: McpStdioServerConfig = {
      id: "local",
      transport: "stdio",
      command: "node",
      args: ["server.mjs", "literal && not shell"],
      cwd,
      env: { TOKEN: { secretRef: "mcp/local/token" } },
    };
    await expect(validateStdioConfig(valid, { approvedCwdRoots: [root], allowedCommands: ["node"] })).resolves.toMatchObject({ cwd, command: process.execPath });
    await expect(validateStdioConfig({ ...valid, command: "powershell.exe" }, { approvedCwdRoots: [root], allowedCommands: ["powershell.exe"] })).rejects.toThrow(McpSecurityError);
    await expect(validateStdioConfig({ ...valid, cwd: os.tmpdir() }, { approvedCwdRoots: [root], allowedCommands: ["node"] })).rejects.toThrow(McpSecurityError);
    await expect(validateStdioConfig({ ...valid, args: ["a\0b"] }, { approvedCwdRoots: [root], allowedCommands: ["node"] })).rejects.toThrow(McpSecurityError);
  });

  it("does not let a relative path or arbitrary absolute executable bypass the command allowlist", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "cwd");
    await mkdir(cwd);
    const named: McpStdioServerConfig = { id: "named", transport: "stdio", command: "./node", cwd };
    await expect(validateStdioConfig(named, { approvedCwdRoots: [root], allowedCommands: ["node"] })).rejects.toThrow(McpSecurityError);

    const arbitrary = { ...named, id: "absolute", command: path.join(root, "node.exe") };
    await expect(validateStdioConfig(arbitrary, { approvedCwdRoots: [root], allowedCommands: ["node"] })).rejects.toThrow(McpSecurityError);
    await expect(validateStdioConfig({ ...arbitrary, command: process.execPath }, {
      approvedCwdRoots: [root],
      allowedCommands: [process.execPath],
    })).resolves.toMatchObject({ cwd });
  });

  it("does not accept inline secret values in server configuration", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "cwd");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "server.mjs"), "", "utf8");
    await expect(validateStdioConfig({
      id: "local",
      transport: "stdio",
      command: "node",
      cwd,
      env: { TOKEN: "inline-secret" as never },
    }, { approvedCwdRoots: [root], allowedCommands: ["node"] })).rejects.toThrow(McpSecurityError);
  });

  it("rejects bare non-Node command names unless an exact executable path is approved", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "cwd");
    await mkdir(cwd);
    const named: McpStdioServerConfig = { id: "named", transport: "stdio", command: "python", cwd };
    await expect(validateStdioConfig(named, { approvedCwdRoots: [root], allowedCommands: ["python"] })).rejects.toThrow(McpSecurityError);
  });

  it("rejects an approved-looking executable symlink whose real target is blocked", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "cwd");
    await mkdir(cwd);
    const blocked = path.join(root, "powershell.exe");
    const approved = path.join(root, "approved-tool.exe");
    await writeFile(blocked, "blocked target", "utf8");
    await symlink(blocked, approved, "file");

    await expect(validateStdioConfig({
      id: "symlink-blocked",
      transport: "stdio",
      command: approved,
      cwd,
    }, { approvedCwdRoots: [root], allowedCommands: [approved] })).rejects.toThrow(McpSecurityError);
  });

  it("executes a private Node snapshot when its approved alias is swapped after validation", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "cwd");
    await mkdir(cwd);
    const alias = path.join(root, process.platform === "win32" ? "approved-node.exe" : "approved-node");
    const blocked = path.join(root, process.platform === "win32" ? "powershell.exe" : "sh");
    await copyFile(process.execPath, alias);
    await writeFile(blocked, "blocked target", "utf8");

    const validated = await validateStdioConfig({
      id: "snapshot",
      transport: "stdio",
      command: alias,
      cwd,
    }, { approvedCwdRoots: [root], allowedCommands: [alias] });
    const staged = await stageValidatedStdioExecutable(validated);
    try {
      await rm(alias);
      await symlink(blocked, alias, "file");
      expect(execFileSync(staged.command, ["-e", "process.stdout.write('node-snapshot')"], { encoding: "utf8" })).toBe("node-snapshot");
    } finally {
      await staged.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the approved Node alias is swapped before snapshotting", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "cwd");
    await mkdir(cwd);
    const alias = path.join(root, process.platform === "win32" ? "approved-node.exe" : "approved-node");
    const blocked = path.join(root, process.platform === "win32" ? "powershell.exe" : "sh");
    await copyFile(process.execPath, alias);
    await writeFile(blocked, "blocked target", "utf8");

    try {
      const validated = await validateStdioConfig({
        id: "snapshot-swap",
        transport: "stdio",
        command: alias,
        cwd,
      }, { approvedCwdRoots: [root], allowedCommands: [alias] });
      await rm(alias);
      await symlink(blocked, alias, "file");
      await expect(stageValidatedStdioExecutable(validated)).rejects.toThrow(McpSecurityError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
