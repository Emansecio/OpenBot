import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, "..");
const DEFAULT_MANIFEST_PATH = "client/client-artifacts.manifest.json";
const DEFAULT_BASELINE_PATH = "provenance/renderer-boundary-v1.json";
const RENDERER_PATH = "client/extracted/dist/renderer";
const INDEX_PATH = `${RENDERER_PATH}/index.html`;
const ASSETS_PATH = "client/extracted/dist/renderer/assets";
const LOCAL_SETTINGS_PATH = `${ASSETS_PATH}/openbot-local-settings.js`;
const MEMORY_UI_PATH = `${ASSETS_PATH}/openbot-memory-ui.js`;
const WELCOME_MEDIA_PATH = `${ASSETS_PATH}/openbot-welcome-renaissance.png`;
const PERMITTED_OVERLAY_PATHS = [LOCAL_SETTINGS_PATH, MEMORY_UI_PATH];
const PERMITTED_OPENBOT_PATHS = new Set([...PERMITTED_OVERLAY_PATHS, WELCOME_MEDIA_PATH]);
const IMMUTABLE_EXTENSIONS = new Set([".js", ".mjs", ".css"]);
const REQUIRED_ASSET_ROLES = new Set(["entry", "style", "injected", "welcome-art"]);
const BOUNDARY_ALGORITHM = "sha256(sorted-lowercase-posix-relative-path-nul-file-sha256-lf)-v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function normalizeManifestPath(value) {
  return isNonEmptyString(value) ? normalizeRelativePath(value) : null;
}

function isContained(base, candidate) {
  const rel = relative(base, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function hasLinkedAncestor(candidate) {
  const filesystemRoot = parse(candidate).root;
  let current = filesystemRoot;
  for (const segment of relative(filesystemRoot, candidate).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function parseCliArgs(argv) {
  const errors = [];
  const values = { root: undefined, manifest: undefined, baseline: undefined, positional: undefined };
  let jsonSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (jsonSeen) errors.push("CLI: --json may be specified only once");
      jsonSeen = true;
      continue;
    }
    if (argument === "--root" || argument === "--manifest" || argument === "--baseline") {
      const key = argument.slice(2);
      if (values[key] !== undefined) errors.push(`CLI: ${argument} may be specified only once`);
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) {
        errors.push(`CLI: ${argument} requires a value`);
      } else {
        if (values[key] === undefined) values[key] = candidate;
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("-")) {
      errors.push("CLI: unknown option");
      continue;
    }
    if (values.positional !== undefined) errors.push("CLI: at most one positional manifest path is allowed");
    else values.positional = argument;
  }
  if (values.manifest !== undefined && values.positional !== undefined) {
    errors.push("CLI: use either --manifest or one positional manifest path, not both");
  }
  return {
    errors,
    rootInput: values.root,
    manifestInput: values.manifest ?? values.positional,
    baselineInput: values.baseline,
  };
}

function safeRoot(rootInput, errors) {
  const candidate = resolve(rootInput ?? defaultRoot);
  try {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || hasLinkedAncestor(candidate)) {
      errors.push("root: symbolic links and junctions are not allowed");
      return null;
    }
    if (!metadata.isDirectory()) {
      errors.push("root: must be an existing directory");
      return null;
    }
    return realpathSync.native(candidate);
  } catch {
    errors.push("root: must be an existing directory");
    return null;
  }
}

function hasLinkedSegment(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === "") return lstatSync(candidate).isSymbolicLink();
  let current = root;
  for (const segment of rel.split(sep)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function safeExistingPath(root, pathValue, label, errors, expectedKind = "file") {
  if (!isNonEmptyString(pathValue) || isAbsolute(pathValue) || pathValue.includes("\0")) {
    errors.push(`${label}: path must be a non-empty repository-relative path`);
    return null;
  }
  const candidate = resolve(root, pathValue);
  if (!isContained(root, candidate)) {
    errors.push(`${label}: path escapes repository root`);
    return null;
  }
  try {
    const metadata = lstatSync(candidate);
    if (hasLinkedSegment(root, candidate)) {
      errors.push(`${label}: symbolic links and junctions are not allowed`);
      return null;
    }
    if (expectedKind === "file" && !metadata.isFile()) {
      errors.push(`${label}: path is not a file`);
      return null;
    }
    if (expectedKind === "directory" && !metadata.isDirectory()) {
      errors.push(`${label}: path is not a directory`);
      return null;
    }
    const realCandidate = realpathSync.native(candidate);
    if (!isContained(root, realCandidate)) {
      errors.push(`${label}: real path escapes repository root`);
      return null;
    }
    return realCandidate;
  } catch {
    errors.push(`${label}: path does not exist`);
    return null;
  }
}

function readManifest(root, manifestInput, errors) {
  const input = manifestInput ?? DEFAULT_MANIFEST_PATH;
  let candidate;
  if (typeof input !== "string" || input.length === 0) {
    errors.push("manifest: path must be non-empty");
    return { manifest: null, manifestDisplay: "[invalid]" };
  }
  candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!isContained(root, candidate)) {
    errors.push("manifest: path escapes repository root");
    return { manifest: null, manifestDisplay: "[invalid]" };
  }
  let manifestDisplay = normalizeRelativePath(relative(root, candidate));
  try {
    if (hasLinkedSegment(root, candidate)) {
      errors.push("manifest: symbolic links and junctions are not allowed");
      return { manifest: null, manifestDisplay };
    }
    const metadata = lstatSync(candidate);
    if (!metadata.isFile()) {
      errors.push("manifest: path is not a file");
      return { manifest: null, manifestDisplay };
    }
    const realCandidate = realpathSync.native(candidate);
    if (!isContained(root, realCandidate)) {
      errors.push("manifest: real path escapes repository root");
      return { manifest: null, manifestDisplay };
    }
    const parsed = JSON.parse(readFileSync(realCandidate, "utf8"));
    return { manifest: parsed, manifestDisplay };
  } catch (error) {
    const reason = error instanceof SyntaxError ? "is not valid JSON" : "path does not exist or cannot be read";
    errors.push(`manifest: ${reason}`);
    return { manifest: null, manifestDisplay };
  }
}

function readBaseline(root, baselineInput, errors) {
  const input = baselineInput ?? DEFAULT_BASELINE_PATH;
  if (typeof input !== "string" || input.length === 0) {
    errors.push("baseline: path must be non-empty");
    return { baseline: null, baselineDisplay: "[invalid]" };
  }
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!isContained(root, candidate)) {
    errors.push("baseline: path escapes repository root");
    return { baseline: null, baselineDisplay: "[invalid]" };
  }
  const baselineDisplay = normalizeRelativePath(relative(root, candidate));
  try {
    if (hasLinkedSegment(root, candidate)) {
      errors.push("baseline: symbolic links and junctions are not allowed");
      return { baseline: null, baselineDisplay };
    }
    const metadata = lstatSync(candidate);
    if (!metadata.isFile()) {
      errors.push("baseline: path is not a file");
      return { baseline: null, baselineDisplay };
    }
    const realCandidate = realpathSync.native(candidate);
    if (!isContained(root, realCandidate)) {
      errors.push("baseline: real path escapes repository root");
      return { baseline: null, baselineDisplay };
    }
    return { baseline: JSON.parse(readFileSync(realCandidate, "utf8")), baselineDisplay };
  } catch (error) {
    const reason = error instanceof SyntaxError ? "is not valid JSON" : "path does not exist or cannot be read";
    errors.push(`baseline: ${reason}`);
    return { baseline: null, baselineDisplay };
  }
}

function verifyHashedFile(root, entry, label, errors) {
  if (!isPlainObject(entry)) {
    errors.push(`${label}: entry must be an object`);
    return null;
  }
  if (!isSha256(entry.sha256)) {
    errors.push(`${label}: sha256 must be 64 lowercase hexadecimal characters`);
  }
  const file = safeExistingPath(root, entry.path, label, errors);
  if (file === null) return null;
  const bytes = readFileSync(file);
  const actual = sha256(bytes);
  if (isSha256(entry.sha256) && actual !== entry.sha256) errors.push(`${label}: sha256 mismatch`);
  return {
    path: normalizeRelativePath(relative(root, file)),
    bytes: bytes.byteLength,
    sha256: actual,
  };
}

function collectRendererFiles(root, assetsDirectory, errors) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"));
    } catch {
      errors.push("renderer.assetsDirectory: directory cannot be read");
      return;
    }
    for (const entry of entries) {
      const candidate = resolve(directory, entry.name);
      const display = normalizeRelativePath(relative(root, candidate));
      if (entry.isSymbolicLink()) {
        errors.push(`renderer asset ${display}: symbolic links and junctions are not allowed`);
      } else if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile()) {
        files.push({ file: candidate, path: display });
      }
    }
  };
  visit(assetsDirectory);
  return files;
}

function parseBaseline(root, baseline, errors) {
  const empty = {
    immutable: new Map(),
    overlays: new Map(),
    media: new Map(),
    expectedAggregate: null,
  };
  if (!isPlainObject(baseline)) {
    errors.push("baseline: root must be an object");
    return empty;
  }
  if (baseline.schemaVersion !== 1) errors.push("baseline: schemaVersion must be 1");
  if (baseline.algorithm !== BOUNDARY_ALGORITHM) errors.push(`baseline: algorithm must be ${BOUNDARY_ALGORITHM}`);
  if (!isNonEmptyString(baseline.limitations)) errors.push("baseline: limitations must be a non-empty string");

  const parseList = (value, label) => {
    const entries = new Map();
    if (!Array.isArray(value) || value.length === 0) {
      errors.push(`${label}: must be a non-empty array`);
      return entries;
    }
    for (const [index, entry] of value.entries()) {
      const entryLabel = `${label}[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(`${entryLabel}: entry must be an object`);
        continue;
      }
      const path = normalizeManifestPath(entry.path);
      if (path === null || isAbsolute(entry.path) || entry.path.includes("\0")) {
        errors.push(`${entryLabel}: path must be a non-empty repository-relative path`);
        continue;
      }
      if (entry.path !== path) errors.push(`${entryLabel}: path must use lowercase forward-slash normalization`);
      const candidate = resolve(root, path);
      if (!isContained(root, candidate)) {
        errors.push(`${entryLabel}: path escapes repository root`);
        continue;
      }
      if (!isSha256(entry.sha256)) {
        errors.push(`${entryLabel}: sha256 must be 64 lowercase hexadecimal characters`);
        continue;
      }
      if (entries.has(path)) errors.push(`${entryLabel}: duplicate path declaration`);
      else entries.set(path, entry.sha256);
    }
    return entries;
  };

  const immutable = parseList(baseline.immutableFiles, "baseline.immutableFiles");
  const overlays = parseList(baseline.permittedOverlays, "baseline.permittedOverlays");
  const media = parseList(baseline.permittedMedia, "baseline.permittedMedia");
  for (const path of immutable.keys()) {
    if (!path.startsWith(`${RENDERER_PATH}/`)) errors.push(`baseline.immutableFiles: path is outside the renderer`);
    if (PERMITTED_OPENBOT_PATHS.has(path)) errors.push(`baseline.immutableFiles: permitted OpenBot path must be declared separately`);
  }
  for (const expectedPath of PERMITTED_OVERLAY_PATHS) {
    if (!overlays.has(expectedPath)) errors.push(`baseline.permittedOverlays: missing closed path ${expectedPath}`);
  }
  for (const path of overlays.keys()) {
    if (!PERMITTED_OVERLAY_PATHS.includes(path)) errors.push("baseline.permittedOverlays: path is outside the closed allowlist");
  }
  if (!media.has(WELCOME_MEDIA_PATH)) errors.push(`baseline.permittedMedia: missing closed path ${WELCOME_MEDIA_PATH}`);
  for (const path of media.keys()) {
    if (path !== WELCOME_MEDIA_PATH) errors.push("baseline.permittedMedia: path is outside the closed allowlist");
  }
  const allPaths = new Set();
  for (const [label, entries] of [["immutableFiles", immutable], ["permittedOverlays", overlays], ["permittedMedia", media]]) {
    for (const path of entries.keys()) {
      if (allPaths.has(path)) errors.push(`baseline.${label}: path is declared in more than one list`);
      else allPaths.add(path);
    }
  }
  const aggregateLines = [...immutable.entries()]
    .map(([path, digest]) => `${path}\0${digest}\n`)
    .sort();
  return {
    immutable,
    overlays,
    media,
    expectedAggregate: aggregateLines.length > 0 ? sha256(aggregateLines.join("")) : null,
  };
}

function verify(root, manifest, baseline) {
  const errors = [];
  const checkedImmutable = [];
  const permittedOverlays = [];
  const permittedMedia = [];
  const baselineContract = parseBaseline(root, baseline, errors);
  const expectedAggregate = baselineContract.expectedAggregate;
  let actualAggregate = null;

  if (!isPlainObject(manifest)) {
    errors.push("manifest: root must be an object");
    return { errors, expectedAggregate, actualAggregate, checkedImmutable, permittedOverlays, permittedMedia };
  }
  if (manifest.schemaVersion !== 1) errors.push("manifest: schemaVersion must be 1");
  if (!isPlainObject(manifest.artifacts) || Object.keys(manifest.artifacts).length === 0) {
    errors.push("manifest.artifacts: must be a non-empty object");
  }
  if (!isPlainObject(manifest.renderer)) {
    errors.push("manifest.renderer: must be an object");
    return { errors, expectedAggregate, actualAggregate, checkedImmutable, permittedOverlays, permittedMedia };
  }

  const renderer = manifest.renderer;
  if (!isPlainObject(renderer.index)) errors.push("renderer.index: must be an object");
  else {
    const indexPath = normalizeManifestPath(renderer.index.path);
    if (indexPath !== INDEX_PATH) {
      errors.push(`renderer.index: path must be ${INDEX_PATH}`);
    }
    verifyHashedFile(root, renderer.index, "renderer.index", errors);
  }

  const manifestAssetsPath = normalizeManifestPath(renderer.assetsDirectory);
  if (manifestAssetsPath !== ASSETS_PATH) {
    errors.push(`renderer.assetsDirectory: path must be ${ASSETS_PATH}`);
  }
  safeExistingPath(root, renderer.assetsDirectory, "renderer.assetsDirectory", errors, "directory");

  const boundary = renderer.boundary;
  if (!isPlainObject(boundary)) errors.push("renderer.boundary: must be an object");
  else {
    if (boundary.schemaVersion !== 1) errors.push("renderer.boundary: schemaVersion must be 1");
    if (boundary.algorithm !== BOUNDARY_ALGORITHM) errors.push(`renderer.boundary: algorithm must be ${BOUNDARY_ALGORITHM}`);
    if (!isSha256(boundary.immutableAggregateSha256)) {
      errors.push("renderer.boundary: immutableAggregateSha256 must be 64 lowercase hexadecimal characters");
    } else {
      const clientManifestAggregate = boundary.immutableAggregateSha256;
      if (expectedAggregate !== null && clientManifestAggregate !== expectedAggregate) {
        errors.push("renderer.boundary: client manifest aggregate differs from independent baseline");
      }
    }
  }

  const requiredAssets = renderer.requiredAssets;
  const requiredByPath = new Map();
  if (!Array.isArray(requiredAssets) || requiredAssets.length === 0) {
    errors.push("renderer.requiredAssets: must be a non-empty array");
  } else {
    const seenHashes = new Set();
    for (const [index, entry] of requiredAssets.entries()) {
      const label = `renderer.requiredAssets[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(`${label}: entry must be an object`);
        continue;
      }
      if (!isNonEmptyString(entry.role) || !REQUIRED_ASSET_ROLES.has(entry.role)) {
        errors.push(`${label}: role is not allowed`);
      }
      const normalizedPath = normalizeManifestPath(entry.path);
      if (normalizedPath !== null) {
        const requiredAssetCandidate = resolve(root, entry.path);
        const expectedAssetsRoot = resolve(root, ASSETS_PATH);
        if (!normalizedPath.startsWith(`${ASSETS_PATH}/`)
          || requiredAssetCandidate === expectedAssetsRoot
          || !isContained(expectedAssetsRoot, requiredAssetCandidate)) {
          errors.push(`${label}: required asset path must be strictly inside renderer assetsDirectory`);
        }
        if (requiredByPath.has(normalizedPath)) errors.push(`${label}: duplicate path declaration`);
        else requiredByPath.set(normalizedPath, entry);
      }
      if (isSha256(entry.sha256)) {
        if (seenHashes.has(entry.sha256)) errors.push(`${label}: duplicate sha256 declaration`);
        else seenHashes.add(entry.sha256);
      }
      if (entry.role === "injected" && (normalizedPath === null || !PERMITTED_OVERLAY_PATHS.includes(normalizedPath))) {
        errors.push(`${label}: injected overlay is outside the closed allowlist`);
      }
      if (entry.role === "welcome-art" && normalizedPath !== WELCOME_MEDIA_PATH) {
        errors.push(`${label}: declared media is outside the closed allowlist`);
      }
      if (normalizedPath !== null) {
        const extension = extname(normalizedPath).toLowerCase();
        if (!IMMUTABLE_EXTENSIONS.has(extension)
          && !PERMITTED_OVERLAY_PATHS.includes(normalizedPath)
          && normalizedPath !== WELCOME_MEDIA_PATH) {
          errors.push(`${label}: declared media is outside the closed allowlist`);
        }
      }
      if (normalizedPath?.split("/").at(-1)?.startsWith("openbot-") && !PERMITTED_OPENBOT_PATHS.has(normalizedPath)) {
        errors.push(`${label}: OpenBot asset is outside the closed allowlist`);
      }
      verifyHashedFile(root, entry, label, errors);
    }
  }

  const artifacts = isPlainObject(manifest.artifacts) ? manifest.artifacts : {};
  const expectedArtifacts = [
    ["rendererInjected", LOCAL_SETTINGS_PATH],
    ["rendererMemoryUi", MEMORY_UI_PATH],
  ];
  for (const [name, expectedPath] of expectedArtifacts) {
    const artifact = artifacts[name];
    const label = `artifact:${name}`;
    if (!isPlainObject(artifact)) {
      errors.push(`${label}: declaration is required`);
      continue;
    }
    if (normalizeManifestPath(artifact.path) !== expectedPath) {
      errors.push(`${label}: path must be ${expectedPath}`);
    }
    if (!isNonEmptyString(artifact.version)) errors.push(`${label}: version must be a non-empty string`);
    verifyHashedFile(root, artifact, label, errors);
    const required = requiredByPath.get(expectedPath);
    if (!required || required.role !== "injected") errors.push(`${label}: matching requiredAssets injected declaration is required`);
    if (required && isSha256(required.sha256) && isSha256(artifact.sha256) && required.sha256 !== artifact.sha256) {
      errors.push(`${label}: artifact and requiredAssets hashes differ`);
    }
  }
  for (const [name, artifact] of Object.entries(artifacts)) {
    if (!isPlainObject(artifact) || !isNonEmptyString(artifact.path)) continue;
    const path = normalizeRelativePath(artifact.path);
    if (path.startsWith(`${ASSETS_PATH}/`) && !PERMITTED_OVERLAY_PATHS.includes(path)) {
      errors.push(`artifact:${name}: renderer artifact is outside the closed allowlist`);
    }
  }

  const welcomeEntry = requiredByPath.get(WELCOME_MEDIA_PATH);
  if (!welcomeEntry || welcomeEntry.role !== "welcome-art") {
    errors.push("renderer.requiredAssets: exact welcome media declaration is required");
  } else {
    verifyHashedFile(root, welcomeEntry, "renderer.welcomeMedia", errors);
  }

  const rendererDirectory = safeExistingPath(root, RENDERER_PATH, "renderer root", errors, "directory");
  if (rendererDirectory !== null) {
    const normalizedPaths = new Set();
    const aggregateLines = [];
    const rendererFiles = collectRendererFiles(root, rendererDirectory, errors);
    for (const entry of rendererFiles) {
      if (normalizedPaths.has(entry.path)) errors.push(`renderer asset ${entry.path}: normalized path collision`);
      else normalizedPaths.add(entry.path);
      const extension = extname(entry.path).toLowerCase();
      if (extension === ".map") errors.push(`renderer asset ${entry.path}: sourcemaps are forbidden`);
      const openbotName = entry.path.split("/").at(-1)?.startsWith("openbot-") ?? false;
      if (openbotName && !PERMITTED_OPENBOT_PATHS.has(entry.path)) {
        errors.push(`renderer asset ${entry.path}: undeclared OpenBot asset is forbidden`);
      }
      const bytes = readFileSync(entry.file);
      const digest = sha256(bytes);
      if (IMMUTABLE_EXTENSIONS.has(extension) && /sourceMappingURL\s*=/iu.test(bytes.toString("utf8"))) {
        errors.push(`renderer asset ${entry.path}: sourceMappingURL is forbidden`);
      }
      const checked = { path: entry.path, bytes: bytes.byteLength, sha256: digest };
      if (PERMITTED_OVERLAY_PATHS.includes(entry.path)) {
        permittedOverlays.push(checked);
      } else if (entry.path === WELCOME_MEDIA_PATH) {
        permittedMedia.push(checked);
      } else {
        checkedImmutable.push(checked);
        aggregateLines.push(`${entry.path}\0${digest}\n`);
      }
    }
    checkedImmutable.sort((left, right) => left.path.localeCompare(right.path, "en"));
    permittedOverlays.sort((left, right) => left.path.localeCompare(right.path, "en"));
    permittedMedia.sort((left, right) => left.path.localeCompare(right.path, "en"));
    aggregateLines.sort();
    if (checkedImmutable.length === 0) errors.push("renderer boundary: immutable renderer file set must not be empty");
    actualAggregate = sha256(aggregateLines.join(""));
    if (expectedAggregate !== null && actualAggregate !== expectedAggregate) {
      errors.push("renderer boundary: immutable aggregate sha256 mismatch");
    }

    const actualImmutable = new Map(checkedImmutable.map((entry) => [entry.path, entry.sha256]));
    for (const [path, expectedHash] of baselineContract.immutable.entries()) {
      const actualHash = actualImmutable.get(path);
      if (actualHash === undefined) errors.push(`baseline: missing renderer file ${path}`);
      else if (actualHash !== expectedHash) errors.push(`baseline: sha256 mismatch for ${path}`);
    }
    for (const path of actualImmutable.keys()) {
      if (!baselineContract.immutable.has(path)) errors.push(`baseline: unexpected renderer file ${path}`);
    }
    const compareClosedList = (label, expected, actualEntries) => {
      const actual = new Map(actualEntries.map((entry) => [entry.path, entry.sha256]));
      for (const [path, expectedHash] of expected.entries()) {
        const actualHash = actual.get(path);
        if (actualHash === undefined) errors.push(`${label}: missing renderer file ${path}`);
        else if (actualHash !== expectedHash) errors.push(`${label}: sha256 mismatch for ${path}`);
      }
      for (const path of actual.keys()) {
        if (!expected.has(path)) errors.push(`${label}: unexpected renderer file ${path}`);
      }
    };
    compareClosedList("baseline overlays", baselineContract.overlays, permittedOverlays);
    compareClosedList("baseline media", baselineContract.media, permittedMedia);
  }

  return { errors, expectedAggregate, actualAggregate, checkedImmutable, permittedOverlays, permittedMedia };
}

const parsed = parseCliArgs(process.argv.slice(2));
const startupErrors = [...parsed.errors];
const root = safeRoot(parsed.rootInput, startupErrors);
let manifestDisplay = "[invalid]";
let baselineDisplay = "[invalid]";
let verification = {
  errors: [],
  expectedAggregate: null,
  actualAggregate: null,
  checkedImmutable: [],
  permittedOverlays: [],
  permittedMedia: [],
};
if (root !== null && startupErrors.length === 0) {
  const loaded = readManifest(root, parsed.manifestInput, startupErrors);
  const loadedBaseline = readBaseline(root, parsed.baselineInput, startupErrors);
  manifestDisplay = loaded.manifestDisplay;
  baselineDisplay = loadedBaseline.baselineDisplay;
  if (loaded.manifest !== null && loadedBaseline.baseline !== null && startupErrors.length === 0) {
    verification = verify(root, loaded.manifest, loadedBaseline.baseline);
  }
}
const errors = [...startupErrors, ...verification.errors];
const result = {
  ok: errors.length === 0,
  root: ".",
  manifest: manifestDisplay,
  baseline: baselineDisplay,
  immutableAggregate: {
    expected: verification.expectedAggregate,
    actual: verification.actualAggregate,
  },
  checkedImmutable: verification.checkedImmutable,
  permittedOverlays: verification.permittedOverlays,
  permittedMedia: verification.permittedMedia,
  errors,
};
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
