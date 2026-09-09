import { lstatSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error JavaScript verification script intentionally has no declarations.
import { verifyBackendArtifacts } from "../scripts/verify-backend-artifacts.mjs";

const sourceFiles = [
  "main.ts",
  "server/local-exec-bridge.ts",
  "server/webauthn-bridge.ts",
  "execution/runtime/local/driver.ts",
  "uppercase.TS",
];

async function createFixture(): Promise<{ root: string; sourceRoot: string; distRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "openbot-backend-artifacts-"));
  const sourceRoot = join(root, "source");
  const distRoot = join(root, "dist");
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  await mkdir(distRoot, { recursive: true });
  for (const relativePath of sourceFiles) {
    const sourcePath = join(sourceRoot, "src", relativePath);
    await mkdir(join(sourcePath, ".."), { recursive: true });
    await writeFile(sourcePath, "export {}\n", "utf8");
  }
  await writeFile(join(sourceRoot, "src", "ignored.d.ts"), "export {}\n", "utf8");
  await writeFile(join(sourceRoot, "src", "ignored.D.TS"), "export {}\n", "utf8");
  return { root, sourceRoot, distRoot };
}

async function emitFixture(sourceRoot: string, distRoot: string): Promise<void> {
  const sourceTime = new Date(Date.now() - 5_000);
  for (const relativePath of sourceFiles) {
    await utimes(join(sourceRoot, "src", relativePath), sourceTime, sourceTime);
  }
  for (const relativePath of sourceFiles) {
    const outputPath = join(distRoot, relativePath.replace(/\.ts$/iu, ".js"));
    await mkdir(join(outputPath, ".."), { recursive: true });
    await writeFile(outputPath, "export {};\n", "utf8");
  }
}

describe("backend artifact verifier", () => {
  it("rejeita árvore com output ausente e source stale", async () => {
    const fixture = await createFixture();
    try {
      const staleOutput = join(fixture.distRoot, "main.js");
      await mkdir(join(staleOutput, ".."), { recursive: true });
      await writeFile(staleOutput, "export {};\n", "utf8");
      await utimes(staleOutput, new Date(1_000), new Date(1_000));
      const result = verifyBackendArtifacts({ sourceRoot: fixture.sourceRoot, distRoot: fixture.distRoot });
      expect(result.ok).toBe(false);
      expect(result.errors.some((error: string) => error.includes("main.js") && error.includes("older"))).toBe(true);
      expect(result.errors.some((error: string) => error.includes("server/local-exec-bridge.js") && error.includes("missing"))).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("aceita árvore current com todos os outputs emitidos", async () => {
    const fixture = await createFixture();
    try {
      await emitFixture(fixture.sourceRoot, fixture.distRoot);
      const result = verifyBackendArtifacts({ sourceRoot: fixture.sourceRoot, distRoot: fixture.distRoot });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.checks).toHaveLength(sourceFiles.length);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("exige required outputs mesmo quando não há source emitível", async () => {
    const fixture = await createFixture();
    try {
      for (const relativePath of sourceFiles) await rm(join(fixture.sourceRoot, "src", relativePath), { force: true });
      const result = verifyBackendArtifacts({ sourceRoot: fixture.sourceRoot, distRoot: fixture.distRoot });
      expect(result.ok).toBe(false);
      expect(result.errors.filter((error: string) => error.includes("required output is missing"))).toHaveLength(4);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejeita symlink live ou usa seam lstat fake explicitamente quando criação é negada", async () => {
    const fixture = await createFixture();
    try {
      await emitFixture(fixture.sourceRoot, fixture.distRoot);
      const linkPath = join(fixture.sourceRoot, "src", "link.ts");
      let liveSymlink = false;
      try {
        await symlink(join(fixture.sourceRoot, "src", "main.ts"), linkPath, "file");
        liveSymlink = true;
      } catch {
        await writeFile(linkPath, "export {};\n", "utf8");
      }
      const result = verifyBackendArtifacts(liveSymlink
        ? { sourceRoot: fixture.sourceRoot, distRoot: fixture.distRoot }
        : {
          sourceRoot: fixture.sourceRoot,
          distRoot: fixture.distRoot,
          fs: {
            lstatSync(file: string) {
              if (file === linkPath) return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, mtimeMs: 0 };
              return lstatSync(file);
            },
          },
        });
      expect(liveSymlink || result.errors.some((error: string) => error.includes("lstat seam")) || result.errors.some((error: string) => error.includes("reparse"))).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.errors.some((error: string) => error.includes("symbolic link") || error.includes("reparse"))).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejeita reparse em ancestral acima de sourceRoot e distRoot via seam lstat", async () => {
    const fixture = await createFixture();
    try {
      await emitFixture(fixture.sourceRoot, fixture.distRoot);
      const ancestor = resolve(fixture.sourceRoot, "..");
      const result = verifyBackendArtifacts({
        sourceRoot: fixture.sourceRoot,
        distRoot: fixture.distRoot,
        fs: {
          lstatSync(file: string) {
            if (file === ancestor) return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, mtimeMs: 0 };
            return lstatSync(file);
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((error: string) => error.includes("ancestor") && error.includes("symbolic link/reparse"))).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("CLI aceita args e retorna GREEN/RED com exit code", async () => {
    const fixture = await createFixture();
    try {
      await emitFixture(fixture.sourceRoot, fixture.distRoot);
      const green = spawnSync(process.execPath, ["scripts/verify-backend-artifacts.mjs", "--source-root", fixture.sourceRoot, "--dist", fixture.distRoot], {
        cwd: join(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true,
      });
      expect(green.status).toBe(0);
      expect(green.stdout).toContain("BACKEND_ARTIFACTS GREEN");
      await rm(join(fixture.distRoot, "main.js"), { force: true });
      const red = spawnSync(process.execPath, ["scripts/verify-backend-artifacts.mjs", "--source-root", fixture.sourceRoot, "--dist-root", fixture.distRoot], {
        cwd: join(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true,
      });
      expect(red.status).toBe(1);
      expect(red.stdout).toContain("BACKEND_ARTIFACTS RED");
      expect(red.stderr).toContain("required output is missing");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
