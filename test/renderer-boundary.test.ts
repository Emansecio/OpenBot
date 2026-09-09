import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const verifier = resolve(workspaceRoot, "scripts/verify-renderer-boundary.mjs");
const temporaryRoots: string[] = [];

const INDEX_PATH = "client/extracted/dist/renderer/index.html";
const ASSETS_PATH = "client/extracted/dist/renderer/assets";
const LOCAL_SETTINGS_PATH = `${ASSETS_PATH}/openbot-local-settings.js`;
const MEMORY_UI_PATH = `${ASSETS_PATH}/openbot-memory-ui.js`;
const WELCOME_MEDIA_PATH = `${ASSETS_PATH}/openbot-welcome-renaissance.png`;
const IMMUTABLE_JS_PATH = `${ASSETS_PATH}/index-a.js`;
const IMMUTABLE_CSS_PATH = `${ASSETS_PATH}/style-a.css`;
const IMMUTABLE_MJS_PATH = `${ASSETS_PATH}/nested/worker-a.mjs`;
const IMMUTABLE_PNG_PATH = `${ASSETS_PATH}/proprietary-image.png`;
const IMMUTABLE_SVG_PATH = `${ASSETS_PATH}/proprietary-vector.svg`;
const IMMUTABLE_JPG_PATH = `${ASSETS_PATH}/proprietary-photo.jpg`;
const IMMUTABLE_WOFF2_PATH = `${ASSETS_PATH}/proprietary-font.woff2`;
const IMMUTABLE_PATHS = [
  INDEX_PATH,
  IMMUTABLE_JS_PATH,
  IMMUTABLE_CSS_PATH,
  IMMUTABLE_MJS_PATH,
  IMMUTABLE_PNG_PATH,
  IMMUTABLE_SVG_PATH,
  IMMUTABLE_JPG_PATH,
  IMMUTABLE_WOFF2_PATH,
];
const BASELINE_PATH = "provenance/renderer-boundary-v1.json";
const BOUNDARY_ALGORITHM = "sha256(sorted-lowercase-posix-relative-path-nul-file-sha256-lf)-v1";

type FixtureManifest = {
  schemaVersion: number;
  artifacts: { [name: string]: { path: string; version: string; sha256: string } };
  renderer: {
    index: { path: string; sha256: string };
    assetsDirectory: string;
    requiredAssets: Array<{ path: string; sha256: string; role: string }>;
    boundary: { schemaVersion: number; algorithm: string; immutableAggregateSha256: string };
  };
};

type FixtureBaseline = {
  schemaVersion: number;
  algorithm: string;
  limitations: string;
  immutableFiles: Array<{ path: string; sha256: string }>;
  permittedOverlays: Array<{ path: string; sha256: string }>;
  permittedMedia: Array<{ path: string; sha256: string }>;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function rendererAssetState(): Array<{ path: string; sha256: string; mtimeMs: number }> {
  const assetsRoot = resolve(workspaceRoot, ASSETS_PATH);
  const state: Array<{ path: string; sha256: string; mtimeMs: number }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        state.push({
          path: normalizePath(path.slice(assetsRoot.length + 1)),
          sha256: sha256(readFileSync(path)),
          mtimeMs: statSync(path).mtimeMs,
        });
      }
    }
  };
  visit(assetsRoot);
  return state.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function writeFixtureFile(root: string, relativePath: string, value: Buffer | string): void {
  const target = resolve(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function immutableAggregate(root: string, paths: string[]): string {
  const lines = paths
    .map((path) => `${normalizePath(path)}\0${sha256(readFileSync(resolve(root, path)))}\n`)
    .sort();
  return sha256(lines.join(""));
}

function createFixture(): {
  root: string;
  manifestPath: string;
  baselinePath: string;
  manifest: FixtureManifest;
  baseline: FixtureBaseline;
} {
  const root = mkdtempSync(join(tmpdir(), "openbot-renderer-boundary-"));
  temporaryRoots.push(root);
  const files = new Map<string, Buffer | string>([
    [INDEX_PATH, "<!doctype html><main>fixture</main>"],
    [IMMUTABLE_JS_PATH, "export const app = 'fixture';\n"],
    [IMMUTABLE_CSS_PATH, ".fixture { color: red; }\n"],
    [IMMUTABLE_MJS_PATH, "export const worker = true;\n"],
    [IMMUTABLE_PNG_PATH, Buffer.from([137, 80, 78, 71, 1])],
    [IMMUTABLE_SVG_PATH, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n"],
    [IMMUTABLE_JPG_PATH, Buffer.from([255, 216, 255, 217])],
    [IMMUTABLE_WOFF2_PATH, Buffer.from("wOF2fixture")],
    [LOCAL_SETTINGS_PATH, "globalThis.openbotSettings = true;\n"],
    [MEMORY_UI_PATH, "globalThis.openbotMemory = true;\n"],
    [WELCOME_MEDIA_PATH, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
  ]);
  for (const [path, value] of files) writeFixtureFile(root, path, value);

  const manifest: FixtureManifest = {
    schemaVersion: 1,
    artifacts: {
      rendererInjected: {
        path: LOCAL_SETTINGS_PATH,
        version: "fixture-v1",
        sha256: sha256(readFileSync(resolve(root, LOCAL_SETTINGS_PATH))),
      },
      rendererMemoryUi: {
        path: MEMORY_UI_PATH,
        version: "fixture-v1",
        sha256: sha256(readFileSync(resolve(root, MEMORY_UI_PATH))),
      },
    },
    renderer: {
      index: { path: INDEX_PATH, sha256: sha256(readFileSync(resolve(root, INDEX_PATH))) },
      assetsDirectory: ASSETS_PATH,
      requiredAssets: [
        { path: IMMUTABLE_JS_PATH, sha256: sha256(readFileSync(resolve(root, IMMUTABLE_JS_PATH))), role: "entry" },
        { path: IMMUTABLE_CSS_PATH, sha256: sha256(readFileSync(resolve(root, IMMUTABLE_CSS_PATH))), role: "style" },
        { path: LOCAL_SETTINGS_PATH, sha256: sha256(readFileSync(resolve(root, LOCAL_SETTINGS_PATH))), role: "injected" },
        { path: MEMORY_UI_PATH, sha256: sha256(readFileSync(resolve(root, MEMORY_UI_PATH))), role: "injected" },
        { path: WELCOME_MEDIA_PATH, sha256: sha256(readFileSync(resolve(root, WELCOME_MEDIA_PATH))), role: "welcome-art" },
      ],
      boundary: {
        schemaVersion: 1,
        algorithm: BOUNDARY_ALGORITHM,
        immutableAggregateSha256: immutableAggregate(root, IMMUTABLE_PATHS),
      },
    },
  };
  const manifestPath = resolve(root, "client/client-artifacts.manifest.json");
  writeFixtureFile(root, "client/client-artifacts.manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const baseline: FixtureBaseline = {
    schemaVersion: 1,
    algorithm: BOUNDARY_ALGORITHM,
    limitations: "Integrity baseline only; authenticity is not proven if verifier and baseline are both changed.",
    immutableFiles: IMMUTABLE_PATHS.map((path) => ({
      path: normalizePath(path),
      sha256: sha256(readFileSync(resolve(root, path))),
    })),
    permittedOverlays: [LOCAL_SETTINGS_PATH, MEMORY_UI_PATH].map((path) => ({
      path,
      sha256: sha256(readFileSync(resolve(root, path))),
    })),
    permittedMedia: [{
      path: WELCOME_MEDIA_PATH,
      sha256: sha256(readFileSync(resolve(root, WELCOME_MEDIA_PATH))),
    }],
  };
  const baselinePath = resolve(root, BASELINE_PATH);
  writeFixtureFile(root, BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  return { root, manifestPath, baselinePath, manifest, baseline };
}

function saveManifest(manifestPath: string, manifest: FixtureManifest): void {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function runVerifier(root: string, manifestPath: string, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [
    verifier,
    "--json",
    "--root",
    root,
    "--manifest",
    manifestPath,
    "--baseline",
    resolve(root, BASELINE_PATH),
    ...extraArgs,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

function reportOf(result: ReturnType<typeof runVerifier>) {
  return JSON.parse(result.stdout) as {
    ok: boolean;
    root: string;
    manifest: string;
    immutableAggregate: { expected: string | null; actual: string | null };
    checkedImmutable: Array<{ path: string; bytes: number; sha256: string }>;
    permittedOverlays: Array<{ path: string; bytes: number; sha256: string }>;
    permittedMedia: Array<{ path: string; bytes: number; sha256: string }>;
    errors: string[];
  };
}

function expectRejected(result: ReturnType<typeof runVerifier>, pattern: RegExp): void {
  expect(result.status).toBe(1);
  const report = reportOf(result);
  expect(report.ok).toBe(false);
  expect(report.errors.some((error) => pattern.test(error))).toBe(true);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("renderer boundary verifier", () => {
  it("accepts exactly the two declared overlays, welcome media, and immutable aggregate", () => {
    const fixture = createFixture();

    const result = runVerifier(fixture.root, fixture.manifestPath);

    expect(result.status).toBe(0);
    const report = reportOf(result);
    expect(report.ok).toBe(true);
    expect(report.immutableAggregate.actual).toBe(report.immutableAggregate.expected);
    expect(report.checkedImmutable).toHaveLength(8);
    expect(report.checkedImmutable.some((entry) => entry.path === INDEX_PATH)).toBe(true);
    expect(report.permittedOverlays.map((entry) => entry.path)).toEqual([LOCAL_SETTINGS_PATH, MEMORY_UI_PATH]);
    expect(report.permittedMedia.map((entry) => entry.path)).toEqual([WELCOME_MEDIA_PATH]);
    expect(report.errors).toEqual([]);
  });

  it("rejects a changed extracted JavaScript chunk", () => {
    const fixture = createFixture();
    writeFixtureFile(fixture.root, IMMUTABLE_JS_PATH, "export const app = 'changed';\n");

    expectRejected(runVerifier(fixture.root, fixture.manifestPath), /immutable aggregate sha256 mismatch/u);
  });

  it("rejects a changed extracted CSS file", () => {
    const fixture = createFixture();
    writeFixtureFile(fixture.root, IMMUTABLE_CSS_PATH, ".fixture { color: blue; }\n");

    expectRejected(runVerifier(fixture.root, fixture.manifestPath), /immutable aggregate sha256 mismatch/u);
  });

  it.each([
    ["PNG", IMMUTABLE_PNG_PATH, "png"],
    ["SVG", IMMUTABLE_SVG_PATH, "svg"],
    ["JPG", IMMUTABLE_JPG_PATH, "jpg"],
    ["WOFF2", IMMUTABLE_WOFF2_PATH, "woff2"],
  ])("closes the proprietary %s path set against mutate, add, and delete", (_label, path, extension) => {
    const mutated = createFixture();
    writeFixtureFile(mutated.root, path, Buffer.from(`mutated-${extension}`));
    expectRejected(runVerifier(mutated.root, mutated.manifestPath), /baseline: sha256 mismatch/u);

    const added = createFixture();
    writeFixtureFile(added.root, `${ASSETS_PATH}/added-static.${extension}`, Buffer.from(`added-${extension}`));
    expectRejected(runVerifier(added.root, added.manifestPath), /baseline: unexpected renderer file/u);

    const deleted = createFixture();
    rmSync(resolve(deleted.root, path));
    expectRejected(runVerifier(deleted.root, deleted.manifestPath), /baseline: missing renderer file/u);
  });

  it("treats index.html as an enumerated immutable renderer file", () => {
    const fixture = createFixture();
    writeFixtureFile(fixture.root, INDEX_PATH, "<!doctype html><main>changed</main>");

    const result = runVerifier(fixture.root, fixture.manifestPath);
    expectRejected(result, /baseline: sha256 mismatch/u);
    expect(reportOf(result).checkedImmutable.some((entry) => entry.path === INDEX_PATH)).toBe(true);
  });

  it("still rejects change, add, and delete when the client-manifest aggregate is updated too", () => {
    const changed = createFixture();
    writeFixtureFile(changed.root, IMMUTABLE_PNG_PATH, Buffer.from("updated-png"));
    changed.manifest.renderer.boundary.immutableAggregateSha256 = immutableAggregate(changed.root, IMMUTABLE_PATHS);
    saveManifest(changed.manifestPath, changed.manifest);
    const changedResult = runVerifier(changed.root, changed.manifestPath);
    expectRejected(changedResult, /baseline: sha256 mismatch/u);
    expect(reportOf(changedResult).errors.some((error) => /client manifest aggregate/u.test(error))).toBe(true);

    const added = createFixture();
    const addedPath = `${ASSETS_PATH}/manifest-updated.png`;
    writeFixtureFile(added.root, addedPath, Buffer.from("added-png"));
    added.manifest.renderer.boundary.immutableAggregateSha256 = immutableAggregate(
      added.root,
      [...IMMUTABLE_PATHS, addedPath],
    );
    saveManifest(added.manifestPath, added.manifest);
    expectRejected(runVerifier(added.root, added.manifestPath), /baseline: unexpected renderer file/u);

    const deleted = createFixture();
    rmSync(resolve(deleted.root, IMMUTABLE_PNG_PATH));
    deleted.manifest.renderer.boundary.immutableAggregateSha256 = immutableAggregate(
      deleted.root,
      IMMUTABLE_PATHS.filter((path) => path !== IMMUTABLE_PNG_PATH),
    );
    saveManifest(deleted.manifestPath, deleted.manifest);
    expectRejected(runVerifier(deleted.root, deleted.manifestPath), /baseline: missing renderer file/u);
  });

  it("rejects any sourcemap and any sourceMappingURL in renderer code", () => {
    const withMap = createFixture();
    writeFixtureFile(withMap.root, `${ASSETS_PATH}/index-a.js.map`, "{}\n");
    expectRejected(runVerifier(withMap.root, withMap.manifestPath), /sourcemaps are forbidden/u);

    const withReference = createFixture();
    writeFixtureFile(withReference.root, IMMUTABLE_MJS_PATH, "export const worker = true;\n//# sourceMappingURL=worker-a.mjs.map\n");
    expectRejected(runVerifier(withReference.root, withReference.manifestPath), /sourceMappingURL is forbidden/u);
  });

  it("rejects undeclared OpenBot files and declared overlays outside the closed allowlist", () => {
    const undeclared = createFixture();
    writeFixtureFile(undeclared.root, `${ASSETS_PATH}/openbot-surprise.js`, "export {};\n");
    expectRejected(runVerifier(undeclared.root, undeclared.manifestPath), /undeclared OpenBot asset is forbidden/u);

    const declared = createFixture();
    const outsideOverlay = `${ASSETS_PATH}/custom-overlay.js`;
    writeFixtureFile(declared.root, outsideOverlay, "export {};\n");
    declared.manifest.renderer.requiredAssets.push({
      path: outsideOverlay,
      sha256: sha256(readFileSync(resolve(declared.root, outsideOverlay))),
      role: "injected",
    });
    declared.manifest.renderer.boundary.immutableAggregateSha256 = immutableAggregate(
      declared.root,
      [...IMMUTABLE_PATHS, outsideOverlay],
    );
    saveManifest(declared.manifestPath, declared.manifest);
    expectRejected(runVerifier(declared.root, declared.manifestPath), /injected overlay is outside the closed allowlist/u);
  });

  it("rejects any additional renderer artifact or declared media outside the closed allowlist", () => {
    const extraArtifact = createFixture();
    const artifactPath = `${ASSETS_PATH}/custom-artifact.js`;
    writeFixtureFile(extraArtifact.root, artifactPath, "export {};\n");
    extraArtifact.manifest.artifacts.customRendererArtifact = {
      path: artifactPath,
      version: "fixture-v1",
      sha256: sha256(readFileSync(resolve(extraArtifact.root, artifactPath))),
    };
    extraArtifact.manifest.renderer.boundary.immutableAggregateSha256 = immutableAggregate(
      extraArtifact.root,
      [...IMMUTABLE_PATHS, artifactPath],
    );
    saveManifest(extraArtifact.manifestPath, extraArtifact.manifest);
    expectRejected(runVerifier(extraArtifact.root, extraArtifact.manifestPath), /renderer artifact is outside the closed allowlist/u);

    const extraMedia = createFixture();
    const mediaPath = `${ASSETS_PATH}/custom-media.png`;
    writeFixtureFile(extraMedia.root, mediaPath, Buffer.from([1, 2, 3]));
    extraMedia.manifest.renderer.requiredAssets.push({
      path: mediaPath,
      sha256: sha256(readFileSync(resolve(extraMedia.root, mediaPath))),
      role: "welcome-art",
    });
    saveManifest(extraMedia.manifestPath, extraMedia.manifest);
    expectRejected(runVerifier(extraMedia.root, extraMedia.manifestPath), /declared media is outside the closed allowlist/u);
  });

  it("rejects entry and style requiredAssets outside the strict renderer assets directory", () => {
    const repositoryOutside = createFixture();
    const outsideEntry = "scripts/fake-entry.js";
    writeFixtureFile(repositoryOutside.root, outsideEntry, "export {};\n");
    repositoryOutside.manifest.renderer.requiredAssets.push({
      path: outsideEntry,
      sha256: sha256(readFileSync(resolve(repositoryOutside.root, outsideEntry))),
      role: "entry",
    });
    saveManifest(repositoryOutside.manifestPath, repositoryOutside.manifest);
    expectRejected(
      runVerifier(repositoryOutside.root, repositoryOutside.manifestPath),
      /required asset path must be strictly inside renderer assetsDirectory/u,
    );

    const siblingPrefix = createFixture();
    const siblingStyle = "client/extracted/dist/renderer/assets-sibling/fake-style.css";
    writeFixtureFile(siblingPrefix.root, siblingStyle, ".fake {}\n");
    siblingPrefix.manifest.renderer.requiredAssets.push({
      path: siblingStyle,
      sha256: sha256(readFileSync(resolve(siblingPrefix.root, siblingStyle))),
      role: "style",
    });
    saveManifest(siblingPrefix.manifestPath, siblingPrefix.manifest);
    expectRejected(
      runVerifier(siblingPrefix.root, siblingPrefix.manifestPath),
      /required asset path must be strictly inside renderer assetsDirectory/u,
    );

    const traversal = createFixture();
    const traversalPath = `${ASSETS_PATH}/../fake-entry.js`;
    writeFixtureFile(traversal.root, "client/extracted/dist/renderer/fake-entry.js", "export {};\n");
    traversal.manifest.renderer.requiredAssets.push({
      path: traversalPath,
      sha256: sha256(readFileSync(resolve(traversal.root, traversalPath))),
      role: "entry",
    });
    saveManifest(traversal.manifestPath, traversal.manifest);
    expectRejected(
      runVerifier(traversal.root, traversal.manifestPath),
      /required asset path must be strictly inside renderer assetsDirectory/u,
    );
  });

  it("rejects manifest and renderer paths that escape the selected root", () => {
    const fixture = createFixture();
    const outsideRoot = mkdtempSync(join(tmpdir(), "openbot-renderer-outside-"));
    temporaryRoots.push(outsideRoot);
    const outsideManifest = resolve(outsideRoot, "manifest.json");
    writeFileSync(outsideManifest, JSON.stringify(fixture.manifest), "utf8");
    expectRejected(runVerifier(fixture.root, outsideManifest), /manifest: path escapes repository root/u);

    fixture.manifest.renderer.assetsDirectory = "../outside";
    saveManifest(fixture.manifestPath, fixture.manifest);
    expectRejected(runVerifier(fixture.root, fixture.manifestPath), /renderer\.assetsDirectory: path/u);
  });

  it("rejects unknown, duplicate, missing-value, and ambiguous positional CLI input", () => {
    const fixture = createFixture();
    expectRejected(runVerifier(fixture.root, fixture.manifestPath, ["--unknown"]), /CLI: unknown option/u);
    expectRejected(runVerifier(fixture.root, fixture.manifestPath, ["--json"]), /--json may be specified only once/u);
    expectRejected(runVerifier(fixture.root, fixture.manifestPath, ["--root"]), /--root may be specified only once|--root requires a value/u);
    expectRejected(runVerifier(fixture.root, fixture.manifestPath, ["one.json", "two.json"]), /positional manifest path|either --manifest/u);
  });

  it("fails closed for missing or empty lists and malformed hashes, paths, and roles", () => {
    const emptyAssets = createFixture();
    emptyAssets.manifest.renderer.requiredAssets = [];
    saveManifest(emptyAssets.manifestPath, emptyAssets.manifest);
    expectRejected(runVerifier(emptyAssets.root, emptyAssets.manifestPath), /requiredAssets: must be a non-empty array/u);

    const missingArtifacts = createFixture();
    missingArtifacts.manifest.artifacts = {};
    saveManifest(missingArtifacts.manifestPath, missingArtifacts.manifest);
    expectRejected(runVerifier(missingArtifacts.root, missingArtifacts.manifestPath), /manifest\.artifacts: must be a non-empty object/u);

    const malformed = createFixture();
    malformed.manifest.renderer.requiredAssets[0]!.sha256 = "ABC";
    malformed.manifest.renderer.requiredAssets[1]!.path = "";
    malformed.manifest.renderer.requiredAssets[2]!.role = "overlay-ish";
    saveManifest(malformed.manifestPath, malformed.manifest);
    const malformedResult = runVerifier(malformed.root, malformed.manifestPath);
    expectRejected(malformedResult, /sha256 must be 64 lowercase hexadecimal/u);
    expect(reportOf(malformedResult).errors.some((error) => /path must be a non-empty repository-relative path/u.test(error))).toBe(true);
    expect(reportOf(malformedResult).errors.some((error) => /role is not allowed/u.test(error))).toBe(true);
  });

  it("rejects duplicate required-asset paths and hashes", () => {
    const fixture = createFixture();
    fixture.manifest.renderer.requiredAssets.push({ ...fixture.manifest.renderer.requiredAssets[0]! });
    saveManifest(fixture.manifestPath, fixture.manifest);

    const result = runVerifier(fixture.root, fixture.manifestPath);
    expectRejected(result, /duplicate path declaration/u);
    expect(reportOf(result).errors.some((error) => /duplicate sha256 declaration/u.test(error))).toBe(true);
  });

  it("makes add, delete, and modify operations observable in the aggregate", () => {
    const added = createFixture();
    writeFixtureFile(added.root, `${ASSETS_PATH}/added.js`, "export {};\n");
    expectRejected(runVerifier(added.root, added.manifestPath), /immutable aggregate sha256 mismatch/u);

    const deleted = createFixture();
    rmSync(resolve(deleted.root, IMMUTABLE_MJS_PATH));
    expectRejected(runVerifier(deleted.root, deleted.manifestPath), /immutable aggregate sha256 mismatch/u);

    const modified = createFixture();
    writeFixtureFile(modified.root, IMMUTABLE_MJS_PATH, "export const worker = false;\n");
    expectRejected(runVerifier(modified.root, modified.manifestPath), /immutable aggregate sha256 mismatch/u);
  });

  it("rejects a linked root and a linked renderer subtree without following either", () => {
    const linkedRootFixture = createFixture();
    const linkParent = mkdtempSync(join(tmpdir(), "openbot-renderer-link-"));
    temporaryRoots.push(linkParent);
    const rootLink = resolve(linkParent, "root-link");
    symlinkSync(linkedRootFixture.root, rootLink, process.platform === "win32" ? "junction" : "dir");
    expectRejected(runVerifier(rootLink, resolve(rootLink, "client/client-artifacts.manifest.json")), /root: symbolic links and junctions are not allowed/u);

    const parentLink = resolve(linkParent, "parent-link");
    symlinkSync(dirname(linkedRootFixture.root), parentLink, process.platform === "win32" ? "junction" : "dir");
    const nestedLinkedRoot = resolve(parentLink, basename(linkedRootFixture.root));
    const nestedRootResult = spawnSync(process.execPath, [verifier, "--json", "--root", nestedLinkedRoot], {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    expectRejected(nestedRootResult, /root: symbolic links and junctions are not allowed/u);

    const subtreeFixture = createFixture();
    const outside = mkdtempSync(join(tmpdir(), "openbot-renderer-link-target-"));
    temporaryRoots.push(outside);
    writeFileSync(resolve(outside, "escaped.js"), "export {};\n", "utf8");
    symlinkSync(outside, resolve(subtreeFixture.root, ASSETS_PATH, "linked"), process.platform === "win32" ? "junction" : "dir");
    expectRejected(runVerifier(subtreeFixture.root, subtreeFixture.manifestPath), /symbolic links and junctions are not allowed/u);
  });

  it("rejects a declared renderer file replaced by a symlink even when bytes match", () => {
    const fixture = createFixture();
    const outside = mkdtempSync(join(tmpdir(), "openbot-renderer-file-link-target-"));
    temporaryRoots.push(outside);
    const outsideFile = resolve(outside, "proprietary-image.png");
    copyFileSync(resolve(fixture.root, IMMUTABLE_PNG_PATH), outsideFile);
    rmSync(resolve(fixture.root, IMMUTABLE_PNG_PATH));
    symlinkSync(outsideFile, resolve(fixture.root, IMMUTABLE_PNG_PATH), "file");

    expectRejected(runVerifier(fixture.root, fixture.manifestPath), /symbolic links and junctions are not allowed/u);
  });

  it("returns one JSON failure and no stderr for numerically typed manifest paths", () => {
    const fixture = createFixture();
    const malformed = fixture.manifest as unknown as {
      renderer: { index: { path: unknown }; assetsDirectory: unknown };
      artifacts: { rendererInjected: { path: unknown } };
    };
    malformed.renderer.index.path = 42;
    malformed.renderer.assetsDirectory = 43;
    malformed.artifacts.rendererInjected.path = 44;
    writeFileSync(fixture.manifestPath, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");

    const result = runVerifier(fixture.root, fixture.manifestPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
    expect(() => reportOf(result)).not.toThrow();
    expect(reportOf(result).errors.some((error) => /path must be a non-empty repository-relative path/u.test(error))).toBe(true);
  });

  it("stops the operational visual gate immediately when the renderer boundary fails", () => {
    const fixture = createFixture();
    writeFixtureFile(fixture.root, IMMUTABLE_PNG_PATH, Buffer.from("boundary-failure"));
    writeFixtureFile(
      fixture.root,
      "scripts/verify-renderer-boundary.mjs",
      readFileSync(verifier),
    );
    const visualGate = resolve(workspaceRoot, "scripts/verify-visual-ui-gate.mjs");

    const result = spawnSync(process.execPath, [visualGate, "--artifacts-only"], {
      cwd: workspaceRoot,
      env: { ...process.env, OPENBOT_ROOT: fixture.root },
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VISUAL_UI_GATE renderer-boundary");
    expect(result.stdout).not.toContain("VISUAL_UI_GATE client-artifacts");
    expect(result.stdout).not.toContain("VISUAL_UI_GATE visual-ui");
  });

  it("emits one deterministic machine JSON object without absolute root leakage", () => {
    const fixture = createFixture();
    const result = runVerifier(fixture.root, fixture.manifestPath);
    const repeatedResult = runVerifier(fixture.root, fixture.manifestPath);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
    const report = reportOf(result);
    expect(report).toEqual(expect.objectContaining({
      ok: true,
      root: ".",
      manifest: "client/client-artifacts.manifest.json",
      immutableAggregate: expect.objectContaining({ expected: expect.any(String), actual: expect.any(String) }),
      checkedImmutable: expect.any(Array),
      permittedOverlays: expect.any(Array),
      errors: [],
    }));
    expect(result.stdout).not.toContain(fixture.root);
    expect(repeatedResult.status).toBe(0);
    expect(repeatedResult.stderr).toBe("");
    expect(repeatedResult.stdout).toBe(result.stdout);
  });

  it("passes against the checked-in renderer without modifying its assets", () => {
    const before = rendererAssetState();
    const result = spawnSync(process.execPath, [verifier, "--json"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    const report = reportOf(result);
    expect(report.ok).toBe(true);
    expect(report.checkedImmutable.length).toBeGreaterThan(100);
    expect(report.permittedOverlays).toHaveLength(2);
    expect(report.permittedMedia).toHaveLength(1);
    expect(rendererAssetState()).toEqual(before);
  });

  it("records the independent baseline's residual authenticity limitation", () => {
    const baseline = JSON.parse(readFileSync(resolve(workspaceRoot, BASELINE_PATH), "utf8")) as {
      limitations: string;
      immutableFiles: unknown[];
      permittedOverlays: unknown[];
      permittedMedia: unknown[];
    };

    expect(baseline.limitations).toMatch(/does not prove origin or authenticity/iu);
    expect(baseline.limitations).toMatch(/both the verifier and this baseline/iu);
    expect(baseline.immutableFiles).toHaveLength(135);
    expect(baseline.permittedOverlays).toHaveLength(2);
    expect(baseline.permittedMedia).toHaveLength(1);
  });

  it("wires the boundary before client artifacts and any real visual launch", () => {
    const packageJson = JSON.parse(readFileSync(resolve(workspaceRoot, "package.json"), "utf8")) as {
      scripts: { [name: string]: string };
    };
    expect(packageJson.scripts["verify:renderer-boundary"]).toBe("node scripts/verify-renderer-boundary.mjs --json");

    const visualGate = readFileSync(resolve(workspaceRoot, "scripts/verify-visual-ui-gate.mjs"), "utf8");
    const boundary = visualGate.indexOf('run("renderer-boundary"');
    const artifacts = visualGate.indexOf('run("client-artifacts"');
    const visual = visualGate.indexOf('run("visual-ui"');
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(boundary).toBeLessThan(artifacts);
    expect(artifacts).toBeLessThan(visual);
  });
});
