import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import type { ExecutionBackend, ExecutionErrorCode, ExecutionRequest, ExecutionResult, WhatsappOp } from "../execution/contracts.js";
import { MAX_WHATSAPP_OUTPUT_BYTES, MAX_WHATSAPP_TIMEOUT_MS } from "../execution/contracts.js";

export const WHATSAPP_HOST_TARGET = "whatsapp";

export interface WhatsappRunSpec {
  executable: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  pathPrefix?: string;
}

export interface WhatsappRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  outputLimitExceeded: boolean;
}

export interface WhatsappProcessRunner {
  run(spec: WhatsappRunSpec, signal?: AbortSignal): Promise<WhatsappRunResult>;
}

export interface WhatsappHostOptions {
  runner?: WhatsappProcessRunner;
  wacliPath?: string;
  scriptsDir?: string;
  pythonPath?: string;
}

const failure = (code: ExecutionErrorCode, message: string): ExecutionResult => ({
  ok: false,
  operation: "whatsapp",
  code,
  message,
});

export function defaultWacliPath(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "wacli", "wacli.exe");
}

export function defaultWhatsappScriptsDir(): string {
  return join(homedir(), ".codex", "skills", "whatsapp", "scripts");
}

const WINDOWS_PROCESS_ENV = [
  "SYSTEMROOT", "SystemRoot", "WINDIR", "windir", "SYSTEMDRIVE",
  "TEMP", "TMP", "PATHEXT", "COMSPEC", "ComSpec",
] as const;

export function hostWhatsappEnv(wacliPath: string): Record<string, string> {
  const env: Record<string, string> = {
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
    USERPROFILE: process.env.USERPROFILE ?? homedir(),
    HOME: process.env.HOME ?? homedir(),
    PATH: hostWhatsappPath(wacliPath),
    Path: hostWhatsappPath(wacliPath),
    WACLI_ACCOUNT: process.env.WACLI_ACCOUNT ?? "work",
  };
  for (const key of WINDOWS_PROCESS_ENV) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) env[key] = value;
  }
  const systemRoot = env.SYSTEMROOT || env.SystemRoot || env.WINDIR || env.windir || "C:\\Windows";
  env.SYSTEMROOT = systemRoot;
  env.SystemRoot = systemRoot;
  env.WINDIR = env.WINDIR || env.windir || systemRoot;
  env.windir = env.windir || env.WINDIR;
  if (!env.PATHEXT) env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC";
  const temp = env.TEMP || env.TMP || join(env.LOCALAPPDATA || tmpdir(), "Temp");
  env.TEMP = env.TEMP || temp;
  env.TMP = env.TMP || temp;
  if (!env.COMSPEC && !env.ComSpec) {
    env.COMSPEC = join(systemRoot, "System32", "cmd.exe");
    env.ComSpec = env.COMSPEC;
  }
  return env;
}

export function hostWhatsappPath(wacliPath: string, inherited = process.env.PATH ?? ""): string {
  const dir = join(wacliPath, "..");
  if (!inherited) return dir;
  const parts = inherited.split(";");
  if (parts.some((part) => part.toLowerCase() === dir.toLowerCase())) return inherited;
  return `${dir};${inherited}`;
}

export function spawnWhatsappProcess(spec: WhatsappRunSpec, signal?: AbortSignal): Promise<WhatsappRunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: null, durationMs: 0, outputLimitExceeded: false });
      return;
    }
    const child = spawn(spec.executable, spec.argv, {
      cwd: spec.cwd,
      env: hostWhatsappEnv(spec.pathPrefix ?? spec.executable),
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitExceeded = false;
    let settled = false;
    const finish = (result: WhatsappRunResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve(result);
    };
    const onAbort = () => {
      child.kill();
      finish({ stdout, stderr, exitCode: null, durationMs: Date.now() - started, outputLimitExceeded });
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill();
    }, spec.timeoutMs);
    timer.unref();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_WHATSAPP_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > MAX_WHATSAPP_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill();
        return;
      }
      stderr += chunk;
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, exitCode: code, durationMs: Date.now() - started, outputLimitExceeded });
    });
  });
}

function truncate(value: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= MAX_WHATSAPP_OUTPUT_BYTES) return { text: value, truncated: false };
  let text = value;
  while (Buffer.byteLength(text, "utf8") > MAX_WHATSAPP_OUTPUT_BYTES) text = text.slice(0, Math.max(0, text.length - 32));
  return { text, truncated: true };
}

export class WhatsappHostBackend implements ExecutionBackend {
  private readonly runner: WhatsappProcessRunner;
  private readonly wacliPath: string;
  private readonly scriptsDir: string;
  private readonly pythonPath: string;

  constructor(options: WhatsappHostOptions = {}) {
    this.runner = options.runner ?? { run: spawnWhatsappProcess };
    this.wacliPath = options.wacliPath ?? defaultWacliPath();
    this.scriptsDir = options.scriptsDir ?? defaultWhatsappScriptsDir();
    this.pythonPath = options.pythonPath ?? process.env.OPENBOT_PYTHON ?? (process.platform === "win32" ? "py" : "python");
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (request.operation !== "whatsapp") {
      return { ok: false, operation: request.operation, code: "unsupported", message: "Operation is not a WhatsApp host request." };
    }
    if (!existsSync(this.wacliPath)) {
      return failure("not_found", "WhatsApp host CLI is not installed.");
    }
    let tempDir: string | undefined;
    try {
      const spec = this.specFor(request, (dir) => {
        tempDir = dir;
      });
      const ran = await this.runner.run(spec, signal);
      const stdout = truncate(ran.stdout);
      const stderr = truncate(ran.stderr);
      if (ran.outputLimitExceeded) return failure("output_limit", "WhatsApp host output exceeded the limit.");
      if (signal?.aborted) return failure("aborted", "WhatsApp host request was aborted.");
      if (ran.durationMs >= spec.timeoutMs && ran.exitCode === null) {
        return failure("timed_out", "WhatsApp host request timed out.");
      }
      if (ran.exitCode !== 0) {
        return {
          ok: false,
          operation: "whatsapp",
          code: "io_error",
          message: stderr.text.trim() || stdout.text.trim() || "WhatsApp host command failed.",
        };
      }
      return {
        ok: true,
        operation: "whatsapp",
        op: request.op,
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: ran.exitCode,
        durationMs: ran.durationMs,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "missing-script") {
        return failure("not_found", "WhatsApp host scripts are not installed.");
      }
      return failure("io_error", "WhatsApp host command failed.");
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private specFor(request: Extract<ExecutionRequest, { operation: "whatsapp" }>, rememberTemp: (dir: string) => void): WhatsappRunSpec {
    const timeoutMs = MAX_WHATSAPP_TIMEOUT_MS;
    const cwd = existsSync(this.scriptsDir) ? this.scriptsDir : homedir();
    const pathPrefix = this.wacliPath;
    if (request.op === "doctor") {
      return { executable: this.wacliPath, argv: ["doctor", "--read-only", "--json"], cwd, timeoutMs, pathPrefix };
    }
    if (request.op === "messages_list") {
      const argv = ["messages", "list", "--chat", request.chat ?? "", "--json"];
      if (request.limit !== undefined) argv.push("--limit", String(request.limit));
      return { executable: this.wacliPath, argv, cwd, timeoutMs, pathPrefix };
    }
    const script = this.scriptFor(request.op);
    if (!existsSync(script)) {
      throw new Error("missing-script");
    }
    const argv = this.pythonArgv(script, request, rememberTemp);
    return { executable: this.pythonPath, argv, cwd, timeoutMs, pathPrefix: this.wacliPath };
  }

  private scriptFor(op: WhatsappOp): string {
    const name = op === "sweep" ? "puxar.py" : op === "send" ? "send.py" : "baixar.py";
    return join(this.scriptsDir, name);
  }

  private pythonArgv(
    script: string,
    request: Extract<ExecutionRequest, { operation: "whatsapp" }>,
    rememberTemp: (dir: string) => void,
  ): string[] {
    const prefix = this.pythonPath === "py" || this.pythonPath.endsWith("\\py.exe") || this.pythonPath.endsWith("/py")
      ? ["-3", script]
      : [script];
    if (request.op === "sweep") return [...prefix, "--sweep"];
    if (request.op === "download") {
      const argv = [...prefix, "--chat", request.chat ?? ""];
      if (request.mediaId) argv.push("--id", request.mediaId);
      return argv;
    }
    const dir = mkdtempSync(join(tmpdir(), "openbot-wa-"));
    rememberTemp(dir);
    const file = join(dir, "message.txt");
    writeFileSync(file, request.text ?? "", "utf8");
    const argv = [...prefix, "--to", request.chat ?? "", "--msg-file", file];
    if (request.etapa) argv.push("--etapa", request.etapa);
    return argv;
  }
}

export function composeWhatsappHostBackend(delegate: ExecutionBackend, host: ExecutionBackend = new WhatsappHostBackend()): ExecutionBackend {
  return {
    execute(request, signal) {
      return request.operation === "whatsapp" ? host.execute(request, signal) : delegate.execute(request, signal);
    },
  };
}
