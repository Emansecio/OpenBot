import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { registerRosterHandlers } from "../src/rpc/roster.js";
import { createGateway } from "../src/server/gateway.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openbot-profile-persistence-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  const config = new ConfigStore({ configPath });
  const gateway = createGateway();
  registerRosterHandlers(gateway, config);
  const invoke = (method: string, body: unknown = {}) => gateway.invokeRegisteredHandler(method, body);
  const reopen = async () => {
    config.close();
    const reopened = new ConfigStore({ configPath });
    const reloadedGateway = createGateway();
    registerRosterHandlers(reloadedGateway, reopened);
    try {
      return await reloadedGateway.invokeRegisteredHandler("getLocalProfile", {});
    } finally { reopened.close(); }
  };
  return { root, config, invoke, reopen };
}

const png = (suffix: string) => Buffer.from(`89504e470d0a1a0a${suffix}`, "hex").toString("base64");

describe("local profile persistence", () => {
  it("serializes overlapping avatar saves and reads, preserving partial fields after reload", async () => {
    const { config, invoke, reopen } = await fixture();
    const machineId = config.snapshot().profile.machineId;
    const first = { name: "First profile", avatarShape: "rounded", avatarPngBase64: png("01020304") };
    const second = { name: "Second profile", avatarColor: "#123456", avatarPngBase64: png("05060708") };
    const results = await Promise.allSettled([
      invoke("updateLocalProfile", first),
      invoke("getLocalProfile"),
      invoke("updateLocalProfile", second),
      invoke("getLocalProfile"),
    ]);
    expect(results).toEqual([
      { status: "fulfilled", value: expect.objectContaining(first) },
      { status: "fulfilled", value: expect.objectContaining(first) },
      { status: "fulfilled", value: expect.objectContaining({ ...first, ...second }) },
      { status: "fulfilled", value: expect.objectContaining({ ...first, ...second }) },
    ]);
    expect(await reopen()).toMatchObject({ ...first, ...second, machineId });
    expect(config.snapshot().agents).toEqual([]);
    expect(config.snapshot().profile.avatarPngBase64).toBeUndefined();
  });

  it("finishes a conflicted writer rollback before a queued read or later save", async () => {
    const { root, config, invoke, reopen } = await fixture();
    const original = { name: "Original profile", avatarPngBase64: png("01020304") };
    await invoke("updateLocalProfile", original);
    const mutate = config.mutateProfile.bind(config);
    vi.spyOn(config, "mutateProfile").mockImplementationOnce((mutator, options) => {
      // An unrelated preference commit must still invalidate this profile CAS.
      config.update({ hostSettings: { timezone: "UTC" } });
      return mutate(mutator, options);
    });
    const replacement = { avatarColor: "#abcdef", avatarPngBase64: png("090a0b0c") };
    const results = await Promise.allSettled([
      invoke("updateLocalProfile", { name: "Rejected profile", avatarPngBase64: png("05060708") }),
      invoke("getLocalProfile"),
      invoke("updateLocalProfile", replacement),
    ]);
    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ status: 409 }) },
      { status: "fulfilled", value: expect.objectContaining(original) },
      { status: "fulfilled", value: expect.objectContaining({ ...original, ...replacement }) },
    ]);
    expect(await readFile(join(root, "profile-avatar.png"))).toEqual(Buffer.from(replacement.avatarPngBase64, "base64"));
    expect(await reopen()).toMatchObject({ ...original, ...replacement });
    expect(new ConfigStore({ configPath: config.path }).snapshot().hostSettings.timezone).toBe("UTC");
  });
});
