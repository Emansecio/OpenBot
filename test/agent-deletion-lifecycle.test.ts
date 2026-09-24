import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
import { DEFAULT_WORKSPACE_QUOTA, measureManagedDiskBytes } from "../src/execution/quota.js";
import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import type { RpcHandler } from "../src/server/gateway.js";
import * as atomic from "../src/shared/fs-atomic.js";
import { TempRoots } from "./helpers/temp-roots.js";

const handles: ServerHandle[] = [];
const temp = new TempRoots();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  await temp.cleanup();
});

function rpc(handle: ServerHandle, method: string): RpcHandler {
  const handler = handle.gateway.listHandlers().get(method);
  if (!handler) throw new Error(`missing RPC handler: ${method}`);
  return handler;
}

function context(handle: ServerHandle) {
  return { getStatus: () => handle.runner.getStatus(), publish: () => undefined, method: "test" } as never;
}

function paths(root: string) {
  return {
    configPath: join(root, "config.json"),
    stateRoot: join(root, "state"),
    runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"),
    keystoreDir: join(root, "keystore"),
    storePath: join(root, "store.db"),
    allowUnauthenticatedLocalGateway: true,
  } as const;
}


describe("agent creation and explicit cleanup", () => {
  it("discards partial creation before publishing an active home and permits a fresh retry", async () => {
    const root = temp.make("openbot-create-write-failure-");
    const handle = await startServer(0, paths(root));
    handles.push(handle);
    const write = vi.spyOn(atomic, "writeFileExclusive").mockRejectedValueOnce(
      Object.assign(new Error("fixture disk full"), { code: "ENOSPC" }),
    );
    await expect(rpc(handle, "createAgent")({ id: "partial", name: "Partial" }, context(handle)))
      .rejects.toThrow("fixture disk full");
    write.mockRestore();
    expect(handle.config.snapshot().agents).toEqual([]);
    expect(existsSync(handle.homes!.pathFor("partial"))).toBe(false);
    expect(await handle.homes!.listQuarantineMetadata()).toEqual([]);
    expect(await fsp.readdir(handle.homes!.stagingRoot)).toEqual([]);

    await expect(rpc(handle, "createAgent")({ id: "partial", name: "Retry" }, context(handle)))
      .resolves.toMatchObject({ agent: { id: "partial", name: "Retry" } });
    const active = handle.homes!.pathFor("partial");
    writeFileSync(join(active, "Documents", "keep.txt"), "existing data");
    vi.spyOn(atomic, "writeFileExclusive").mockRejectedValueOnce(new Error("existing welcome unavailable"));
    await expect(handle.homes!.ensure("partial")).rejects.toThrow("existing welcome unavailable");
    expect(readFileSync(join(active, "Documents", "keep.txt"), "utf8")).toBe("existing data");
    expect(await handle.homes!.listQuarantineMetadata()).toEqual([]);
  });

  it("deletes and rolls back a home above the default inventory quota", async () => {
    const root = temp.make("openbot-delete-large-home-");
    const handle = await startServer(0, paths(root));
    handles.push(handle);
    // Scale the production 2 GiB default down without allocating a large file.
    const originalLimit = DEFAULT_WORKSPACE_QUOTA.maxBytes;
    DEFAULT_WORKSPACE_QUOTA.maxBytes = 128 * 1024;
    try {
      await rpc(handle, "createAgent")({ id: "large-home", name: "Large", workspaceQuota: { maxBytes: 512 * 1024 } }, context(handle));
      const file = join(handle.homes!.pathFor("large-home"), "Documents", "data.bin");
      const bytes = Buffer.alloc(256 * 1024, 42);
      writeFileSync(file, bytes);
      const clear = handle.store.clear.bind(handle.store);
      vi.spyOn(handle.store, "clear").mockImplementationOnce((id) => { clear(id); throw new Error("fixture cleanup failure"); });
      await expect(rpc(handle, "deleteAgents")({ ids: ["large-home"] }, context(handle))).rejects.toThrow("fixture cleanup failure");
      expect(handle.config.snapshot().agents.map((agent) => agent.id)).toEqual(["large-home"]);
      expect(readFileSync(file)).toEqual(bytes);
      expect(await handle.homes!.listQuarantineMetadata()).toEqual([]);

      await expect(rpc(handle, "deleteAgents")({ ids: ["large-home"] }, context(handle))).resolves.toMatchObject({ ok: true });
      expect(existsSync(file)).toBe(false);
      const listed = await rpc(handle, "listQuarantinedAgents")({ includeInventory: false }, context(handle));
      expect(listed).toEqual([expect.objectContaining({ agentId: "large-home" })]);
      await expect(rpc(handle, "purgeDeletedAgentData")({ agentId: "large-home", confirm: true }, context(handle)))
        .resolves.toMatchObject({ ok: true, quarantinesRemoved: 1 });
    } finally {
      DEFAULT_WORKSPACE_QUOTA.maxBytes = originalLimit;
    }
  });

  it("requires explicit confirmation and preserves live bots and pending recovery", async () => {
    const root = temp.make("openbot-purge-deleted-");
    const handle = await startServer(0, paths(root));
    handles.push(handle);
    for (const id of ["purge-victim", "purge-survivor"]) {
      await rpc(handle, "createAgent")({ id, name: id }, context(handle));
      writeFileSync(join(handle.homes!.pathFor(id), "Documents", "data.bin"), Buffer.alloc(64 * 1024, 42));
    }
    const snapshot = await handle.homes!.snapshot("purge-victim");
    const survivorSnapshot = await handle.homes!.snapshot("purge-survivor");
    await rpc(handle, "deleteAgents")({ ids: ["purge-victim"] }, context(handle));
    const bytesBefore = await measureManagedDiskBytes([handle.homes!.root]);
    const purge = rpc(handle, "purgeDeletedAgentData");
    await expect(purge({ agentId: "purge-victim" }, context(handle))).rejects.toMatchObject({ status: 400 });
    await expect(purge({ agentId: "purge-survivor", confirm: true }, context(handle))).rejects.toMatchObject({ status: 409 });
    handle.store.beginAgentDeletion(["purge-victim"]);
    await expect(purge({ agentId: "PURGE-VICTIM", confirm: true }, context(handle))).rejects.toMatchObject({ status: 409 });
    handle.store.completeAgentDeletion(["purge-victim"]);

    await expect(purge({ agentId: "purge-victim", confirm: true }, context(handle)))
      .resolves.toEqual({ ok: true, agentId: "purge-victim", quarantinesRemoved: 1, snapshotsRemoved: 1 });
    expect(await handle.homes!.listQuarantineMetadata()).toEqual([]);
    expect(existsSync(snapshot.path)).toBe(false);
    expect(existsSync(survivorSnapshot.path)).toBe(true);
    expect(existsSync(join(handle.homes!.pathFor("purge-survivor"), "Documents", "data.bin"))).toBe(true);
    expect(await measureManagedDiskBytes([handle.homes!.root])).toBeLessThan(bytesBefore - 128 * 1024);
    await expect(purge({ agentId: "purge-victim", confirm: true }, context(handle)))
      .resolves.toMatchObject({ quarantinesRemoved: 0, snapshotsRemoved: 0 });
  });

  it("retains quarantine identity after partial cleanup and serializes recreation with retry", async () => {
    const root = temp.make("openbot-purge-retry-");
    const handle = await startServer(0, paths(root));
    handles.push(handle);
    await rpc(handle, "createAgent")({ id: "purge-retry", name: "Purge retry" }, context(handle));
    await rpc(handle, "deleteAgents")({ ids: ["purge-retry"] }, context(handle));
    const quarantined = (await handle.homes!.listQuarantineMetadata())[0]!;
    const realRm = fsp.rm.bind(fsp);
    const removal = vi.spyOn(fsp, "rm").mockImplementationOnce(async (target) => {
      expect(String(target)).toBe(quarantined.root);
      await fsp.unlink(join(quarantined.root, ".openbot", "quarantine.json"));
      throw Object.assign(new Error("fixture busy directory"), { code: "EPERM" });
    });
    const purge = () => rpc(handle, "purgeDeletedAgentData")({ agentId: "purge-retry", confirm: true }, context(handle));
    await expect(purge()).rejects.toThrow("fixture busy directory");
    expect(await handle.homes!.listQuarantineMetadata()).toEqual([quarantined]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let removing = false;
    removal.mockImplementation(async (target, options) => {
      if (String(target) === quarantined.root) { removing = true; await gate; }
      return realRm(target, options);
    });
    const retry = purge();
    let recreation: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(removing).toBe(true));
      recreation = Promise.resolve(rpc(handle, "createAgent")({ id: "purge-retry", name: "Fresh" }, context(handle)));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(handle.config.snapshot().agents).toEqual([]);
      release();
      await expect(retry).resolves.toMatchObject({ quarantinesRemoved: 1 });
      await expect(recreation).resolves.toMatchObject({ agent: { id: "purge-retry", name: "Fresh" } });
      expect(existsSync(join(handle.homes!.pathFor("purge-retry"), ".openbot", "home.json"))).toBe(true);
    } finally {
      release();
      await Promise.allSettled([retry, recreation]);
      removal.mockRestore();
    }
  });

  it("aborts deleted bots' reflection requests before post-commit purges finish", async () => {
    const root = temp.make("openbot-delete-reflection-");
    let releasePurge!: () => void;
    const purgeGate = new Promise<void>((resolve) => { releasePurge = resolve; });
    const handle = await startServer(0, { ...paths(root), browserLifecycle: {
      teardownAgent: async () => undefined, purgeAgent: async () => purgeGate,
    } });
    handles.push(handle);
    const signals: AbortSignal[] = [];
    let nextStarted = false;
    handle.registry.register({
      name: "xai",
      async streamChat(request, emit) {
        const input = JSON.parse(request.messages[0]!.content as string) as { agentId: string };
        if (input.agentId === "reflection-next") nextStarted = true;
        else {
          const signal = request.signal!;
          signals.push(signal);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        emit({ type: "delta", delta: '{"operations":[]}' });
      },
    });
    for (const id of ["reflection-a", "reflection-b", "reflection-next"]) {
      await rpc(handle, "createAgent")({ id, name: id, provider: "xai" }, context(handle));
    }
    const enqueue = (id: string) => handle.reflectionWorker!.enqueue({
      agentId: id, conversationId: handle.conversationStore.ensureDefault(id).id,
      provider: "xai", model: handle.config.snapshot().agents.find((agent) => agent.id === id)!.model!,
      fromSequenceId: 0, throughSequenceId: 1, entries: [], summaryRequested: false, memoryRequested: true,
    });
    enqueue("reflection-a"); enqueue("reflection-b");
    let deletion: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      deletion = Promise.resolve(rpc(handle, "deleteAgents")({ ids: ["reflection-a", "reflection-b"] }, context(handle)));
      await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
      enqueue("reflection-next");
      await vi.waitFor(() => expect(nextStarted).toBe(true));
      expect(handle.store.memoryStore.listJobs("reflection-a")).toEqual([]);
      expect(handle.store.memoryStore.listJobs("reflection-b")).toEqual([]);
      releasePurge();
      await expect(deletion).resolves.toMatchObject({ ok: true });
    } finally {
      releasePurge();
      await deletion?.catch(() => undefined);
    }
  });
});
