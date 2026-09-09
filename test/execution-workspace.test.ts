import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 as path } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_EXECUTION_PATH_BYTES } from "../src/execution/contracts.js";
import { WorkspaceError, WorkspaceSandbox } from "../src/execution/workspace.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("WorkspaceSandbox", () => {
  it("resolves existing paths and destinations below its canonical root", async () => {
    const root = await temporaryDirectory("openbot-workspace-");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n");

    const workspace = await WorkspaceSandbox.create(root);

    await expect(workspace.resolveExisting("src/index.ts")).resolves.toBe(path.join(workspace.root, "src", "index.ts"));
    await expect(workspace.resolveExisting(".")).resolves.toBe(workspace.root);
    await expect(workspace.resolveDestination("src/new.ts")).resolves.toBe(path.join(workspace.root, "src", "new.ts"));
    await expect(workspace.resolveDestination("missing/file.txt")).rejects.toMatchObject({ code: "not_found" });
  });

  it.each(["..\\outside.txt", "folder\\..\\..\\outside.txt", "C:\\outside.txt", "C:outside.txt", "\\outside.txt", "//server/share/file.txt"]) (
    "rejects a Windows path outside the workspace: %s",
    async (candidate) => {
      const workspace = await WorkspaceSandbox.create(await temporaryDirectory("openbot-workspace-"));
      await expect(workspace.resolveDestination(candidate)).rejects.toMatchObject({ code: "outside_workspace" });
    },
  );

  it("uses Windows separators and case-insensitive containment", async () => {
    const root = await temporaryDirectory("openbot-workspace-");
    await mkdir(path.join(root, "Folder"));
    await writeFile(path.join(root, "Folder", "item.txt"), "ok");
    const workspace = await WorkspaceSandbox.create(root);

    await expect(workspace.resolveExisting("folder\\item.txt")).resolves.toBe(path.join(workspace.root, "folder", "item.txt"));
  });

  it("rejects symlink and junction components for existing paths and destinations", async () => {
    const root = await temporaryDirectory("openbot-workspace-");
    const outside = await temporaryDirectory("openbot-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "linked"), "junction");
    const workspace = await WorkspaceSandbox.create(root);

    await expect(workspace.resolveExisting("linked\\secret.txt")).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "outside_workspace",
      message: "Workspace path contains a symbolic link or junction.",
    });
    await expect(workspace.resolveDestination("linked\\new.txt")).rejects.toMatchObject({ code: "outside_workspace" });
  });

  it("rejects a workspace root reached through a junction", async () => {
    const parent = await temporaryDirectory("openbot-parent-");
    const actual = await temporaryDirectory("openbot-actual-");
    const linked = path.join(parent, "linked");
    await symlink(actual, linked, "junction");

    await expect(WorkspaceSandbox.create(linked)).rejects.toMatchObject({
      code: "outside_workspace",
      message: "Workspace root contains a symbolic link or junction.",
    });
  });

  it("allowAncestorLinks accepts a home under a redirected ancestor and still rejects a linked leaf", async () => {
    const actual = await temporaryDirectory("openbot-actual-");
    const parent = await temporaryDirectory("openbot-parent-");
    const linked = path.join(parent, "linked");
    await symlink(actual, linked, "junction");
    const home = path.join(linked, "openbot-default");
    await mkdir(home);

    const workspace = await WorkspaceSandbox.create(home, { allowAncestorLinks: true });
    expect(workspace.root.toLowerCase()).toBe(path.join(actual, "openbot-default").toLowerCase());
    await writeFile(path.join(workspace.root, "ok.txt"), "ok");
    await expect(workspace.resolveExisting("ok.txt")).resolves.toBe(path.join(workspace.root, "ok.txt"));

    await expect(WorkspaceSandbox.create(linked, { allowAncestorLinks: true })).rejects.toMatchObject({
      code: "outside_workspace",
    });
  });

  it("allowRootReparse accepts a junction root and grounds paths in its realpath", async () => {
    const actual = await temporaryDirectory("openbot-reparse-actual-");
    const parent = await temporaryDirectory("openbot-reparse-parent-");
    const linked = path.join(parent, "Documents");
    await symlink(actual, linked, "junction");
    await writeFile(path.join(actual, "note.txt"), "ok");

    const workspace = await WorkspaceSandbox.create(linked, { allowRootReparse: true });
    expect(workspace.root.toLowerCase()).toBe(actual.toLowerCase());
    await expect(workspace.resolveExisting("note.txt")).resolves.toBe(path.join(actual, "note.txt"));
  });

  it("returns stable errors without exposing host paths or OS error text", async () => {
    const root = await temporaryDirectory("openbot-sensitive-");
    const workspace = await WorkspaceSandbox.create(root);

    let failure: unknown;
    try {
      await workspace.resolveExisting("private-name.txt");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorkspaceError);
    expect(failure).toMatchObject({ code: "not_found", message: "Workspace path does not exist." });
    expect((failure as Error).message).not.toContain(root);
    expect((failure as Error).message).not.toContain("private-name.txt");
  });

  it.each([
    "",
    "file.txt:stream",
    "bad\0name",
    "bad<name",
    "bad>name",
    'bad"name',
    "bad|name",
    "bad?name",
    "bad*name",
    "bad\u0001name",
    "trailing-dot.",
    "trailing-space ",
    "folder\\child. ",
    "folder\\\\child",
    "folder//child",
    "CON",
    "con.txt",
    "PRN.log",
    "AUX",
    "NUL.data",
    "COM1",
    "com9.log",
    "LPT1",
    "lpt9.txt",
  ])("rejects a Windows-invalid workspace path: %j", async (candidate) => {
    const workspace = await WorkspaceSandbox.create(await temporaryDirectory("openbot-workspace-"));
    await expect(workspace.resolveDestination(candidate)).rejects.toMatchObject({
      code: "invalid_path",
      message: "Workspace path is invalid.",
    });
  });

  it.each(["folder\\..\\inside.txt", ".\\folder\\..\\inside.txt", "folder/../inside.txt"])(
    "rejects traversal even when it would normalize inside the workspace: %s",
    async (candidate) => {
      const workspace = await WorkspaceSandbox.create(await temporaryDirectory("openbot-workspace-"));
      await expect(workspace.resolveDestination(candidate)).rejects.toMatchObject({
        code: "outside_workspace",
        message: "Workspace path is outside the workspace.",
      });
    },
  );

  it("rejects multibyte input by its UTF-8 byte length before resolving it", async () => {
    const root = await temporaryDirectory("openbot-workspace-");
    const workspace = await WorkspaceSandbox.create(root);
    const inputOverLimit = "\u00e9".repeat(Math.floor(MAX_EXECUTION_PATH_BYTES / 2) + 1);
    expect(inputOverLimit.length).toBeLessThanOrEqual(MAX_EXECUTION_PATH_BYTES);
    expect(Buffer.byteLength(inputOverLimit)).toBeGreaterThan(MAX_EXECUTION_PATH_BYTES);

    const resolveSpy = vi.spyOn(path, "resolve");
    try {
      await expect(workspace.resolveDestination(inputOverLimit)).rejects.toMatchObject({
        code: "invalid_path",
        message: "Workspace path is invalid.",
      });
      expect(resolveSpy).not.toHaveBeenCalled();
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("rejects a below-limit input when its resolved path exceeds the byte limit", async () => {
    const root = await temporaryDirectory("openbot-workspace-");
    const workspace = await WorkspaceSandbox.create(root);
    const inputBelowLimit = "a".repeat(MAX_EXECUTION_PATH_BYTES - Buffer.byteLength(workspace.root));
    expect(Buffer.byteLength(inputBelowLimit)).toBeLessThan(MAX_EXECUTION_PATH_BYTES);
    expect(Buffer.byteLength(path.resolve(workspace.root, inputBelowLimit))).toBeGreaterThan(MAX_EXECUTION_PATH_BYTES);

    await expect(workspace.resolveDestination(inputBelowLimit)).rejects.toMatchObject({
      code: "invalid_path",
      message: "Workspace path is invalid.",
    });
  });

  it("requires the root to be an existing directory", async () => {
    const root = await temporaryDirectory("openbot-workspace-");
    const file = path.join(root, "file.txt");
    await writeFile(file, "not a directory");

    await expect(WorkspaceSandbox.create(file)).rejects.toMatchObject({
      code: "invalid_path",
      message: "Workspace root is not a directory.",
    });
    await expect(WorkspaceSandbox.create(path.join(root, "missing"))).rejects.toMatchObject({
      code: "not_found",
      message: "Workspace root does not exist.",
    });
  });
});
