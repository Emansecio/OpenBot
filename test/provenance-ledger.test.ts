import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const fullSha = "a".repeat(40);
const validAuthorship = {
  schemaVersion: 1,
  localImplementation: {
    scope: ["P0.1", "P0.2", "P0.3", "P0.4"],
    date: "2026-08-24",
    authorType: "ai-agent",
    author: "OpenAI Codex agents",
    directedBy: "repository owner",
    ownerIdentityRecorded: false,
  },
  historicalComponents: {
    status: "unknown",
    scope: ["pre-existing OpenBot components", "extracted Grok Bot artifacts"],
    notAttributedToLocalImplementation: true,
  },
};

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["scripts/verify-provenance-ledger.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

async function runCatalog(catalog: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-provenance-"));
  const catalogPath = join(directory, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog), "utf8");
  const result = runCli([catalogPath, "--json"]);
  await rm(directory, { recursive: true, force: true });
  return { ...result, json: JSON.parse(result.stdout) as { ok: boolean; errors: string[] } };
}

async function runFixture(entries: unknown[]) {
  return runCatalog({ schemaVersion: 1, authorship: validAuthorship, entries });
}

describe("provenance ledger verifier", () => {
  it("accepts the repository provenance catalog through the public CLI", () => {
    const result = runCli(["--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, errors: [] });
  });

  it("pins the mandatory default inventory and competitor snapshot SHA", async () => {
    const catalog = JSON.parse(await readFile(resolve(root, "provenance/openbot-components.json"), "utf8")) as {
      authorship: typeof validAuthorship;
      entries: Array<{ id: string; classification: string; reuse: string; commit?: string }>;
    };
    expect(catalog.authorship).toEqual(validAuthorship);
    const inventory = Object.fromEntries(catalog.entries.map((entry) => [entry.id, {
      classification: entry.classification,
      reuse: entry.reuse,
      ...(entry.commit === undefined ? {} : { commit: entry.commit }),
    }]));

    expect(inventory).toMatchObject({
      "openbot-backend-source": { classification: "own-code", reuse: "copy" },
      "openbot-maintenance-scripts": { classification: "own-code", reuse: "copy" },
      "openbot-tests": { classification: "own-code", reuse: "copy" },
      "openbot-dependency-manifest": { classification: "licensed-dependency", reuse: "per-license" },
      "openbot-dependency-lock": { classification: "licensed-dependency", reuse: "per-license" },
      "grokbot-016-package-metadata": { classification: "extracted-artifact", reuse: "no-copy" },
      "grokbot-016-electron-main": { classification: "extracted-artifact", reuse: "no-copy" },
      "grokbot-016-electron-preload": { classification: "extracted-artifact", reuse: "no-copy" },
      "grokbot-016-renderer-index": { classification: "extracted-artifact", reuse: "no-copy" },
      "grokbot-016-renderer-entry": { classification: "extracted-artifact", reuse: "no-copy" },
      "grokbot-016-renderer-style": { classification: "extracted-artifact", reuse: "no-copy" },
      "openbot-local-settings-overlay": { classification: "own-code", reuse: "copy" },
      "openbot-memory-ui-overlay": { classification: "own-code", reuse: "copy" },
      "openbot-welcome-media": { classification: "own-code", reuse: "copy" },
      "grokbot-018-observational-snapshot": {
        classification: "observational-reference",
        reuse: "no-copy",
        commit: "a9f633e09d49a85829b8236331b9e21f7e612634",
      },
    });
  });

  it("rejects an authorship record that invents an owner identity or legacy attribution", async () => {
    const result = await runCatalog({
      schemaVersion: 1,
      authorship: {
        ...validAuthorship,
        localImplementation: { ...validAuthorship.localImplementation, ownerIdentityRecorded: true },
        historicalComponents: { ...validAuthorship.historicalComponents, notAttributedToLocalImplementation: false },
      },
      entries: [{
        id: "authorship-negative",
        classification: "own-code",
        origin: "negative fixture",
        reuse: "copy",
        localPath: "package.json",
      }],
    });

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("ownerIdentityRecorded"))).toBe(true);
    expect(result.json.errors.some((error) => error.includes("must not attribute"))).toBe(true);
  });

  it.each([
    ["unknown option", ["--unknown"]],
    ["catalog equals option", ["--catalog=provenance/openbot-components.json"]],
    ["multiple catalog paths", ["provenance/openbot-components.json", "provenance/openbot-components.json"]],
    ["duplicate json option", ["--json", "--json"]],
  ] as const)("fails closed for %s", (_label, args) => {
    const result = runCli([...args]);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; errors: string[] };

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unknown classification", async () => {
    const result = await runFixture([{
      id: "unknown-classification",
      classification: "competitor-code",
      origin: "negative fixture",
      reuse: "no-copy",
      localPath: "package.json",
    }]);

    expect(result.status).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.errors.some((error) => error.includes("classification"))).toBe(true);
  });

  it("rejects a localPath that escapes the repository root by prefix collision", async () => {
    const result = await runFixture([{
      id: "escaping-path",
      classification: "own-code",
      origin: "negative fixture",
      reuse: "copy",
      localPath: "../openbot-outside/package.json",
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("escapes repository root"))).toBe(true);
  });

  it("rejects a local junction that resolves outside the repository root", async ({ skip }) => {
    const container = await mkdtemp(join(root, ".provenance-junction-test-"));
    const externalTarget = await mkdtemp(join(tmpdir(), "openbot-provenance-external-"));
    const linkPath = join(container, "external-link");
    try {
      try {
        await symlink(externalTarget, linkPath, "junction");
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
        if (["EACCES", "EPERM", "ENOSYS"].includes(code)) {
          skip(`junction creation is unavailable in this Windows environment (${code})`);
          return;
        }
        throw error;
      }

      const result = await runFixture([{
        id: "external-junction",
        classification: "own-code",
        origin: "negative fixture",
        reuse: "copy",
        localPath: relative(root, linkPath),
      }]);

      expect(result.status).toBe(1);
      expect(result.json.errors.some((error) => error.includes("resolves outside repository root"))).toBe(true);
    } finally {
      await rm(container, { recursive: true, force: true });
      await rm(externalTarget, { recursive: true, force: true });
    }
  });

  it.each(["observational-reference", "extracted-artifact", "non-reusable"] as const)(
    "rejects reuse copy for %s",
    async (classification) => {
      const reference = classification === "observational-reference"
        ? { repository: "https://github.com/example/competitor.git", commit: fullSha }
        : { localPath: "package.json" };
      const result = await runFixture([{
        id: `${classification}-copy`,
        classification,
        origin: classification === "observational-reference" ? "competitor observational snapshot" : "negative fixture",
        reuse: "copy",
        ...reference,
      }]);

      expect(result.status).toBe(1);
      expect(result.json.errors.some((error) => error.includes("reuse must be no-copy"))).toBe(true);
    },
  );

  it.each([
    ["own-code", "COPY", "copy"],
    ["own-code", "copy-with-credit", "copy"],
    ["own-code", "copy ", "copy"],
    ["licensed-dependency", "copy", "per-license"],
    ["extracted-artifact", "per-license", "no-copy"],
  ] as const)("rejects invalid %s reuse %j", async (classification, reuse, expectedReuse) => {
    const result = await runFixture([{
      id: `invalid-reuse-${classification}-${reuse}`,
      classification,
      origin: "negative fixture",
      reuse,
      localPath: "package.json",
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes(`reuse must be ${expectedReuse}`))).toBe(true);
  });

  it("rejects remote observational evidence without an immutable commit SHA", async () => {
    const result = await runFixture([{
      id: "remote-without-commit",
      classification: "observational-reference",
      origin: "negative fixture",
      reuse: "no-copy",
      repository: "https://github.com/example/competitor.git",
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("commit") && error.includes("SHA"))).toBe(true);
  });

  it("rejects a mutable branch name as the remote commit", async () => {
    const result = await runFixture([{
      id: "mutable-commit",
      classification: "observational-reference",
      origin: "negative fixture",
      reuse: "no-copy",
      repository: "https://github.com/example/competitor.git",
      commit: "main",
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("immutable") && error.includes("SHA"))).toBe(true);
  });

  it("rejects a non-string commit even when its digits match the SHA length", async () => {
    const result = await runFixture([{
      id: "numeric-commit",
      classification: "observational-reference",
      origin: "negative fixture",
      reuse: "no-copy",
      repository: "https://github.com/example/competitor.git",
      commit: 1234567,
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("commit") && error.includes("SHA"))).toBe(true);
  });

  it.each([7, 39, 41, 63, 65])("rejects a %i-character commit SHA", async (length) => {
    const result = await runFixture([{
      id: `sha-length-${length}`,
      classification: "observational-reference",
      origin: "negative fixture",
      reuse: "no-copy",
      repository: "https://github.com/example/competitor.git",
      commit: "a".repeat(length),
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("commit") && error.includes("SHA"))).toBe(true);
  });

  it("accepts a complete 64-character commit SHA", async () => {
    const result = await runFixture([{
      id: "sha-64",
      classification: "observational-reference",
      origin: "positive fixture",
      reuse: "no-copy",
      repository: "https://github.com/example/competitor.git",
      commit: "b".repeat(64),
    }]);

    expect(result.status).toBe(0);
    expect(result.json).toEqual({ ok: true, errors: [] });
  });

  it("rejects duplicate IDs", async () => {
    const entry = {
      id: "duplicate",
      classification: "own-code",
      origin: "negative fixture",
      reuse: "copy",
      localPath: "package.json",
    };
    const result = await runFixture([entry, entry]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("duplicate id"))).toBe(true);
  });

  it("rejects invalid entry shapes and missing required strings", async () => {
    const result = await runFixture([{
      id: "",
      classification: "own-code",
      reuse: 1,
      localPath: "package.json",
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("id"))).toBe(true);
    expect(result.json.errors.some((error) => error.includes("origin"))).toBe(true);
    expect(result.json.errors.some((error) => error.includes("reuse"))).toBe(true);
  });

  it("rejects ambiguous local and remote references", async () => {
    const result = await runFixture([{
      id: "ambiguous-reference",
      classification: "own-code",
      origin: "negative fixture",
      reuse: "copy",
      localPath: "package.json",
      repository: "https://github.com/example/project.git",
      commit: fullSha,
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("exactly one reference"))).toBe(true);
  });

  it("rejects non-HTTPS repositories", async () => {
    const result = await runFixture([{
      id: "http-repository",
      classification: "observational-reference",
      origin: "negative fixture",
      reuse: "no-copy",
      repository: "http://github.com/example/project.git",
      commit: fullSha,
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("repository") && error.includes("HTTPS"))).toBe(true);
  });

  it("rejects a non-string localPath", async () => {
    const result = await runFixture([{
      id: "invalid-local-path",
      classification: "own-code",
      origin: "negative fixture",
      reuse: "copy",
      localPath: 42,
    }]);

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("localPath") && error.includes("string"))).toBe(true);
  });

  it("rejects an unsupported catalog schema", async () => {
    const result = await runCatalog({ schemaVersion: 2, entries: [] });

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("schemaVersion"))).toBe(true);
  });

  it("rejects an empty catalog", async () => {
    const result = await runCatalog({ schemaVersion: 1, entries: [] });

    expect(result.status).toBe(1);
    expect(result.json.errors.some((error) => error.includes("must not be empty"))).toBe(true);
  });
});
