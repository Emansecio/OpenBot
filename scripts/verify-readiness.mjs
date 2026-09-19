import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, readdir, rm, rmdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const LIVE_SKIP_FILES = ["test/home-acl.test.ts", "test/keystore-dpapi-live.test.ts", "test/host-whatsapp.test.ts"];
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const ownedProcessRootPids = new Set();

export const READINESS_GATES = Object.freeze([
  {
    id: 1,
    label: "sentinela de isolamento de paths",
    commands: [npmStep("keystore isolation", ["test", "--", "test/keystore.test.ts", "test/rpc-send.test.ts", "--maxWorkers=1", "--no-file-parallelism"])],
  },
  { id: 2, label: "lint e typecheck", commands: [npmStep("lint", ["run", "lint"]), npmStep("typecheck", ["run", "typecheck"])] },
  {
    id: 3,
    label: "build e paridade de artefatos",
    commands: [
      npmStep("build", ["run", "build"]),
      npmStep("provenance", ["run", "verify:provenance"]),
      npmStep("renderer boundary", ["run", "verify:renderer-boundary"]),
      npmStep("backend artifacts", ["run", "verify:backend-artifacts"]),
      npmStep("client artifacts", ["run", "verify:client-artifacts"]),
    ],
  },
  {
    id: 4,
    label: "suíte Vitest padrão serial e recuperação de dados",
    commands: [
      npmStep("standard serial suite", ["test", "--", "--maxWorkers=1", "--no-file-parallelism"], { allowedSkipFiles: LIVE_SKIP_FILES, timeoutMs: 30 * 60_000 }),
      npmStep("data recovery", ["exec", "--", "vitest", "run", "test/data-recovery-live.test.ts", "--reporter=json", "--maxWorkers=1", "--no-file-parallelism"], {
        requiredTestFiles: ["test/data-recovery-live.test.ts"],
        requireTestExecution: true,
        resultFormat: "vitest-json",
      }),
    ],
  },
  {
    id: 5,
    label: "core acceptance, chat resilience e Skills/MCP",
    commands: [
      npmStep("core acceptance", ["run", "verify:core:acceptance"]),
      npmStep("chat resilience", ["run", "verify:chat-resilience"]),
      npmStep("Skills/MCP", ["run", "verify:skills-mcp"], { timeoutMs: 30 * 60_000 }),
    ],
  },
  {
    id: 6,
    label: "Local Exec e approvals",
    commands: [npmStep("Local Exec approvals", ["test", "--", "test/execution-approval.test.ts", "test/local-exec-gateway.integration.test.ts", "--maxWorkers=1", "--no-file-parallelism"])],
  },
  {
    id: 7,
    label: "browser Electron offline e público somente leitura",
    commands: [
      npmStep("browser Electron offline", ["run", "verify:e2e:browser"]),
      npmStep("browser público somente leitura", ["run", "verify:browser:public-readonly"]),
    ],
  },
  {
    id: 8,
    label: "desktop clean-profile repetível",
    commands: [
      npmStep("clean-profile round 1", ["run", "verify:clean-profile"]),
      npmStep("clean-profile round 2", ["run", "verify:clean-profile"]),
    ],
  },
  { id: 9, label: "ACL live", commands: [npmStep("ACL live", ["run", "verify:acl:live"])] },
  { id: 10, label: "WSL live", commands: [npmStep("WSL live", ["run", "verify:runtime-wsl-live"], { timeoutMs: 30 * 60_000 })] },
  { id: 11, label: "release lifecycle", commands: [npmStep("release lifecycle", ["run", "verify:release-lifecycle"])] },
  {
    id: 12,
    label: "DPAPI CurrentUser live e restart",
    commands: [
      npmStep("DPAPI artifacts", ["run", "verify:dpapi-artifacts"]),
      npmStep("DPAPI live restart", ["exec", "--", "vitest", "run", "test/keystore-dpapi-live.test.ts", "--reporter=json", "--maxWorkers=1", "--no-file-parallelism"], {
        env: { OPENBOT_RUN_DPAPI_LIVE: "1" },
        requiredTestFiles: ["test/keystore-dpapi-live.test.ts"],
        requireTestExecution: true,
        resultFormat: "vitest-json",
      }),
    ],
  },
  { id: 13, label: "inventário final", commands: [] },
]);

function npmStep(label, args, options = {}) {
  return Object.freeze({ label, args: Object.freeze(args), ...options });
}

export function parseVitestSkipEvidence(rawOutput) {
  const output = String(rawOutput ?? "").replace(ANSI, "");
  let count = 0;
  const files = [];
  for (const line of output.split(/\r?\n/u)) {
    if (/\bTests\b/u.test(line)) {
      const match = line.match(/(\d+)\s+skipped\b/u);
      if (match) count = Number.parseInt(match[1], 10);
    }
    if (!/\bskipped\b/u.test(line)) continue;
    const match = line.match(/(test[\\/][^\s(]+\.test\.ts)\b/u);
    if (!match) continue;
    const normalized = match[1].replaceAll("\\", "/");
    if (!files.includes(normalized)) files.push(normalized);
  }
  return { count, files };
}

function normalizeTestFile(file) {
  return String(file ?? "").replaceAll("\\", "/").replace(/^\.\//u, "");
}

function parseVitestFileEvidence(rawOutput) {
  const output = String(rawOutput ?? "").replace(ANSI, "");
  const files = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*([✓×↓!])\s+(?:.*?\/)?(test[\\/][^\s(]+\.test\.ts)\b/u);
    if (!match) continue;
    const status = match[1] === "✓" ? "passed" : match[1] === "↓" ? "skipped" : "failed";
    files.set(normalizeTestFile(match[2]), status);
  }
  return files;
}

function parseVitestTestSummary(rawOutput) {
  const output = String(rawOutput ?? "").replace(ANSI, "");
  let found = false;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  for (const line of output.split(/\r?\n/u)) {
    if (!/^\s*Tests\b/u.test(line)) continue;
    found = true;
    for (const match of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)\b/gu)) {
      const count = Number.parseInt(match[1], 10);
      if (match[2] === "passed") passed = count;
      else if (match[2] === "failed") failed = count;
      else if (match[2] === "skipped") skipped = count;
      else todo = count;
    }
  }
  return { found, passed, failed, skipped, todo, executed: passed + failed };
}

function extractVitestFilePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  const marker = normalized.lastIndexOf("/test/");
  if (marker >= 0) return normalized.slice(marker + 1);
  return normalizeTestFile(normalized);
}

function parseVitestJsonEvidence(rawOutput) {
  const output = String(rawOutput ?? "").replace(ANSI, "");
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return { valid: false };
  let report;
  try {
    report = JSON.parse(output.slice(start, end + 1));
  } catch {
    return { valid: false };
  }
  if (!report || !Array.isArray(report.testResults)) return { valid: false };
  const files = new Map();
  const skippedFiles = [];
  for (const result of report.testResults) {
    const file = extractVitestFilePath(result?.name);
    if (!file) continue;
    const assertions = Array.isArray(result?.assertionResults) ? result.assertionResults : [];
    const statuses = assertions.map((assertion) => String(assertion?.status ?? ""));
    const status = statuses.includes("failed") ? "failed" : statuses.some((value) => value === "skipped" || value === "pending") ? "skipped" : statuses.includes("todo") ? "todo" : statuses.includes("passed") ? "passed" : "unknown";
    files.set(file, status);
    if (status === "skipped" || status === "todo") skippedFiles.push(file);
  }
  return {
    valid: true,
    files,
    skippedFiles,
    passed: Number(report.numPassedTests) || 0,
    failed: Number(report.numFailedTests) || 0,
    skipped: Number(report.numPendingTests) || 0,
    todo: Number(report.numTodoTests) || 0,
    executed: (Number(report.numPassedTests) || 0) + (Number(report.numFailedTests) || 0),
  };
}

export function evaluateCommandResult({ exitCode, output, allowedSkipFiles = [], requiredTestFiles = [], requireTestExecution = false, resultFormat }) {
  const cleanOutput = String(output ?? "").replace(ANSI, "");
  const skipEvidence = parseVitestSkipEvidence(cleanOutput);
  const allowed = new Set(allowedSkipFiles.map((value) => value.replaceAll("\\", "/")));
  const structuredEvidence = resultFormat === "vitest-json" ? parseVitestJsonEvidence(cleanOutput) : undefined;
  const observedSkipFiles = structuredEvidence?.valid ? [...new Set([...skipEvidence.files, ...structuredEvidence.skippedFiles])] : skipEvidence.files;
  const unexpectedSkipFiles = observedSkipFiles.filter((file) => !allowed.has(file));
  const required = requiredTestFiles.map(normalizeTestFile).filter(Boolean);
  const fileEvidence = structuredEvidence?.valid ? structuredEvidence.files : parseVitestFileEvidence(cleanOutput);
  const missingRequiredTestFiles = required.filter((file) => !fileEvidence.has(file));
  const requiredSkippedFiles = required.filter((file) => fileEvidence.get(file) === "skipped" || skipEvidence.files.includes(file));
  const requiredUnpassedFiles = required.filter((file) => fileEvidence.get(file) !== "passed");
  const testSummary = structuredEvidence?.valid ? structuredEvidence : parseVitestTestSummary(cleanOutput);
  const skippedCount = structuredEvidence?.valid ? structuredEvidence.skipped : skipEvidence.count;
  const explicitBlocked = /["']status["']\s*:\s*["']BLOCKED_ENV["']/u.test(cleanOutput);
  const explicitRed = /["']status["']\s*:\s*["']RED["']/u.test(cleanOutput);

  if (exitCode === 2 || explicitBlocked) {
    return { status: "BLOCKED_ENV", skipped: skippedCount, unexpectedSkipFiles };
  }
  if (exitCode !== 0 || explicitRed) {
    return { status: "RED", skipped: skippedCount, unexpectedSkipFiles };
  }
  if (requireTestExecution && (resultFormat === "vitest-json" && !structuredEvidence?.valid || missingRequiredTestFiles.length > 0 || requiredSkippedFiles.length > 0 || requiredUnpassedFiles.length > 0 || testSummary.skipped > 0 || testSummary.todo > 0 || (!structuredEvidence?.valid && !testSummary.found) || testSummary.executed <= 0)) {
    return {
      status: "RED",
      skipped: skippedCount,
      unexpectedSkipFiles,
      missingRequiredTestFiles,
      requiredSkippedFiles,
      requiredUnpassedFiles,
      executedTests: testSummary.executed,
    };
  }
  if (skippedCount > 0 && (observedSkipFiles.length === 0 || unexpectedSkipFiles.length > 0)) {
    return { status: "RED", skipped: skippedCount, unexpectedSkipFiles: observedSkipFiles.length === 0 ? ["unidentified-skip"] : unexpectedSkipFiles };
  }
  return { status: "GREEN", skipped: skippedCount, unexpectedSkipFiles: [], executedTests: testSummary.executed };
}

async function main() {
  const startedAt = new Date();
  const originalEnv = { ...process.env };
  const parentTemp = resolve(tmpdir());
  const tempRoot = await mkdtemp(join(parentTemp, "openbot-readiness-"));
  assertOwnedTempRoot(tempRoot, parentTemp);
  const realAppData = resolve(originalEnv.APPDATA || join(homedir(), "AppData", "Roaming"));
  const realLocalAppData = resolve(originalEnv.LOCALAPPDATA || join(homedir(), "AppData", "Local"));
  const sensitivePaths = [join(realAppData, "OpenBot", "sand-secrets.json"), join(realAppData, "OpenBot", ".master.key")];
  const sensitiveBefore = await fingerprintPaths(sensitivePaths);
  const packageOverride = originalEnv.OPENBOT_GUEST_PACKAGE || join(realLocalAppData, "OpenBot", "runtime", "staging", "openbot-runtime-package.tar");
  const childEnv = buildIsolatedEnvironment(originalEnv, tempRoot, packageOverride);
  const initial = await captureInventory({ tempRoot, realLocalAppData });
  const results = [];
  let terminalStatus = initialInventoryStatus(initial);

  console.log(`[verify:readiness] TempRoot=${tempRoot}`);
  console.log(`[verify:readiness] initial inventory=${terminalStatus ?? "GREEN"}`);

  if (terminalStatus) {
    results.push({ id: 0, label: "inventário inicial", status: terminalStatus, detail: initialInventoryIssues(initial) });
  } else {
    for (const gate of READINESS_GATES.slice(0, -1)) {
      const environmentBlock = await gateEnvironmentBlock(gate.id, { packageOverride });
      if (environmentBlock) {
        const result = { id: gate.id, label: gate.label, status: "BLOCKED_ENV", reason: environmentBlock, commands: [] };
        results.push(result);
        terminalStatus = "BLOCKED_ENV";
        console.error(`[verify:readiness] GATE ${gate.id} BLOCKED_ENV: ${environmentBlock}`);
        break;
      }

      console.log(`[verify:readiness] GATE ${gate.id}/13 ${gate.label}`);
      const result = await runGate(gate, childEnv);
      results.push(result);
      if (result.status !== "GREEN") {
        terminalStatus = result.status;
        break;
      }
    }
  }

  await rm(join(tempRoot, ".readiness-cache"), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  await pruneEmptyDirectories(tempRoot);
  const sensitiveAfter = await fingerprintPaths(sensitivePaths);
  const finalInventory = await captureInventory({ tempRoot, realLocalAppData, ownedProcessPids: [...ownedProcessRootPids] });
  const finalEvaluation = evaluateFinalInventory({ initial, finalInventory, sensitiveBefore, sensitiveAfter });
  results.push({ id: 13, label: "inventário final", ...finalEvaluation });
  if (finalEvaluation.status !== "GREEN") terminalStatus = "RED";

  let cleanup = "diagnostic-root-preserved";
  if (!terminalStatus) {
    assertOwnedTempRoot(tempRoot, parentTemp);
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await access(tempRoot).then(
      () => { throw new Error("readiness TempRoot still exists after cleanup"); },
      () => undefined,
    );
    cleanup = "temp-root-removed";
  }

  const status = terminalStatus ?? "GREEN";
  const summary = {
    schemaVersion: 1,
    status,
    verdict: status === "GREEN" ? "APTO" : "NÃO APTO",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    tempRoot,
    cleanup,
    gates: results,
    initialInventory: initial,
    finalInventory,
    sensitivePathSentinel: { unchanged: sameJson(sensitiveBefore, sensitiveAfter), paths: sensitivePaths },
  };
  console.log(`[verify:readiness] ${status}; verdict=${summary.verdict}; cleanup=${cleanup}`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = status === "GREEN" ? 0 : status === "BLOCKED_ENV" ? 2 : 1;
}

export async function runGate(gate, baseEnv) {
  const commands = [];
  for (const step of gate.commands) {
    console.log(`[verify:readiness]   ${step.label}`);
    const started = Date.now();
    const child = await runNpm(step.args, { ...baseEnv, ...(step.env ?? {}) }, step.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const evaluation = evaluateCommandResult({
      exitCode: child.exitCode,
      output: child.output,
      allowedSkipFiles: step.allowedSkipFiles,
      requiredTestFiles: step.requiredTestFiles,
      requireTestExecution: step.requireTestExecution,
      resultFormat: step.resultFormat,
    });
    commands.push({ label: step.label, status: evaluation.status, exitCode: child.exitCode, durationMs: Date.now() - started, skipped: evaluation.skipped, unexpectedSkipFiles: evaluation.unexpectedSkipFiles, missingRequiredTestFiles: evaluation.missingRequiredTestFiles ?? [], requiredSkippedFiles: evaluation.requiredSkippedFiles ?? [], requiredUnpassedFiles: evaluation.requiredUnpassedFiles ?? [], executedTests: evaluation.executedTests, timedOut: child.timedOut });
    if (evaluation.status !== "GREEN") {
      console.error(`[verify:readiness]   ${step.label} ${evaluation.status}`);
      return { id: gate.id, label: gate.label, status: evaluation.status, commands };
    }
  }
  console.log(`[verify:readiness] GATE ${gate.id} GREEN`);
  return { id: gate.id, label: gate.label, status: "GREEN", commands };
}

async function runNpm(args, env, timeoutMs) {
  const npmCli = process.env.npm_execpath;
  const executable = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const childArgs = npmCli ? [npmCli, ...args] : args;
  return await new Promise((resolvePromise) => {
    const child = spawn(executable, childArgs, {
      cwd: REPO_ROOT,
      env,
      shell: !npmCli && process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (Number.isSafeInteger(child.pid) && child.pid > 0) ownedProcessRootPids.add(child.pid);
    let output = "";
    let timedOut = false;
    const append = (chunk, stream) => {
      const text = chunk.toString();
      output += text;
      stream.write(text);
    };
    child.stdout.on("data", (chunk) => append(chunk, process.stdout));
    child.stderr.on("data", (chunk) => append(chunk, process.stderr));
    child.on("error", (error) => {
      output += `\nspawn error: ${error.message}\n`;
    });
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateOwnedChild(child.pid);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: timedOut ? 1 : code ?? 1, output, timedOut });
    });
  });
}

async function terminateOwnedChild(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
}

export function buildIsolatedEnvironment(source, tempRoot, packageOverride) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.replaceAll(/[^A-Za-z0-9]+/gu, "_");
    if (
      /^OPENBOT_/iu.test(key) ||
      /^(?:NODE|NPM|PNPM|YARN|BUN|DOCKER|AWS|AZURE|GOOGLE|GCP|OCI|OPENAI|ANTHROPIC|XAI|GH|GITHUB|VAULT|KUBECONFIG)(?:_|$)/iu.test(key) ||
      /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|AUTH(?:ORIZATION)?|AUTH_?TOKEN|AUTHTOKEN|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|DATABASE_?URL|CONNECTION_?STRING)(?:_|$)/iu.test(normalizedKey)
    ) delete env[key];
  }
  Object.assign(env, {
    TEMP: tempRoot,
    TMP: tempRoot,
    APPDATA: join(tempRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(tempRoot, "AppData", "Local"),
    OPENBOT_SHORTCUT_ROOT: join(tempRoot, "Shortcuts"),
    OPENBOT_GUEST_PACKAGE: packageOverride,
    NODE_DISABLE_COMPILE_CACHE: "1",
    NPM_CONFIG_CACHE: join(tempRoot, ".readiness-cache", "npm"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
  return env;
}

async function gateEnvironmentBlock(gateId, { packageOverride }) {
  if (gateId === 9) {
    if (process.platform !== "win32") return "ACL live requires Windows";
    if (!await commandExists("icacls.exe")) return "icacls.exe is unavailable";
  }
  if (gateId === 10) {
    if (process.platform !== "win32") return "WSL live requires Windows";
    if (!await commandExists("wsl.exe")) return "wsl.exe is unavailable";
    if (!await pathExists(packageOverride)) return `runtime guest package unavailable: ${packageOverride}`;
    if (!await pathExists(join(dirname(packageOverride), "manifest.json"))) return "runtime guest manifest is unavailable";
  }
  if (gateId === 12 && process.platform !== "win32") return "DPAPI CurrentUser live requires Windows";
  return null;
}

async function commandExists(command) {
  if (process.platform !== "win32") return true;
  try {
    await execFileAsync("where.exe", [command], { windowsHide: true, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function captureInventory({ tempRoot, realLocalAppData, ownedProcessPids = [] }) {
  const [port1340Free, wsl, rootProcesses, tempEntries, localOperationLocks, staleReadinessRoots] = await Promise.all([
    isPortFree(1340),
    getWslInventory(),
    getRootProcesses(tempRoot, ownedProcessPids),
    listTree(tempRoot),
    findOperationLocks(join(realLocalAppData, "OpenBot")),
    listStaleReadinessRoots(tempRoot),
  ]);
  return {
    port1340Free,
    wsl,
    transientDistros: wsl.names.filter((name) => /^OpenBotRuntimeLive-/u.test(name)),
    rootProcesses,
    tempEntries,
    operationLocks: tempEntries.filter((entry) => isOperationLockName(basename(entry))),
    localOperationLocks,
    staleReadinessRoots,
  };
}

function initialInventoryStatus(inventory) {
  return initialInventoryIssues(inventory).length > 0 ? "RED" : null;
}

function initialInventoryIssues(inventory) {
  const issues = [];
  if (!inventory.port1340Free) issues.push("port 1340 is occupied before the run");
  if (inventory.rootProcesses.length > 0) issues.push("TempRoot process exists before the run");
  if (inventory.tempEntries.length > 0) issues.push("fresh TempRoot is not empty");
  if (inventory.transientDistros.length > 0) issues.push("pre-existing OpenBotRuntimeLive distro found");
  if (inventory.localOperationLocks.length > 0) issues.push("pre-existing OpenBot operation.lock found");
  if (inventory.staleReadinessRoots.length > 0) issues.push("stale readiness TempRoot found");
  return issues;
}

function evaluateFinalInventory({ initial, finalInventory, sensitiveBefore, sensitiveAfter }) {
  const issues = [];
  if (!finalInventory.port1340Free) issues.push("port 1340 remains occupied");
  if (finalInventory.rootProcesses.length > 0) issues.push("owned process remains alive");
  if (finalInventory.tempEntries.length > 0) issues.push("TempRoot contains residual entries");
  if (finalInventory.operationLocks.length > 0) issues.push("operation.lock remains in TempRoot");
  if (!sameJson([...initial.wsl.names].sort(), [...finalInventory.wsl.names].sort())) issues.push("WSL distro names changed");
  if (finalInventory.transientDistros.length > 0) issues.push("temporary WSL distro remains registered");
  if (!sameJson(initial.localOperationLocks, finalInventory.localOperationLocks)) issues.push("real LocalAppData operation.lock inventory changed");
  if (!sameJson(sensitiveBefore, sensitiveAfter)) issues.push("real AppData keystore sentinel changed");
  if (finalInventory.staleReadinessRoots.length > 0) issues.push("stale readiness TempRoot remains");
  return { status: issues.length === 0 ? "GREEN" : "RED", issues };
}

async function fingerprintPaths(paths) {
  return await Promise.all(paths.map(async (path) => {
    try {
      const info = await stat(path);
      const bytes = await readFile(path);
      return { path, exists: true, size: info.size, mtimeMs: info.mtimeMs, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      if (error?.code === "ENOENT") return { path, exists: false };
      throw error;
    }
  }));
}

async function isPortFree(port) {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolvePromise(true)));
  });
}

async function getWslInventory() {
  if (process.platform !== "win32") return { available: false, names: [], error: "not-windows" };
  try {
    const { stdout } = await execFileAsync("wsl.exe", ["--list", "--quiet"], { windowsHide: true, timeout: 20_000, encoding: "utf8" });
    const names = stdout.replaceAll("\0", "").split(/\r?\n/u).map((line) => line.trim().replace(/^\*\s*/u, "")).filter(Boolean);
    return { available: true, names, error: null };
  } catch (error) {
    return { available: false, names: [], error: error.message.slice(0, 256) };
  }
}

export async function getRootProcesses(tempRoot, ownedProcessPids = []) {
  if (process.platform !== "win32") return [];
  const env = { ...process.env, OPENBOT_READINESS_INSPECT_ROOT: tempRoot };
  const script = "@((Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,CommandLine)) | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, timeout: 20_000, env, encoding: "utf8" });
    const text = stdout.trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    const needle = resolve(tempRoot).toLowerCase();
    const ownedPids = new Set(ownedProcessPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0));
    const matches = new Map();
    for (const process of processes) {
      if (
        String(process.CommandLine ?? "").toLowerCase().includes(needle) ||
        String(process.ExecutablePath ?? "").toLowerCase().includes(needle) ||
        ownedPids.has(process.ProcessId)
      ) matches.set(process.ProcessId, process);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const process of processes) {
        if (matches.has(process.ProcessId)) continue;
        if (ownedPids.has(process.ParentProcessId) || matches.has(process.ParentProcessId)) {
          matches.set(process.ProcessId, process);
          changed = true;
        }
      }
    }
    return [...matches.values()];
  } catch (error) {
    return [{ inventoryError: error.message.slice(0, 256) }];
  }
}

async function listTree(root) {
  if (!await pathExists(root)) return [];
  const entries = [];
  async function visit(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      entries.push(relative(root, path));
      if (item.isDirectory() && !item.isSymbolicLink()) await visit(path);
    }
  }
  await visit(root);
  return entries.sort();
}

const isOperationLockName = (name) => /(?:^operation\.lock$|\.openbot-operation\.lock(?:\.stale-.+)?$)/iu.test(name);

export async function findOperationLocks(root, options = {}) {
  if (!await pathExists(root)) return [];
  const readDirectory = options.readDirectory ?? readdir;
  const matches = [];
  async function visit(current, depth) {
    if (depth > 10 || matches.length >= 100) return;
    let entries;
    try {
      entries = await readDirectory(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const item of entries) {
      const path = join(current, item.name);
      if (isOperationLockName(item.name)) matches.push(path);
      if (item.isDirectory() && !item.isSymbolicLink() && !isOperationLockName(item.name)) await visit(path, depth + 1);
    }
  }
  await visit(root, 0);
  return matches.sort();
}

export async function listStaleReadinessRoots(currentRoot) {
  const parent = dirname(currentRoot);
  const currentName = basename(currentRoot).toLowerCase();
  const entries = await readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      return name.startsWith("openbot-readiness-") && name !== currentName;
    })
    .map((entry) => join(parent, entry.name))
    .sort();
}

async function pruneEmptyDirectories(root) {
  if (!await pathExists(root)) return;
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const item of entries) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      await visit(join(current, item.name));
    }
    if (current !== root && (await readdir(current)).length === 0) await rmdir(current);
  }
  await visit(root);
}

function assertOwnedTempRoot(root, parentTemp) {
  const resolvedRoot = resolve(root);
  if (dirname(resolvedRoot).toLowerCase() !== resolve(parentTemp).toLowerCase() || !basename(resolvedRoot).startsWith("openbot-readiness-")) {
    throw new Error(`refusing unsafe readiness TempRoot: ${resolvedRoot}`);
  }
}

async function pathExists(path) {
  try { await lstat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((error) => {
    console.error(`[verify:readiness] RED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
