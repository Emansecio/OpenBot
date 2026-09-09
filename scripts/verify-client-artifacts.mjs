import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, "..");
const defaultManifest = join(defaultRoot, "client", "client-artifacts.manifest.json");
const argv = process.argv.slice(2);
const jsonOutput = argv.includes("--json");

function optionValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${candidate.includes("\\") ? "\\" : "/"}`) && !isAbsolute(rel));
}

function displayPath(root, file) {
  const rel = relative(root, file);
  return rel || ".";
}

function readJson(file, label, errors) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function collectSourceMapReferences(root, directories) {
  const files = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && [".cjs", ".js", ".mjs", ".css"].includes(extname(entry.name).toLowerCase())) {
        let text;
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const match = text.match(/sourceMappingURL=([^\s*]+)/u);
        if (match) files.push({ file, reference: match[1] });
      }
    }
  };
  for (const directory of directories) visit(resolve(root, directory));
  return files;
}

function verifyFile(root, fileEntry, label, errors, checks) {
  if (!fileEntry || typeof fileEntry !== "object" || typeof fileEntry.path !== "string") {
    errors.push(`${label}: manifest entry is missing a path`);
    return null;
  }
  const file = resolve(root, fileEntry.path);
  if (!isPathInside(root, file)) {
    errors.push(`${label}: path escapes repository root`);
    return null;
  }
  let metadata;
  try {
    metadata = statSync(file);
  } catch {
    errors.push(`${label}: file is missing (${fileEntry.path})`);
    return null;
  }
  if (!metadata.isFile()) {
    errors.push(`${label}: path is not a file (${fileEntry.path})`);
    return null;
  }
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    errors.push(`${label}: cannot read file (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
  const actualSha256 = sha256(bytes);
  if (!isSha256(fileEntry.sha256)) errors.push(`${label}: manifest sha256 is invalid`);
  else if (actualSha256 !== fileEntry.sha256) errors.push(`${label}: sha256 mismatch (expected ${fileEntry.sha256}, got ${actualSha256})`);
  checks.push({ label, path: fileEntry.path, bytes: bytes.byteLength, sha256: actualSha256 });
  return { file, bytes, metadata };
}

function verifySourceMap(root, artifact, artifactFile, label, errors, warnings) {
  const sourceMap = artifact?.sourceMap;
  if (!sourceMap || typeof sourceMap !== "object" || typeof sourceMap.status !== "string") {
    errors.push(`${label}: source-map policy is missing`);
    return;
  }
  const text = artifactFile.bytes.toString("utf8");
  const match = text.match(/sourceMappingURL=([^\s*]+)/u);
  const reference = match?.[1];
  if (reference && sourceMap.status === "not-applicable") {
    errors.push(`${label}: source-map reference exists but policy is not-applicable`);
    return;
  }
  if (reference) {
    if (sourceMap.reference !== reference) errors.push(`${label}: source-map reference is not declared in the manifest`);
    if (typeof sourceMap.path !== "string") {
      errors.push(`${label}: referenced source map has no manifest path`);
      return;
    }
    const expectedMap = resolve(root, sourceMap.path);
    const referencedMap = resolve(dirname(artifactFile.file), reference);
    if (!isPathInside(root, expectedMap) || expectedMap !== referencedMap) {
      errors.push(`${label}: source-map path does not match the artifact reference`);
      return;
    }
    let mapMetadata;
    try {
      mapMetadata = statSync(expectedMap);
    } catch {
      errors.push(`${label}: referenced source map is missing (${sourceMap.path})`);
      return;
    }
    if (!mapMetadata.isFile()) {
      errors.push(`${label}: referenced source map is not a file (${sourceMap.path})`);
      return;
    }
    if (!["verified", "intentionally-stale"].includes(sourceMap.status)) {
      errors.push(`${label}: unsupported source-map status ${sourceMap.status}`);
      return;
    }
    if (sourceMap.status === "intentionally-stale") {
      if (typeof sourceMap.reason !== "string" || sourceMap.reason.trim().length === 0) errors.push(`${label}: intentionally-stale source map requires a reason`);
      else warnings.push(`${label}: source map is intentionally stale (${sourceMap.reason})`);
    }
    if (artifactFile.metadata.mtimeMs > mapMetadata.mtimeMs + 1000 && sourceMap.status !== "intentionally-stale") {
      errors.push(`${label}: artifact is newer than its source map; mark the map intentionally-stale or rebuild it`);
    }
    return;
  }
  if (!["removed", "not-applicable", "intentionally-stale"].includes(sourceMap.status)) {
    errors.push(`${label}: source-map policy says ${sourceMap.status}, but the artifact has no source-map reference`);
  }
  if (sourceMap.status === "removed") {
    if (sourceMap.reference) errors.push(`${label}: removed source-map policy must not keep a source-map reference`);
    if (typeof sourceMap.path === "string") {
      const retainedMap = resolve(root, sourceMap.path);
      if (!isPathInside(root, retainedMap)) errors.push(`${label}: retained source-map path escapes repository root`);
      else if (existsSync(retainedMap)) warnings.push(`${label}: stale source map retained without a runtime reference`);
    }
  }
  if (sourceMap.status === "intentionally-stale") {
    if (typeof sourceMap.reason !== "string" || sourceMap.reason.trim().length === 0) errors.push(`${label}: intentionally-stale source map requires a reason`);
    else warnings.push(`${label}: source map reference is absent and the stale map is explicitly retained`);
  }
}

function verifyManifest({ root, manifestFile }) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const manifest = readJson(manifestFile, "client artifact manifest", errors);
  if (!manifest) return { ok: false, root, manifest: displayPath(root, manifestFile), clientVersion: null, checks, warnings, errors };
  if (manifest.schemaVersion !== 1) errors.push("client artifact manifest: unsupported schemaVersion");
  if (typeof manifest.manifestVersion !== "string" || manifest.manifestVersion.trim() === "") errors.push("client artifact manifest: manifestVersion is missing");
  if (typeof manifest.clientVersion !== "string" || manifest.clientVersion.trim() === "") errors.push("client artifact manifest: clientVersion is missing");
  if (manifest.canonicalRoot !== "client/extracted/dist") errors.push("client artifact manifest: canonicalRoot must be client/extracted/dist");
  if (!manifest.source || manifest.source.kind !== "explicit-manifest") errors.push("client artifact manifest: source.kind must be explicit-manifest");

  const packageFile = manifest.source?.package ? resolve(root, manifest.source.package) : null;
  if (!packageFile || !isPathInside(root, packageFile)) errors.push("client artifact manifest: source.package escapes repository root");
  else {
    const packageMetadata = verifyFile(root, { path: manifest.source.package, sha256: manifest.source.packageSha256 }, "client package", errors, checks);
    if (packageMetadata) {
      const packageJson = readJson(packageFile, "client package.json", errors);
      if (packageJson && packageJson.version !== manifest.clientVersion) errors.push(`client package: version ${packageJson.version} does not match ${manifest.clientVersion}`);
    }
  }

  const artifactEntries = manifest.artifacts && typeof manifest.artifacts === "object" ? manifest.artifacts : {};
  const verifiedArtifacts = new Map();
  for (const [name, artifact] of Object.entries(artifactEntries)) {
    const label = `artifact:${name}`;
    const result = verifyFile(root, artifact, label, errors, checks);
    if (result) {
      verifiedArtifacts.set(resolve(result.file), { artifact, result, label });
      verifySourceMap(root, artifact, result, label, errors, warnings);
    }
    if (!artifact || typeof artifact.version !== "string" || artifact.version.trim() === "") errors.push(`${label}: version is missing`);
    else if (["main", "preload"].includes(name) && artifact.version !== manifest.clientVersion) {
      errors.push(`${label}: version ${artifact.version} does not match clientVersion ${manifest.clientVersion}`);
    }
  }
  for (const name of ["main", "preload", "rendererInjected"]) {
    if (!artifactEntries[name]) errors.push(`artifact:${name}: required baseline entry is missing`);
  }

  const renderer = manifest.renderer && typeof manifest.renderer === "object" ? manifest.renderer : null;
  if (!renderer) errors.push("renderer: manifest entry is missing");
  else {
    const index = verifyFile(root, renderer.index, "renderer:index", errors, checks);
    if (index) {
      const indexText = index.bytes.toString("utf8");
      const references = [...indexText.matchAll(/(?:src|href)=["']([^"']+)["']/gu)].map((match) => match[1]);
      for (const reference of references) {
        if (/^(?:[a-z]+:|\/\/|#)/iu.test(reference)) continue;
        const referencedFile = resolve(dirname(index.file), reference);
        if (!isPathInside(root, referencedFile) || !existsSync(referencedFile)) errors.push(`renderer:index: referenced asset is missing (${reference})`);
      }
    }
    if (typeof renderer.assetsDirectory !== "string") errors.push("renderer: assetsDirectory is missing");
    else {
      const assetsDirectory = resolve(root, renderer.assetsDirectory);
      if (!isPathInside(root, assetsDirectory) || !existsSync(assetsDirectory)) errors.push(`renderer: assets directory is missing (${renderer.assetsDirectory})`);
      else if (!statSync(assetsDirectory).isDirectory()) errors.push(`renderer: assetsDirectory is not a directory (${renderer.assetsDirectory})`);
      else if (readdirSync(assetsDirectory).length === 0) errors.push("renderer: assets directory is empty");
    }
    if (!Array.isArray(renderer.requiredAssets) || renderer.requiredAssets.length === 0) errors.push("renderer: requiredAssets is missing");
    else {
      for (const [index, asset] of renderer.requiredAssets.entries()) {
        const result = verifyFile(root, asset, `renderer:asset[${index}]`, errors, checks);
        if (result && typeof asset.role !== "string") errors.push(`renderer:asset[${index}]: role is missing`);
      }
    }
  }

  const patchMetadataPath = typeof manifest.patchMetadata === "string" ? resolve(root, manifest.patchMetadata) : null;
  const patchMetadata = patchMetadataPath && isPathInside(root, patchMetadataPath) ? readJson(patchMetadataPath, "patch metadata", errors) : null;
  if (!patchMetadataPath || !isPathInside(root, patchMetadataPath)) errors.push("client artifact manifest: patchMetadata escapes repository root");
  else if (patchMetadata && patchMetadata.manifest !== displayPath(root, manifestFile).replaceAll("\\", "/")) warnings.push("patch metadata points to a different manifest path");
  if (patchMetadata && patchMetadata.sourceMapPolicy && manifest.artifacts) {
    for (const artifact of Object.values(manifest.artifacts)) {
      const sourceMapStatus = artifact?.sourceMap?.status;
      if (["intentionally-stale", "removed"].includes(sourceMapStatus) && patchMetadata.sourceMapPolicy[artifact.path] !== sourceMapStatus) {
        errors.push(`patch metadata: ${sourceMapStatus} source-map policy is missing for ${artifact.path}`);
      }
    }
  }

  // main.cjs and preload.cjs are checked above. The auxiliary Electron
  // preload bundles are not launcher inputs, so only scan the renderer asset
  // tree for additional source-map references that would otherwise be easy to
  // leave stale or untracked.
  const mapDirectories = ["client/extracted/dist/renderer/assets"];
  for (const reference of collectSourceMapReferences(root, mapDirectories)) {
    const artifactInfo = verifiedArtifacts.get(resolve(reference.file));
    if (!artifactInfo) {
      errors.push(`source map reference is not covered by the manifest (${displayPath(root, reference.file)})`);
      continue;
    }
    const declared = artifactInfo.artifact.sourceMap;
    if (!declared || declared.reference !== reference.reference) errors.push(`source map reference is not declared for ${displayPath(root, reference.file)}`);
  }

  return {
    ok: errors.length === 0,
    root,
    manifest: displayPath(root, manifestFile).replaceAll("\\", "/"),
    clientVersion: manifest.clientVersion ?? null,
    checks,
    warnings,
    errors,
  };
}

const root = resolve(process.env.OPENBOT_ROOT || defaultRoot);
const manifestOption = optionValue("--manifest") || process.env.OPENBOT_CLIENT_ARTIFACT_MANIFEST;
const manifestFile = resolve(root, manifestOption || defaultManifest);
const result = verifyManifest({ root, manifestFile });

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`CLIENT_ARTIFACTS ${result.ok ? "GREEN" : "RED"}`);
  console.log(`manifest=${result.manifest}`);
  if (result.clientVersion) console.log(`clientVersion=${result.clientVersion}`);
  for (const warning of result.warnings) console.warn(`WARN ${warning}`);
  for (const error of result.errors) console.error(`ERROR ${error}`);
  if (result.ok) console.log(`checks=${result.checks.length}`);
}

process.exitCode = result.ok ? 0 : 1;
