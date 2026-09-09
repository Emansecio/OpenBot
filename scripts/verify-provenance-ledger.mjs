import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const realRoot = realpathSync(root);
const defaultCatalog = resolve(root, "provenance", "openbot-components.json");
const allowedClassifications = new Set([
  "own-code",
  "licensed-dependency",
  "extracted-artifact",
  "observational-reference",
  "non-reusable",
]);
const expectedReuseByClassification = new Map([
  ["own-code", "copy"],
  ["licensed-dependency", "per-license"],
  ["extracted-artifact", "no-copy"],
  ["observational-reference", "no-copy"],
  ["non-reusable", "no-copy"],
]);

function isContained(base, candidate) {
  const rel = relative(base, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function verifyAuthorship(authorship, errors) {
  if (!authorship || typeof authorship !== "object" || Array.isArray(authorship)) {
    errors.push("authorship: object is required");
    return;
  }
  if (authorship.schemaVersion !== 1) errors.push("authorship: schemaVersion must be 1");

  const local = authorship.localImplementation;
  if (!local || typeof local !== "object" || Array.isArray(local)) {
    errors.push("authorship: localImplementation object is required");
  } else {
    if (!Array.isArray(local.scope) || local.scope.length === 0 || local.scope.some((item) => !isNonEmptyString(item))) {
      errors.push("authorship: localImplementation.scope must be a non-empty string array");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(local.date ?? "")) {
      errors.push("authorship: localImplementation.date must be YYYY-MM-DD");
    }
    if (local.authorType !== "ai-agent") errors.push("authorship: localImplementation.authorType must be ai-agent");
    if (local.author !== "OpenAI Codex agents") errors.push("authorship: localImplementation.author must identify OpenAI Codex agents");
    if (local.directedBy !== "repository owner") errors.push("authorship: localImplementation.directedBy must be repository owner");
    if (local.ownerIdentityRecorded !== false) errors.push("authorship: localImplementation.ownerIdentityRecorded must be false");
  }

  const historical = authorship.historicalComponents;
  if (!historical || typeof historical !== "object" || Array.isArray(historical)) {
    errors.push("authorship: historicalComponents object is required");
  } else {
    if (historical.status !== "unknown") errors.push("authorship: historicalComponents.status must be unknown");
    if (!Array.isArray(historical.scope) || historical.scope.length === 0 || historical.scope.some((item) => !isNonEmptyString(item))) {
      errors.push("authorship: historicalComponents.scope must be a non-empty string array");
    }
    if (historical.notAttributedToLocalImplementation !== true) {
      errors.push("authorship: historicalComponents must not attribute legacy components to the local implementation record");
    }
  }
}

function isHttpsRepository(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function parseCliArgs(argv) {
  const errors = [];
  const catalogPaths = [];
  let jsonSeen = false;
  for (const argument of argv) {
    if (argument === "--json") {
      if (jsonSeen) errors.push("CLI: --json may be specified only once");
      jsonSeen = true;
    } else if (argument.startsWith("-")) {
      errors.push(`CLI: unknown option ${argument}`);
    } else {
      catalogPaths.push(argument);
    }
  }
  if (catalogPaths.length > 1) errors.push("CLI: at most one catalog path is allowed");
  return { catalogPath: catalogPaths[0], errors };
}

function verify(catalogPath) {
  const errors = [];
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    if (catalog && typeof catalog === "object" && catalog.schemaVersion !== 1) {
      errors.push("catalog: schemaVersion must be 1");
    }
    if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.entries)) {
      errors.push("catalog: entries must be an array");
    } else {
      verifyAuthorship(catalog.authorship, errors);
      if (catalog.entries.length === 0) errors.push("catalog: entries must not be empty");
      const seenIds = new Set();
      for (const [index, entry] of catalog.entries.entries()) {
        if (!entry || typeof entry !== "object" || !allowedClassifications.has(entry.classification)) {
          errors.push(`entry ${index}: classification is not allowed`);
          continue;
        }
        if (!isNonEmptyString(entry.id)) errors.push(`entry ${index}: id must be a non-empty string`);
        else if (seenIds.has(entry.id)) errors.push(`entry ${index}: duplicate id ${entry.id}`);
        else seenIds.add(entry.id);
        if (!isNonEmptyString(entry.origin)) errors.push(`entry ${index}: origin must be a non-empty string`);
        if (!isNonEmptyString(entry.reuse)) errors.push(`entry ${index}: reuse must be a non-empty string`);
        const expectedReuse = expectedReuseByClassification.get(entry.classification);
        if (entry.reuse !== expectedReuse) {
          errors.push(`entry ${index}: ${entry.classification} reuse must be ${expectedReuse}`);
        }
        const hasLocalReference = Object.hasOwn(entry, "localPath");
        const hasRemoteReference = Object.hasOwn(entry, "repository") || Object.hasOwn(entry, "commit");
        if (Number(hasLocalReference) + Number(hasRemoteReference) !== 1) {
          errors.push(`entry ${index}: exactly one reference type is required`);
        }
        if (hasLocalReference && !isNonEmptyString(entry.localPath)) {
          errors.push(`entry ${index}: localPath must be a non-empty string`);
        } else if (hasLocalReference) {
          const candidate = resolve(root, entry.localPath);
          if (!isContained(root, candidate)) {
            errors.push(`entry ${index}: localPath escapes repository root`);
          } else if (!existsSync(candidate)) {
            errors.push(`entry ${index}: localPath does not exist`);
          } else if (!isContained(realRoot, realpathSync(candidate))) {
            errors.push(`entry ${index}: localPath resolves outside repository root`);
          }
        }
        if (hasRemoteReference && (typeof entry.commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(entry.commit))) {
          errors.push(`entry ${index}: remote reference requires a complete immutable 40- or 64-character hexadecimal commit SHA`);
        }
        if (hasRemoteReference && !isHttpsRepository(entry.repository)) {
          errors.push(`entry ${index}: repository must be an HTTPS URL without credentials`);
        }
      }
    }
  } catch (error) {
    errors.push(`catalog: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: errors.length === 0, errors };
}

const argv = process.argv.slice(2);
const parsedArgs = parseCliArgs(argv);
const catalogPath = resolve(root, parsedArgs.catalogPath ?? defaultCatalog);
const result = parsedArgs.errors.length > 0
  ? { ok: false, errors: parsedArgs.errors }
  : verify(catalogPath);
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
