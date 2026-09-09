import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentHomeBroker } from "../src/execution/broker.js";
import { AgentHomeStore } from "../src/execution/home.js";
import { HomeWorkspaceBackend } from "../src/execution/home-backend.js";
import { DEFAULT_WORKSPACE_QUOTA, DEFAULT_WORKSPACE_QUOTA_SCOPES, type WorkspaceQuotaOptions } from "../src/execution/quota.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("HomeWorkspaceBackend", () => {
  it("preserva a quota e os escopos padrão quando não há override", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-home-default-quota-"));
    roots.push(root);

    const backend = await HomeWorkspaceBackend.create(root);
    const configured = (backend.quota as unknown as { options: WorkspaceQuotaOptions }).options;

    expect(configured).toEqual({ ...DEFAULT_WORKSPACE_QUOTA, scopes: DEFAULT_WORKSPACE_QUOTA_SCOPES });
  });

  it("aplica um override pequeno e retorna quota_exceeded no backend de arquivos", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-home-quota-override-"));
    roots.push(root);
    await mkdir(join(root, "Documents"));

    const backend = await HomeWorkspaceBackend.create(root, {
      quota: { maxBytes: 4, maxFiles: 100, maxEntries: 100 },
    });

    await expect(backend.execute({
      operation: "file.write",
      path: "Documents/too-large.txt",
      content: "12345",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: false, operation: "file.write", code: "quota_exceeded" });
  });

  it("writes and searches inside one home and refuses escape", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openbot-home-be-"));
    roots.push(parent);
    const store = await AgentHomeStore.create(parent);
    const home = await store.ensure("agent-a");
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "untouched");

    const backend = await HomeWorkspaceBackend.create(home.root);
    const written = await backend.execute({
      operation: "file.write",
      path: "Documents/nota.md",
      content: "needle",
      encoding: "utf8",
    });
    expect(written).toMatchObject({ ok: true });
    await expect(readFile(join(home.root, "Documents", "nota.md"), "utf8")).resolves.toBe("needle");

    const found = await backend.execute({
      operation: "command.run",
      command: "search.text",
      cwd: ".",
      params: { pattern: "needle", mode: "fixed", paths: ["Documents"] },
    });
    expect(found).toMatchObject({ ok: true });
    if (found.ok && found.operation === "command.run") {
      expect(found.stdout).toContain("Documents/nota.md");
    }

    await expect(backend.execute({
      operation: "file.write",
      path: "..\\outside.txt",
      content: "pwned",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: false, code: "outside_workspace" });
    await expect(readFile(outside, "utf8")).resolves.toBe("untouched");
  });

  it("backendFor caches per agent and does not leak files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-home-cache-"));
    roots.push(dir);
    const store = await AgentHomeStore.create(dir);
    const a = await store.backendFor("agent-a");
    const b = await store.backendFor("agent-b");
    expect(a).not.toBe(b);
    expect(await store.backendFor("agent-a")).toBe(a);
    await a.execute({ operation: "file.write", path: "Documents/a.txt", content: "aaa", encoding: "utf8" });
    const listed = await b.execute({ operation: "file.list", path: "Documents" });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok && listed.operation === "file.list") {
      expect(listed.entries.map((entry) => entry.name)).not.toContain("a.txt");
    }
  });

  it("keeps administrative metadata private from the agent backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-home-admin-"));
    roots.push(dir);
    const store = await AgentHomeStore.create(dir);
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root);

    await expect(backend.execute({ operation: "file.read", path: ".openbot/home.json", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false, code: "access_denied" });
    await expect(backend.execute({ operation: "file.write", path: ".openbot/forbidden.txt", content: "nope", encoding: "utf8" }))
      .resolves.toMatchObject({ ok: false, code: "access_denied" });

    const listed = await backend.execute({ operation: "file.list", path: "." });
    expect(listed).toMatchObject({ ok: true, operation: "file.list" });
    if (listed.ok && listed.operation === "file.list") {
      expect(listed.entries.map((entry) => entry.name)).not.toContain(".openbot");
    }

    await expect(backend.execute({
      operation: "command.run",
      command: "search.files",
      cwd: ".",
      params: { paths: ["."] },
    })).resolves.toMatchObject({ ok: false, code: "access_denied" });
  });

  it("production broker refuses an unregistered agent without creating a home", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-home-allow-"));
    roots.push(dir);
    const store = await AgentHomeStore.create(dir);
    await store.ensure("openbot-default");
    const broker = createAgentHomeBroker(store, { allowedAgentIds: ["openbot-default"] });
    await expect(broker.execute("health-agent", "r1", { operation: "file.list", path: "." })).resolves.toMatchObject({
      ok: false,
      code: "permission_denied",
    });
    await expect(stat(join(dir, "health-agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads and writes drive-absolute host paths outside the home", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openbot-home-host-"));
    roots.push(parent);
    const store = await AgentHomeStore.create(parent);
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: parent, agentId: "agent-a" });
    const target = join(parent, "fora-da-home.txt");

    await expect(backend.execute({
      operation: "file.write",
      path: target,
      content: "host-bytes",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(target, "utf8")).resolves.toBe("host-bytes");
    await expect(backend.execute({
      operation: "file.read",
      path: target,
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: true, operation: "file.read" });
    const listed = await backend.execute({ operation: "file.list", path: parent });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok && listed.operation === "file.list") {
      expect(listed.entries.map((entry) => entry.name)).toContain("fora-da-home.txt");
    }
  });

  it("rejects drive-absolute host paths containing ..", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openbot-home-host-dotdot-"));
    roots.push(parent);
    const store = await AgentHomeStore.create(parent);
    const home = await store.ensure("agent-a");
    const backend = await HomeWorkspaceBackend.create(home.root, { userProfile: parent, agentId: "agent-a" });

    await expect(backend.execute({
      operation: "file.write",
      path: `${parent}\\sub\\..\\evil.txt`,
      content: "nope",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: false, code: "outside_workspace" });
    await expect(stat(join(parent, "evil.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
