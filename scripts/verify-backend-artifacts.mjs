import { lstatSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, "..");
const requiredOutputs = [
  "server/local-exec-bridge.js",
  "server/webauthn-bridge.js",
  "execution/runtime/local/driver.js",
  "main.js",
];

function displayPath(root, file) {
  return (relative(root, file) || ".").replaceAll("\\", "/");
}

function isReparsePoint(metadata) {
  return metadata?.isSymbolicLink?.() === true
    || metadata?.isReparsePoint === true
    || metadata?.reparsePoint === true;
}

function inspectPath(file, label, lstat) {
  try {
    const metadata = lstat(file);
    if (isReparsePoint(metadata)) return { metadata, unsafe: true, error: `${label}: symbolic link/reparse point is not allowed` };
    return { metadata, unsafe: false };
  } catch {
    return null;
  }
}

function pathAncestors(candidate) {
  const ancestors = [];
  let current = resolve(candidate);
  while (true) {
    ancestors.unshift(current);
    const parent = dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
}

function inspectPathChain(root, candidate, label, lstat) {
  const rel = relative(root, candidate);
  if (rel.startsWith("..")) return { metadata: null, unsafe: true, error: `${label}: path escapes root` };
  let inspection = null;
  for (const ancestor of pathAncestors(candidate)) {
    inspection = inspectPath(ancestor, `${label} ancestor ${ancestor}`, lstat);
    if (!inspection) return null;
    if (inspection.unsafe) return inspection;
  }
  return inspection;
}

function collectSourceFiles(sourceDirectory, lstat, readDirectory, errors) {
  const files = [];
  const visit = (directory, prefix = "") => {
    const directoryInspection = inspectPathChain(sourceDirectory, directory, `source directory ${prefix || "."}`, lstat);
    if (!directoryInspection || directoryInspection.unsafe || !directoryInspection.metadata.isDirectory()) return;
    let entries;
    try {
      entries = readDirectory(directory, { withFileTypes: true });
    } catch {
      errors.push(`source directory ${prefix || "."}: cannot read directory`);
      return;
    }
    for (const entry of entries) {
      const file = join(directory, entry.name);
      const fileRelative = join(prefix, entry.name);
      const inspection = inspectPathChain(sourceDirectory, file, `source ${fileRelative.replaceAll("\\", "/")}`, lstat);
      if (!inspection) continue;
      if (inspection.unsafe) {
        errors.push(inspection.error);
        continue;
      }
      if (inspection.metadata.isDirectory()) visit(file, fileRelative);
      else if (inspection.metadata.isFile() && extname(entry.name).toLowerCase() === ".ts" && !/\.d\.ts$/iu.test(entry.name)) {
        files.push({ file, relative: fileRelative, metadata: inspection.metadata });
      }
    }
  };
  const sourceInspection = inspectPathChain(sourceDirectory, sourceDirectory, "source directory .", lstat);
  if (sourceInspection?.unsafe) errors.push(sourceInspection.error);
  else if (sourceInspection?.metadata.isDirectory()) visit(sourceDirectory);
  return files;
}

export function verifyBackendArtifacts(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? defaultRoot);
  const sourceDirectory = resolve(options.sourceDirectory ?? join(sourceRoot, "src"));
  const distRoot = resolve(options.distRoot ?? join(sourceRoot, "dist"));
  const fsApi = options.fs ?? {};
  const lstat = fsApi.lstatSync ?? lstatSync;
  const readDirectory = fsApi.readdirSync ?? readdirSync;
  const errors = [];
  const checks = [];

  const sourceRootInspection = inspectPath(sourceRoot, "sourceRoot", lstat);
  if (!sourceRootInspection) {
    errors.push(`sourceRoot is missing: ${displayPath(sourceRoot, sourceRoot)}`);
  } else if (sourceRootInspection.unsafe) {
    errors.push(sourceRootInspection.error);
  } else if (!sourceRootInspection.metadata.isDirectory()) {
    errors.push(`sourceRoot is not a directory: ${displayPath(sourceRoot, sourceRoot)}`);
  }
  const distRootInspection = inspectPath(distRoot, "distRoot", lstat);
  if (!distRootInspection) {
    errors.push(`distRoot is missing: ${displayPath(sourceRoot, distRoot)}`);
  } else if (distRootInspection.unsafe) {
    errors.push(distRootInspection.error);
  } else if (!distRootInspection.metadata.isDirectory()) {
    errors.push(`distRoot is not a directory: ${displayPath(sourceRoot, distRoot)}`);
  }
  const sourceDirectoryInspection = inspectPathChain(sourceRoot, sourceDirectory, "source directory src", lstat);
  if (!sourceDirectoryInspection) {
    errors.push(`source tree is missing: ${displayPath(sourceRoot, sourceDirectory)}`);
  } else if (sourceDirectoryInspection.unsafe) {
    errors.push(sourceDirectoryInspection.error);
  } else if (!sourceDirectoryInspection.metadata.isDirectory()) {
    errors.push(`source tree is not a directory: ${displayPath(sourceRoot, sourceDirectory)}`);
  }

  for (const source of collectSourceFiles(sourceDirectory, lstat, readDirectory, errors)) {
    const outputRelative = source.relative.replace(/\.ts$/iu, ".js");
    const output = join(distRoot, outputRelative);
    const label = `dist/${outputRelative.replaceAll("\\", "/")}`;
    const outputInspection = inspectPathChain(distRoot, output, label, lstat);
    if (!outputInspection) {
      errors.push(`${label}: output is missing for src/${source.relative.replaceAll("\\", "/")}`);
      continue;
    }
    if (outputInspection.unsafe) {
      errors.push(outputInspection.error);
      continue;
    }
    if (!outputInspection.metadata.isFile()) {
      errors.push(`${label}: output is not a file`);
      continue;
    }
    // Freshness is intentionally an mtime contract, not cryptographic integrity.
    if (source.metadata.mtimeMs > outputInspection.metadata.mtimeMs) {
      errors.push(`${label}: output is older than source src/${source.relative.replaceAll("\\", "/")}`);
      continue;
    }
    checks.push({ source: displayPath(sourceRoot, source.file), output: displayPath(sourceRoot, output), sourceMtimeMs: source.metadata.mtimeMs, outputMtimeMs: outputInspection.metadata.mtimeMs });
  }

  for (const outputRelative of requiredOutputs) {
    const output = join(distRoot, outputRelative);
    const inspection = inspectPathChain(distRoot, output, `required output dist/${outputRelative}`, lstat);
    if (!inspection) {
      errors.push(`required output is missing: dist/${outputRelative}`);
    } else if (inspection.unsafe) {
      errors.push(inspection.error);
    } else if (!inspection.metadata.isFile()) {
      errors.push(`required output is not a file: dist/${outputRelative}`);
    }
  }

  return {
    ok: errors.length === 0,
    sourceRoot,
    sourceDirectory,
    distRoot,
    checks,
    errors,
  };
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const result = verifyBackendArtifacts({
    sourceRoot: optionValue(argv, "--source-root") ?? process.env.OPENBOT_ROOT,
    distRoot: optionValue(argv, "--dist-root") ?? optionValue(argv, "--dist"),
  });
  console.log(`BACKEND_ARTIFACTS ${result.ok ? "GREEN" : "RED"}`);
  console.log(`source=${displayPath(result.sourceRoot, result.sourceDirectory)}`);
  console.log(`dist=${displayPath(result.sourceRoot, result.distRoot)}`);
  for (const error of result.errors) console.error(`ERROR ${error}`);
  if (result.ok) console.log(`checks=${result.checks.length}`);
  process.exitCode = result.ok ? 0 : 1;
}
