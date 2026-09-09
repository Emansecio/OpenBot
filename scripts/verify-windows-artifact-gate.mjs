import { promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoReparseTree,
  copyTree,
  fileSha256,
  materializePackage,
  preflightRelease,
  treeDigest,
} from "./release-common.mjs";
import { verifyArtifactSignature } from "./artifact-signing.mjs";

function slash(value) { return String(value).replaceAll("\\", "/"); }
function contained(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(`.${sep}`) && !rel.startsWith(sep));
}
function sanitizeError(error) {
  const raw = String(error instanceof Error ? error.message : error).toLowerCase();
  if (raw.includes("distinct from") || raw.includes("nested in")) return "clean root overlap rejected";
  if (raw.includes("fresh empty") || raw.includes("not a real directory")) return "clean root must be fresh empty directory";
  if (raw.includes("enoent") || raw.includes("cannot find") || raw.includes("no such file")) return "artifact source unavailable";
  if (raw.includes("transient artifact")) return "transient artifact entry rejected";
  if (raw.includes("reparse") || raw.includes("symbolic link")) return "reparse entry rejected";
  if (raw.includes("preflight")) return "release preflight failed";
  if (raw.includes("payload hash") || raw.includes("content hash") || raw.includes("hash mismatch")) return "payload hash consistency failed";
  if (raw.includes("sidecar requires")) return "sidecar requires zip artifact";
  if (raw.includes("sidecar metadata")) return "sidecar metadata diverges";
  if (raw.includes("sidecar artifact")) return "sidecar artifact hash failed";
  if (raw.includes("sidecar")) return "sidecar validation failed";
  if (raw.includes("unsigned")) return "unsigned metadata policy failed";
  if (raw.includes("not a regular file") || raw.includes("regular non-reparse")) return "artifact source type invalid";
  return "artifact verification failed";
}

async function copyDirectory(source, destination) {
  await assertNoReparseTree(source);
  await fs.mkdir(dirname(destination), { recursive: true });
  await copyTree(source, destination);
  await assertNoReparseTree(destination);
  return destination;
}

async function copyZip(source, destination) {
  const sourcePath = resolve(source);
  await fs.lstat(sourcePath).then((metadata) => {
    if (metadata.isSymbolicLink?.() || metadata.isReparsePoint === true) throw new Error("artifact zip is a reparse point");
    if (!metadata.isFile()) throw new Error("artifact zip is not a regular file");
  });
  await fs.mkdir(dirname(destination), { recursive: true });
  await fs.copyFile(sourcePath, destination);
  return destination;
}

async function assertCleanRoot(root) {
  const metadata = await fs.lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink?.() || metadata.isReparsePoint === true) {
    throw new Error("clean root must be a real directory");
  }
  await assertNoReparseTree(root);
  const entries = await fs.readdir(root);
  if (entries.length !== 0) throw new Error("clean root must be a fresh empty directory at gate entry");
}

async function assertNoTransientEntries(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    // Publication staging/partial names are never valid inside a released
    // payload, even if someone also rewrites its local hash manifest.
    if (/(?:\.staging(?:$|[.-])|\.partial(?:$|[.-])|\.tmp(?:$|[.-])|~$)/iu.test(entry.name)) {
      throw new Error(`transient artifact entry is not allowed: ${slash(relative(root, join(current, entry.name)))}`);
    }
    if (entry.isDirectory()) await assertNoTransientEntries(root, join(current, entry.name));
  }
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

async function copySidecar(source, destination) {
  const sourcePath = resolve(source);
  const metadata = await fs.lstat(sourcePath);
  if (metadata.isSymbolicLink?.() || metadata.isReparsePoint === true || !metadata.isFile()) {
    throw new Error("sidecar must be a regular non-reparse file");
  }
  await fs.mkdir(dirname(destination), { recursive: true });
  await fs.copyFile(sourcePath, destination);
  return destination;
}

function manifestMetadata(manifest) {
  const digest = manifest.contentSha256 ?? manifest.payloadSha256 ?? manifest.sha256;
  return {
    product: manifest.product,
    version: manifest.version,
    platform: manifest.platform,
    arch: manifest.arch,
    artifactType: manifest.artifactType,
    security: manifest.security,
    signed: manifest.signed,
    signature: manifest.signature,
    contentSha256: digest == null ? null : String(digest).toLowerCase(),
  };
}

function assertPayloadHashConsistency(manifest, payloadDigest) {
  for (const field of ["contentSha256", "payloadSha256", "sha256"]) {
    if (manifest[field] == null) continue;
    if (String(manifest[field]).toLowerCase() !== String(payloadDigest).toLowerCase()) {
      throw new Error(`payload hash field ${field} diverges from canonical payload digest`);
    }
  }
}

function assertSidecarMetadata(sidecar, directoryManifest, zipManifest) {
  if (sidecar.signed !== false || sidecar.signature !== null || sidecar.security !== "unsigned-local") {
    throw new Error("sidecar must honestly declare unsigned-local");
  }
  const expected = manifestMetadata(directoryManifest);
  const actual = manifestMetadata(sidecar);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("sidecar metadata diverges from directory manifest");
  if (zipManifest != null && JSON.stringify(actual) !== JSON.stringify(manifestMetadata(zipManifest))) {
    throw new Error("sidecar metadata diverges from zip manifest");
  }
}

async function verifyDirectory(root, options = {}) {
  await assertNoReparseTree(root);
  await assertNoTransientEntries(root);
  const preflight = await preflightRelease(root, { arch: options.arch ?? "x64" });
  if (!preflight.ok) throw new Error(`directory preflight failed: ${preflight.missing.join("; ")}`);
  const manifest = preflight.manifest;
  const signing = verifyArtifactSignature(manifest);
  const digest = await treeDigest(root, { exclude: ["manifest.json"] });
  const requiredDigest = String(manifest.contentSha256 ?? manifest.payloadSha256 ?? manifest.sha256).toLowerCase();
  if (digest.toLowerCase() !== requiredDigest) throw new Error(`directory content hash mismatch: expected ${requiredDigest}, got ${digest}`);
  assertPayloadHashConsistency(manifest, digest);
  return { root, manifest, signing, digest, preflight };
}

async function verifyZip(zipPath, options = {}) {
  const materialized = options.materialize
    ? await options.materialize(zipPath)
    : await materializePackage(zipPath);
  try {
    const result = await verifyDirectory(materialized.root, options);
    return { ...result, zipPath, cleanup: materialized.cleanup };
  } catch (error) {
    await materialized.cleanup?.();
    throw error;
  }
}

export async function verifyWindowsArtifactGate(options = {}) {
  const platform = String(options.platform ?? process.platform);
  if (platform !== "win32") {
    return { ok: false, supported: false, status: "unsupported-platform", platform, error: "Windows artifact verification is supported only on win32" };
  }
  const directory = options.directory ?? options.dir;
  const zip = options.zip;
  if (directory == null && zip == null) throw new Error("artifact directory or zip is required");
  if (options.cleanRoot == null) throw new Error("cleanRoot is required and must be a fresh empty directory");
  const evidence = { ok: false, supported: true, platform, status: "red", checks: [], errors: [] };
  let zipResult = null;
  const cleanRoot = resolve(options.cleanRoot);
  const directorySource = directory == null ? null : resolve(directory);
  const zipSource = zip == null ? null : resolve(zip);
  const sidecarSource = options.sidecar == null ? null : resolve(options.sidecar);
  try {
    for (const [label, source] of [["directory", directorySource], ["zip", zipSource], ["sidecar", sidecarSource]]) {
      if (source != null && (contained(cleanRoot, source) || contained(source, cleanRoot))) {
        throw new Error(`clean root must be distinct from and not nested in ${label} source`);
      }
    }
    if (sidecarSource != null && zipSource == null) throw new Error("sidecar requires a zip artifact");
    // Do not create or touch the clean root until lexical overlap checks pass.
    await assertCleanRoot(cleanRoot);
    const cleanDirectory = directorySource == null ? null : join(cleanRoot, "directory", basename(directorySource));
    const cleanZip = zipSource == null ? null : join(cleanRoot, "artifact", basename(zipSource));
    const cleanSidecar = sidecarSource == null ? null : join(cleanRoot, "sidecar", basename(sidecarSource));
    if (directory != null) {
      await copyDirectory(directorySource, cleanDirectory);
    }
    if (zip != null) {
      await copyZip(zipSource, cleanZip);
    }
    if (sidecarSource != null) await copySidecar(sidecarSource, cleanSidecar);
    const directoryResult = cleanDirectory == null
      ? null
      : await verifyDirectory(cleanDirectory, options);
    zipResult = cleanZip == null ? null : await verifyZip(cleanZip, options);
    if (directoryResult != null) evidence.checks.push("directory-preflight-hash-signing");
    if (zipResult != null) evidence.checks.push("zip-extract-preflight-hash-signing");
    if (directoryResult != null && zipResult != null) {
      if (directoryResult.digest !== zipResult.digest) throw new Error("directory and zip payload hashes are not equivalent");
      if (JSON.stringify(directoryResult.manifest) !== JSON.stringify(zipResult.manifest)) throw new Error("directory and zip manifests are not equivalent");
      evidence.checks.push("directory-zip-equivalence");
    }
    if (cleanSidecar != null) {
      const sidecar = await readJson(cleanSidecar);
      assertSidecarMetadata(sidecar, directoryResult?.manifest ?? zipResult.manifest, zipResult.manifest);
      const actualZipHash = await fileSha256(cleanZip);
      if (String(sidecar.artifactSha256 ?? "").toLowerCase() !== actualZipHash.toLowerCase()) {
        throw new Error("sidecar artifact SHA-256 mismatch");
      }
      const payloadDigest = directoryResult?.digest ?? zipResult.digest;
      for (const field of ["contentSha256", "payloadSha256"]) {
        if (sidecar[field] != null && String(sidecar[field]).toLowerCase() !== payloadDigest.toLowerCase()) {
          throw new Error(`sidecar payload hash field ${field} diverges from canonical payload digest`);
        }
      }
      if (sidecar.sha256 != null && String(sidecar.sha256).toLowerCase() !== actualZipHash.toLowerCase()) {
        throw new Error("sidecar sha256 diverges from canonical zip hash");
      }
      evidence.checks.push("sidecar-integrity-only");
    }
    evidence.ok = true;
    evidence.status = "green";
    evidence.authenticity = "unsigned-local; SHA-256 proves integrity only";
    return evidence;
  } catch (error) {
    evidence.errors.push(sanitizeError(error));
    return evidence;
  } finally {
    await Promise.resolve(zipResult?.cleanup?.()).catch(() => undefined);
  }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}
function isMainModule() { return process.argv[1] != null && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); }

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const result = await verifyWindowsArtifactGate({
    directory: optionValue(argv, "--directory") ?? optionValue(argv, "--dir"),
    zip: optionValue(argv, "--zip"),
    sidecar: optionValue(argv, "--sidecar"),
    cleanRoot: optionValue(argv, "--clean-root"),
    platform: process.platform,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
