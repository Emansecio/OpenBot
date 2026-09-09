import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentHomeStore, defaultWorkspacesRoot, sanitizeAgentId } from "../src/execution/home.js";
import type { HomeAclAdapter, HomeAclResult } from "../src/execution/home-acl.js";

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-home-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resume) => {
    resolve = resume;
  });
  return { promise, resolve };
}

const verifiedWinAcl = (): HomeAclResult => ({ status: "verified", platform: "win32" });

describe("sanitizeAgentId", () => {
  it("accepts the default roster id", () => {
    expect(sanitizeAgentId("openbot-default")).toBe("openbot-default");
  });

  it.each(["", "..", "foo/bar", "foo\\bar", "CON", "COM1", "a".repeat(64), " has space", ".hidden"])(
    "rejects %s",
    (id) => {
      expect(() => sanitizeAgentId(id)).toThrow(/invalid/i);
    },
  );
});

describe("AgentHomeStore", () => {
  it("seeds layout once and keeps user files on the second ensure", async () => {
    const store = await AgentHomeStore.create(await temp());
    const first = await store.ensure("openbot-default");
    const note = join(first.root, "Documents", "nota.md");
    await writeFile(note, "keep-me");
    const welcome = join(first.root, "Desktop", "Bem-vindo.md");
    const originalWelcome = await readFile(welcome, "utf8");
    await writeFile(welcome, "user-edited");

    const second = await store.ensure("openbot-default");
    expect(second.root).toBe(first.root);
    await expect(readFile(note, "utf8")).resolves.toBe("keep-me");
    await expect(readFile(welcome, "utf8")).resolves.toBe("user-edited");
    const manifest = JSON.parse(await readFile(join(first.root, ".openbot", "home.json"), "utf8")) as {
      agentId: string;
      layoutVersion: number;
      createdAt: string;
    };
    expect(manifest).toMatchObject({ agentId: "openbot-default", layoutVersion: 2 });
    expect(manifest.createdAt.length).toBeGreaterThan(0);
    expect(originalWelcome.length).toBeGreaterThan(0);
    for (const name of ["Desktop", "Documents", "Downloads", "Projects", ".openbot"]) {
      expect((await stat(join(first.root, name))).isDirectory()).toBe(true);
    }
  });

  it("isolates two agent ids and refuses a stolen folder", async () => {
    const store = await AgentHomeStore.create(await temp());
    const a = await store.ensure("agent-a");
    const b = await store.ensure("agent-b");
    expect(a.root).not.toBe(b.root);
    await writeFile(join(a.root, "Documents", "secret.txt"), "only-a");
    await expect(stat(join(b.root, "Documents", "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const stolen = await AgentHomeStore.create(await temp());
    await stolen.ensure("agent-a");
    await writeFile(join(stolen.pathFor("agent-a"), ".openbot", "home.json"), JSON.stringify({
      agentId: "agent-b",
      createdAt: "2026-01-01T00:00:00.000Z",
      layoutVersion: 1,
    }));
    await expect(stolen.ensure("agent-a")).rejects.toThrow(/reutil/i);
  });

  it("recreates missing layout dirs and rejects corrupt home.json", async () => {
    const store = await AgentHomeStore.create(await temp());
    const home = await store.ensure("openbot-default");
    await rm(join(home.root, "Documents"), { recursive: true, force: true });
    await expect(store.ensure("openbot-default")).resolves.toMatchObject({ root: home.root });
    expect((await stat(join(home.root, "Documents"))).isDirectory()).toBe(true);

    await writeFile(join(home.root, ".openbot", "home.json"), "{not-json");
    await expect(store.ensure("openbot-default")).rejects.toThrow(/corromp/i);
  });

  it("rejects a home manifest with an unsupported layout version", async () => {
    const store = await AgentHomeStore.create(await temp());
    const home = await store.ensure("unsupported-layout");
    await writeFile(join(home.root, ".openbot", "home.json"), JSON.stringify({
      agentId: "unsupported-layout",
      createdAt: "2026-01-01T00:00:00.000Z",
      layoutVersion: 999,
    }));

    await expect(store.ensure("unsupported-layout")).rejects.toMatchObject({ code: "integrity_error" });
    await expect(store.ensure("unsupported-layout")).rejects.toThrow(/layout version/i);
  });

  it("move a home removida para quarentena e preserva seus arquivos", async () => {
    const store = await AgentHomeStore.create(await temp());
    const home = await store.ensure("agent-delete");
    await writeFile(join(home.root, "Documents", "preserve.txt"), "recoverable");

    await store.remove("agent-delete");

    await expect(stat(home.root)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantined = await readdir(store.quarantineRoot);
    expect(quarantined).toHaveLength(1);
    await expect(readFile(join(store.quarantineRoot, quarantined[0]!, "Documents", "preserve.txt"), "utf8")).resolves.toBe("recoverable");
  });

  it("serializa ACLs do workspace entre backendFor/ensure concorrentes de bots diferentes", async () => {
    const root = await temp();
    const releaseHomes = deferred();
    const seenHomes = new Set<string>();
    let activeWorkspaceApplies = 0;
    const acl: HomeAclAdapter = {
      async apply(_target, context) {
        if (context.agentId !== "workspace") {
          seenHomes.add(context.agentId);
          if (seenHomes.size === 2) releaseHomes.resolve();
          await releaseHomes.promise;
          return verifiedWinAcl();
        }
        const overlapped = activeWorkspaceApplies > 0;
        activeWorkspaceApplies += 1;
        await Promise.resolve();
        activeWorkspaceApplies -= 1;
        return overlapped
          ? { status: "failed", platform: "win32", message: "simulated overlapping workspace ACL apply" }
          : verifiedWinAcl();
      },
    };
    const store = await AgentHomeStore.create(root, { acl });

    await expect(Promise.all([
      store.backendFor("agent-a"),
      store.ensure("agent-b"),
    ])).resolves.toHaveLength(2);
  });

  it("serializa ACLs de workspace entre duas AgentHomeStore instances com o mesmo root", async () => {
    const root = await temp();
    const releaseHomes = deferred();
    const seenHomes = new Set<string>();
    let activeWorkspaceApplies = 0;
    const acl: HomeAclAdapter = {
      async apply(_target, context) {
        if (context.agentId !== "workspace") {
          seenHomes.add(context.agentId);
          if (seenHomes.size === 2) releaseHomes.resolve();
          await releaseHomes.promise;
          return verifiedWinAcl();
        }
        const overlapped = activeWorkspaceApplies > 0;
        activeWorkspaceApplies += 1;
        await Promise.resolve();
        activeWorkspaceApplies -= 1;
        return overlapped
          ? { status: "failed", platform: "win32", message: "simulated overlapping workspace ACL apply across store instances" }
          : verifiedWinAcl();
      },
    };

    const [storeA, storeB] = await Promise.all([
      AgentHomeStore.create(root, { acl }),
      AgentHomeStore.create(root, { acl }),
    ]);

    await expect(Promise.all([
      storeA.ensure("agent-a"),
      storeB.ensure("agent-b"),
    ])).resolves.toHaveLength(2);
  });

  it("continua processando a próxima ACL de workspace após uma falha anterior", async () => {
    const root = await temp();
    const firstWorkspaceFailed = deferred();
    let workspaceRootCalls = 0;
    let firstWorkspaceFailureReleased = false;
    let nextStartedBeforeFailure = false;
    const acl: HomeAclAdapter = {
      async apply(target, context) {
        if (context.agentId !== "workspace") return verifiedWinAcl();
        if (target === root) {
          workspaceRootCalls += 1;
          if (workspaceRootCalls === 1) {
            return verifiedWinAcl();
          }
          if (workspaceRootCalls === 2) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            firstWorkspaceFailureReleased = true;
            firstWorkspaceFailed.resolve();
            return { status: "failed", platform: "win32", message: "intentional first workspace failure" };
          }
          nextStartedBeforeFailure = !firstWorkspaceFailureReleased;
          await firstWorkspaceFailed.promise;
        }
        return verifiedWinAcl();
      },
    };
    const store = await AgentHomeStore.create(root, { acl });
    await store.ensure("agent-a");
    await store.ensure("agent-b");

    const [first, second] = await Promise.allSettled([
      store.repair("agent-a"),
      store.repair("agent-b"),
    ]);
    const statuses = [first.status, second.status].sort();

    expect(statuses).toEqual(["fulfilled", "rejected"]);
    expect(nextStartedBeforeFailure).toBe(false);
    await expect(store.ensure("agent-c")).resolves.toMatchObject({ agentId: "agent-c" });
  });

  it("falha fechado no create quando o ACL de workspace Windows falha", async () => {
    const root = await temp();
    const acl: HomeAclAdapter = {
      async apply(_target, context) {
        return context.agentId === "workspace"
          ? { status: "failed", platform: "win32", message: "intentional create failure" }
          : verifiedWinAcl();
      },
    };

    await expect(AgentHomeStore.create(root, { acl })).rejects.toMatchObject({ code: "access_denied" });
  });

  it("preserva a falha de ACL do import quando a limpeza do staging também falha", async () => {
    const sourceStore = await AgentHomeStore.create(await temp());
    await sourceStore.ensure("cleanup-failure");
    const archivePath = join(await temp(), "cleanup-failure.json");
    await sourceStore.exportArchive("cleanup-failure", archivePath);

    const acl: HomeAclAdapter = {
      async apply(_target, context) {
        return context.operation === "import"
          ? { status: "failed", platform: "win32", message: "import ACL failed" }
          : verifiedWinAcl();
      },
    };
    const cleanupError = new Error("stage cleanup failed");
    const stageDiscarder = vi.fn<(path: string) => Promise<void>>().mockRejectedValue(cleanupError);
    const targetStore = await AgentHomeStore.create(await temp(), { acl, stageDiscarder });

    let failure: unknown;
    try {
      await targetStore.importArchive("cleanup-failure", archivePath);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ code: "access_denied", message: expect.stringMatching(/import ACL failed/i) }),
      cleanupError,
    ]);
    expect(stageDiscarder).toHaveBeenCalledOnce();
    expect(stageDiscarder).toHaveBeenCalledWith(expect.stringContaining(join(targetStore.stagingRoot, "cleanup-failure-")));
  });

  it("não deixa a fila compartilhada bloqueada após falha no create", async () => {
    const root = await temp();
    let createAttempts = 0;
    const acl: HomeAclAdapter = {
      async apply(_target, context) {
        if (context.agentId !== "workspace") return verifiedWinAcl();
        createAttempts += 1;
        return createAttempts === 1
          ? { status: "failed", platform: "win32", message: "first create fails" }
          : verifiedWinAcl();
      },
    };

    await expect(AgentHomeStore.create(root, { acl })).rejects.toMatchObject({ code: "access_denied" });
    const recovered = await AgentHomeStore.create(root, { acl });

    await expect(recovered.ensure("recovered-agent")).resolves.toMatchObject({ agentId: "recovered-agent" });
  });

  it("refuses a workspaces root that is a symbolic link", async () => {
    const parent = await temp();
    const real = await temp();
    const linked = join(parent, "linked");
    await symlink(real, linked, "junction");
    await expect(AgentHomeStore.create(linked)).rejects.toMatchObject({ code: "outside_workspace" });
  });

  it.each(["Desktop", ".openbot"])(
    "does not follow a descendant symlink/junction at %s during ensure",
    async (name) => {
      const root = await temp();
      const outside = await temp();
      const store = await AgentHomeStore.create(root);
      const home = store.pathFor("openbot-default");
      await mkdir(home);
      // Directory junctions work without Developer Mode on Windows; on
      // other platforms Node treats the type as a directory symlink.
      await symlink(outside, join(home, name), process.platform === "win32" ? "junction" : "dir");

      await expect(store.ensure("openbot-default")).rejects.toMatchObject({ code: "outside_workspace" });
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it("defaultWorkspacesRoot lives under Local AppData", () => {
    vi.stubEnv("OPENBOT_LOCAL_DATA_ROOT", "");
    try {
      const expected = process.env.LOCALAPPDATA
        ?? join(process.env.USERPROFILE ?? "", "AppData", "Local");
      expect(defaultWorkspacesRoot()).toBe(join(expected, "OpenBot", "workspaces"));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
