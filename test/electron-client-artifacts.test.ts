import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"));
const manifestPath = resolve(root, "client/client-artifacts.manifest.json");
type Artifact = { path: string; sha256: string; version: string; sourceMap?: { status: string; reference?: string } };
type ClientArtifactManifest = {
  artifacts: { main: Artifact; preload: Artifact; rendererInjected: Artifact; [name: string]: Artifact };
  renderer: { requiredAssets: Array<{ path: string; sha256: string; role: string }> };
};
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ClientArtifactManifest;

function verify(args: string[] = []) {
  return spawnSync(process.execPath, ["scripts/verify-client-artifacts.mjs", "--json", ...args], {
    cwd: root,
    env: { ...process.env, OPENBOT_ROOT: root },
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("Electron client artifact baseline", () => {
  it("records versioned hashes for the launcher inputs and renderer overlay", () => {
    expect(manifest.artifacts.main.version).toBe("0.16.0");
    expect(manifest.artifacts.preload.version).toBe("0.16.0");
    expect(manifest.artifacts.rendererInjected.version).toBe("openbot-local-settings-v35-header-border");
    expect(manifest.artifacts.rendererMemoryUi).toMatchObject({
      path: "client/extracted/dist/renderer/assets/openbot-memory-ui.js",
      version: "openbot-memory-ui-v8-shared-profile",
    }); // Change only with an intentional renderer overlay baseline update.
    for (const artifact of Object.values(manifest.artifacts)) expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
    for (const asset of manifest.renderer.requiredAssets) expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("passes the deterministic artifact verifier", () => {
    const result = verify();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { ok: boolean; checks: unknown[]; errors: string[] };
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(8);
    expect(report.errors).toEqual([]);
  });

  it("rejects a changed baseline hash without touching the client files", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "openbot-client-artifact-test-"));
    try {
      const altered = JSON.parse(JSON.stringify(manifest)) as ClientArtifactManifest;
      altered.artifacts.main.sha256 = "0".repeat(64);
      const alteredManifest = join(temporaryRoot, "manifest.json");
      writeFileSync(alteredManifest, JSON.stringify(altered), "utf8");
      const result = verify(["--manifest", alteredManifest]);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { ok: boolean; errors: string[] };
      expect(report.ok).toBe(false);
      expect(report.errors.some((error) => error.includes("artifact:main: sha256 mismatch"))).toBe(true);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a baseline version that drifts from the client version", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "openbot-client-version-test-"));
    try {
      const altered = JSON.parse(JSON.stringify(manifest)) as ClientArtifactManifest;
      altered.artifacts.main.version = "9.9.9";
      const alteredManifest = join(temporaryRoot, "manifest.json");
      writeFileSync(alteredManifest, JSON.stringify(altered), "utf8");
      const result = verify(["--manifest", alteredManifest]);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { ok: boolean; errors: string[] };
      expect(report.ok).toBe(false);
      expect(report.errors.some((error) => error.includes("artifact:main: version 9.9.9 does not match clientVersion 0.16.0"))).toBe(true);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("removes stale source-map references while retaining maps as evidence", () => {
    const main = readFileSync(resolve(root, manifest.artifacts.main.path), "utf8");
    const preload = readFileSync(resolve(root, manifest.artifacts.preload.path), "utf8");
    expect(manifest.artifacts.main.sourceMap).toMatchObject({ status: "removed" });
    expect(manifest.artifacts.preload.sourceMap).toMatchObject({ status: "removed" });
    expect(main).not.toContain("sourceMappingURL=main.cjs.map");
    expect(preload).not.toContain("sourceMappingURL=preload.cjs.map");
    expect(existsSync(resolve(root, "client/extracted/dist/electron-main/main.cjs.map"))).toBe(true);
    expect(existsSync(resolve(root, "client/extracted/dist/electron-preload/preload.cjs.map"))).toBe(true);
  });

  it("protects the launcher preflight and visual gate", () => {
    const launcher = readFileSync(resolve(root, "scripts/openbot-desktop.cmd"), "utf8");
    expect(launcher).toContain('scripts\\verify-client-artifacts.mjs"');
    expect(launcher).toMatch(/verify-client-artifacts\.mjs[\s\S]{0,160}if errorlevel 1/);
    const visualGate = readFileSync(resolve(root, "scripts/verify-visual-ui-gate.mjs"), "utf8");
    const boundary = visualGate.indexOf('run("renderer-boundary"');
    const artifacts = visualGate.indexOf('run("client-artifacts"');
    const visual = visualGate.indexOf('run("visual-ui"');
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(boundary).toBeLessThan(artifacts);
    expect(artifacts).toBeLessThan(visual);
  });

  it("can run the gate's artifact phase without launching Electron", () => {
    const result = spawnSync(process.execPath, ["scripts/verify-visual-ui-gate.mjs", "--artifacts-only"], {
      cwd: root,
      env: { ...process.env, OPENBOT_ROOT: root },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VISUAL_UI_GATE GREEN (artifacts-only)");
  });

  it("parses all artifact gate scripts as Node modules", () => {
    for (const script of ["scripts/verify-client-artifacts.mjs", "scripts/verify-visual-ui-gate.mjs"]) {
      expect(() => execFileSync(process.execPath, ["--check", script], { cwd: root, windowsHide: true })).not.toThrow();
    }
  });
});
