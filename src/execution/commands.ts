import { lstat, open, opendir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { win32 as path } from "node:path";
import { Worker } from "node:worker_threads";

import type { ExecutionRequest, ExecutionResult } from "./contracts.js";
import { WorkspaceError, WorkspaceSandbox } from "./workspace.js";

type CommandRequest = Extract<ExecutionRequest, { operation: "command.run" }>;

const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_DIRS = 2_000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 1_000;
const MAX_SEARCH_REGEX_CHARS = 200;
/** Wall-clock budget for one file's regex scan, worker startup included. */
const REGEX_FILE_DEADLINE_MS = 2_000;

type PathMetadata = Awaited<ReturnType<typeof lstat>>;

export interface CommandExecutorOptions {
  /** Internal deterministic seam used by race-regression tests. */
  beforePathUse?: (absolute: string) => Promise<void>;
  /** Entries a search must not descend into or read (e.g. protected OpenBot data under a host root). */
  excludePath?: (absolute: string) => boolean;
}

const hasStableIdentity = (metadata: PathMetadata): boolean =>
  Number.isInteger(metadata.dev) && Number.isInteger(metadata.ino) && (metadata.dev !== 0 || metadata.ino !== 0);

const assertStableIdentity = (expected: PathMetadata, actual: PathMetadata): void => {
  if (
    expected.isSymbolicLink() || actual.isSymbolicLink() ||
    !hasStableIdentity(expected) || !hasStableIdentity(actual) ||
    expected.dev !== actual.dev || expected.ino !== actual.ino
  ) {
    throw new WorkspaceError("outside_workspace", "Search path changed during execution.");
  }
};

const assertStablePath = async (absolute: string, expected: PathMetadata): Promise<void> => {
  let actual: PathMetadata;
  try {
    actual = await lstat(absolute);
  } catch {
    throw new WorkspaceError("outside_workspace", "Search path changed during execution.");
  }
  assertStableIdentity(expected, actual);
};

const noFollowReadFlags = (): string | number =>
  process.platform === "win32" ? "r" : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

const openVerifiedFile = async (
  absolute: string,
  expected: PathMetadata,
  options: CommandExecutorOptions,
): Promise<Awaited<ReturnType<typeof open>>> => {
  await options.beforePathUse?.(absolute);
  const handle = await open(absolute, noFollowReadFlags());
  try {
    assertStableIdentity(expected, await handle.stat());
    await assertStablePath(absolute, expected);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

const openVerifiedDirectory = async (
  absolute: string,
  expected: PathMetadata,
  options: CommandExecutorOptions,
): Promise<Awaited<ReturnType<typeof opendir>>> => {
  await options.beforePathUse?.(absolute);
  const directory = await opendir(absolute);
  try {
    await assertStablePath(absolute, expected);
    return directory;
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
};

const unsafeRegex = /(\.\*){2,}|\(\.\*\).*\(\.\*\)|\+\+|\*\*|\{\d{4,}\}|\\[1-9]|\(\?[=!<]/;
const quantifiedGroup = /\(([^()]*)\)[+*{]/g;
const plainAlternative = /^(?:\.|[^.^$*+?()[\]{}|])*$/u;

function splitAlternatives(body: string): string[] | null {
  const alternatives: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of body.replace(/^\?:/u, "")) {
    if (escaped) {
      current += `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      alternatives.push(current);
      current = "";
    } else if (character === "(" || character === ")") {
      return null;
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  alternatives.push(current);
  return alternatives;
}

function hasAmbiguousQuantifiedAlternation(pattern: string): boolean {
  const stack: Array<{ start: number; hasAlternation: boolean }> = [];
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "[") { inClass = true; continue; }
    if (character === "]" && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (character === "(") { stack.push({ start: index, hasAlternation: false }); continue; }
    if (character === "|") { for (const group of stack) group.hasAlternation = true; continue; }
    if (character !== ")") continue;
    const group = stack.pop();
    if (!group?.hasAlternation || !"+*{".includes(pattern[index + 1] ?? "")) continue;
    const alternatives = splitAlternatives(pattern.slice(group.start + 1, index));
    if (alternatives === null || alternatives.some((branch) => !plainAlternative.test(branch))) return true;
    const literals = alternatives.map((branch) => {
      let literal = "";
      let escapedLiteral = false;
      for (const character of branch) {
        if (escapedLiteral) { literal += character; escapedLiteral = false; }
        else if (character === "\\") escapedLiteral = true;
        else literal += character;
      }
      return literal;
    });
    if (literals.some((branch, branchIndex) => literals.some((other, otherIndex) => branchIndex !== otherIndex && other.startsWith(branch)))) return true;
  }
  return false;
}

export function isSafeSearchRegex(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= MAX_SEARCH_REGEX_CHARS && !unsafeRegex.test(pattern) && !hasAmbiguousQuantifiedAlternation(pattern) && ![...pattern.matchAll(quantifiedGroup)].some((match) => /[+*{]/.test(match[1] ?? ""));
}

const fail = (code: "aborted" | "output_limit" | "io_error" | "not_found" | "outside_workspace" | "access_denied" | "invalid_path", message: string): ExecutionResult => ({
  ok: false,
  operation: "command.run",
  code,
  message,
});

const abort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
};

const normalizedRelative = (root: string, absolute: string): string => path.relative(root, absolute).replaceAll("\\", "/");

async function collectFiles(
  workspace: WorkspaceSandbox,
  roots: readonly string[],
  signal: AbortSignal | undefined,
  options: CommandExecutorOptions,
): Promise<string[]> {
  const pending = [...roots];
  const files: string[] = [];
  let dirs = 0;
  while (pending.length > 0) {
    abort(signal);
    const relative = pending.pop()!;
    const absolute = await workspace.resolveExisting(relative);
    const rootMetadata = await lstat(absolute);
    if (rootMetadata.isSymbolicLink()) throw new WorkspaceError("outside_workspace", "Search path contains a symbolic link or junction.");
    if (rootMetadata.isFile()) {
      files.push(normalizedRelative(workspace.root, absolute));
      if (files.length > MAX_SEARCH_FILES) throw new RangeError("file limit");
      continue;
    }
    if (!rootMetadata.isDirectory()) continue;
    dirs += 1;
    if (dirs > MAX_SEARCH_DIRS) throw new RangeError("directory limit");
    const directory = await openVerifiedDirectory(absolute, rootMetadata, options);
    try {
      for await (const entry of directory) {
        abort(signal);
        if (entry.isSymbolicLink()) continue;
        if (options.excludePath?.(path.join(absolute, entry.name))) continue;
        const child = normalizedRelative(workspace.root, path.join(absolute, entry.name));
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isFile()) {
          files.push(child);
          if (files.length > MAX_SEARCH_FILES) throw new RangeError("file limit");
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function readBounded(
  workspace: WorkspaceSandbox,
  relative: string,
  signal: AbortSignal | undefined,
  options: CommandExecutorOptions,
): Promise<string | null> {
  abort(signal);
  const filename = await workspace.resolveExisting(relative);
  const expected = await lstat(filename);
  if (!expected.isFile() || expected.isSymbolicLink()) return null;
  const handle = await openVerifiedFile(filename, expected, options);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_SEARCH_FILE_BYTES) return null;
    const buffer = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    abort(signal);
    if (buffer.subarray(0, Math.min(bytesRead, 8_192)).includes(0)) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

class RegexTimeoutError extends Error {}

// Self-contained so it runs the same from src (tests) and dist (production).
const REGEX_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const matcher = new RegExp(workerData.pattern, "u");
parentPort.on("message", ({ id, text, limit }) => {
  const matches = [];
  const lines = text.split(/\\r?\\n/u);
  for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
    if (matcher.test(lines[index])) matches.push(index);
  }
  parentPort.postMessage({ id, matches });
});
`;

/**
 * Regex matching off the gateway thread. The static filter above rejects the
 * obvious catastrophic shapes, but it cannot prove a pattern linear; a scan
 * that outlives its deadline (or an abort) terminates the worker instead of
 * freezing every bot and the UI.
 */
class RegexLineMatcher {
  private readonly worker: Worker;
  private nextId = 0;

  constructor(pattern: string) {
    this.worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: { pattern },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    this.worker.unref();
  }

  /** Indexes of the matching lines of `text`, split exactly like the fixed-mode scan. */
  match(text: string, limit: number, signal: AbortSignal | undefined): Promise<number[]> {
    abort(signal);
    const id = this.nextId++;
    return new Promise<number[]>((resolve, reject) => {
      const settle = (outcome: () => void): void => {
        clearTimeout(timer);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        this.worker.off("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
        outcome();
      };
      const onMessage = (message: { id: number; matches: number[] }): void => {
        if (message.id === id) settle(() => resolve(message.matches));
      };
      const onError = (error: Error): void => settle(() => reject(error));
      const onExit = (): void => settle(() => reject(new Error("Regex worker exited.")));
      const onAbort = (): void => settle(() => {
        void this.worker.terminate();
        reject(new DOMException("Aborted", "AbortError"));
      });
      const timer = setTimeout(() => settle(() => {
        void this.worker.terminate();
        reject(new RegexTimeoutError());
      }), REGEX_FILE_DEADLINE_MS);
      this.worker.on("message", onMessage);
      this.worker.once("error", onError);
      this.worker.once("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.worker.postMessage({ id, text, limit });
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}

export class LocalCommandExecutor {
  private constructor(
    private readonly workspace: WorkspaceSandbox,
    private readonly options: CommandExecutorOptions = {},
  ) {}

  static fromWorkspace(workspace: WorkspaceSandbox, options: CommandExecutorOptions = {}): LocalCommandExecutor {
    return new LocalCommandExecutor(workspace, options);
  }

  static async create(root: string): Promise<LocalCommandExecutor> {
    return LocalCommandExecutor.fromWorkspace(await WorkspaceSandbox.create(root));
  }

  async execute(request: CommandRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const started = Date.now();
    try {
      abort(signal);
      const cwd = request.cwd === "." ? "." : normalizedRelative(this.workspace.root, await this.workspace.resolveExisting(request.cwd));
      const roots = request.params.paths.map((item) => item === "." ? cwd : path.join(cwd, item));
      const files = await collectFiles(this.workspace, roots, signal, this.options);
      if (request.command === "search.files") {
        const stdout = files.join("\n");
        return { ok: true, operation: "command.run", command: request.command, stdout, stderr: "", exitCode: 0, durationMs: Date.now() - started };
      }

      const params = request.params as { pattern: string; mode: "fixed" | "regex"; paths: string[] };
      if (params.mode === "regex") {
        if (params.pattern.length > MAX_SEARCH_REGEX_CHARS) {
          return fail("invalid_path", `Regex search patterns are limited to ${MAX_SEARCH_REGEX_CHARS} characters; use a shorter pattern or fixed mode.`);
        }
        if (!isSafeSearchRegex(params.pattern)) {
          return fail("invalid_path", "Regex search pattern was refused: nested or overlapping repetition, lookaround and backreferences can take exponential time. Simplify it or use fixed mode.");
        }
        // Syntax errors surface here, on the gateway thread, before any worker starts.
        new RegExp(params.pattern, "u");
      }
      const matcher = params.mode === "fixed" ? null : new RegexLineMatcher(params.pattern);
      try {
        const output: string[] = [];
        let totalBytes = 0;
        for (const file of files) {
          const text = await readBounded(this.workspace, file, signal, this.options);
          if (text === null) continue;
          totalBytes += Buffer.byteLength(text);
          if (totalBytes > MAX_SEARCH_TOTAL_BYTES) throw new RangeError("byte limit");
          const lines = text.split(/\r?\n/u);
          const hits = matcher
            ? await matcher.match(text, MAX_SEARCH_RESULTS - output.length, signal)
            : lines.flatMap((line, index) => line.includes(params.pattern) ? [index] : []);
          for (const index of hits) {
            output.push(`${file}:${index + 1}:${lines[index]}`);
            if (output.length >= MAX_SEARCH_RESULTS) throw new RangeError("result limit");
          }
        }
        return { ok: true, operation: "command.run", command: request.command, stdout: output.join("\n"), stderr: "", exitCode: output.length > 0 ? 0 : 1, durationMs: Date.now() - started };
      } finally {
        await matcher?.close();
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return fail("aborted", "Execution was aborted.");
      if (error instanceof RegexTimeoutError) {
        return fail("invalid_path", `Regex search pattern took longer than ${REGEX_FILE_DEADLINE_MS / 1000}s on one file and was stopped; simplify it or use fixed mode.`);
      }
      if (error instanceof RangeError) return fail("output_limit", "Search limit was exceeded.");
      if (error instanceof SyntaxError) return fail("invalid_path", "Search pattern is invalid.");
      if (error instanceof WorkspaceError) return fail(error.code, error.message);
      return fail("io_error", "Search could not be completed.");
    }
  }
}
