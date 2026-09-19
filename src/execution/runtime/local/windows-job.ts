import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { WINDOWS_JOB_SCRIPT } from "./windows-job-script.js";
import { nativePowerShellPath } from "./environment.js";
import { NativeJobHelperCache } from "./helper-cache.js";
import type { RuntimeLeaseRecord, RuntimeResourceReconciler } from "../recovery.js";

export const NATIVE_JOB_KIND = "native-job-v1" as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
export const nativeJobName = (bootId: string, leaseId: string): string => {
  if (!UUID.test(bootId) || !UUID.test(leaseId)) throw new Error("Native job identity is invalid.");
  return `Global\\OpenBot.Native.v1.${bootId}.${leaseId}`;
};
export const nativeSandboxId = (leaseId: string): string => `${NATIVE_JOB_KIND}-${leaseId}`;
const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_JOB_SCRIPT, "utf16le").toString("base64")];
const unavailable = (): Error => new Error("Native process ownership could not be verified.");

/** CRT quoting, not shell quoting. No request text is interpolated into PowerShell. */
export const quoteWindowsArgument = (argument: string): string =>
  `"${argument.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;

export type JobFrame = { kind: "stdout" | "stderr"; data: string } | { kind: "stdin-error" } | { kind: "exit"; code: number };

/** One bounded foreground lease. Its named outer job also owns the supervisor. */
export class WindowsJobProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<number | null>;
  private readonly ready: Promise<void>;
  private stopping?: Promise<void>;
  private used = false;
  private onFrame?: (frame: JobFrame) => void;
  private protocolFailure = false;
  private verifiedExit = false;
  private stopped!: () => void;
  private readonly stopCompleted = new Promise<void>((resolve) => { this.stopped = resolve; });

  constructor(readonly name: string, environment: NodeJS.ProcessEnv = process.env, private readonly executable?: string) {
    if (process.platform !== "win32") throw unavailable();
    if (!executable && args[args.length - 1]!.length > 31_000) throw unavailable();
    this.child = spawn(executable ?? nativePowerShellPath(), executable ? [] : args, { windowsHide: true, shell: false, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const child = this.child;
    this.closed = new Promise((resolve) => { child.once("close", resolve); });
    child.on("error", () => { this.protocolFailure = true; });
    // Diagnostics never include commands/env/compiler output. Bound and discard.
    child.stderr.resume();
    child.stdin.on("error", () => { this.protocolFailure = true; });
    let ready = false;
    this.ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line: string) => {
        try {
          if (line.length > 16_384) throw unavailable();
          const frame = JSON.parse(line) as JobFrame | { kind: "ready" };
          if (frame.kind === "ready" && !ready) { ready = true; resolve(); return; }
          if (!ready || !this.used || !["stdout", "stderr", "stdin-error", "exit"].includes(frame.kind)) throw unavailable();
          if (frame.kind === "exit") {
            if (!Number.isInteger(frame.code) || frame.code < 0 || frame.code > 0xFFFF_FFFF) throw unavailable();
            this.verifiedExit = true;
          }
          this.onFrame?.(frame as JobFrame);
        } catch { this.protocolFailure = true; child.kill(); reject(unavailable()); }
      });
      void this.closed.then(() => { if (!ready) reject(unavailable()); });
    });
    // Acquire installs the rejection observer before yielding.
    void this.ready.catch(() => undefined);
    child.stdin.write(`${JSON.stringify({ mode: "create", name })}\n`);
  }

  async start(signal?: AbortSignal): Promise<void> {
    let interrupt!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
    const abort = (): void => { this.child.stdin.destroy(); this.child.kill(); interrupt(unavailable()); };
    const timer = setTimeout(abort, 20_000);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { await Promise.race([this.ready, interrupted]); signal?.throwIfAborted(); }
    catch (error) { await this.stop(); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  async run(command: { executable: string; argv: string[]; cwd: string; stdin?: string; env: NodeJS.ProcessEnv }, onFrame: (frame: JobFrame) => void): Promise<boolean> {
    if (this.used || this.stopping) throw unavailable();
    this.used = true;
    this.onFrame = onFrame;
    this.child.stdin.write(`${JSON.stringify({ command: [command.executable, ...command.argv].map(quoteWindowsArgument).join(" "), cwd: command.cwd, stdin: command.stdin ?? "", env: command.env })}\n`);
    await Promise.race([this.closed, this.stopCompleted]);
    return !this.protocolFailure;
  }

  async stop(): Promise<void> {
    if (!this.stopping) this.stopping = (async () => {
      // ChildProcess uses its original process handle. Never taskkill a recycled PID.
      this.child.stdin.destroy();
      this.child.kill();
      const waitClosed = async (): Promise<void> => {
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([this.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 3000); timer.unref(); })]); }
        finally { if (timer) clearTimeout(timer); }
      };
      try { await waitClosed(); }
      catch { await recoverWindowsJob(this.name, this.executable); await waitClosed(); }
      if (this.used && !this.verifiedExit) await recoverWindowsJob(this.name, this.executable);
    })().catch((error: unknown) => { this.stopping = undefined; throw error; }).finally(() => this.stopped());
    await this.stopping;
  }
}

export async function recoverWindowsJob(name: string, executable?: string): Promise<void> {
  const identity = /^Global\\OpenBot\.Native\.v1\.([a-f0-9-]+)\.([a-f0-9-]+)$/iu.exec(name);
  if (!identity || !UUID.test(identity[1]!) || !UUID.test(identity[2]!)) throw unavailable();
  if (process.platform !== "win32") throw unavailable();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable ?? nativePowerShellPath(), executable ? [] : args, { windowsHide: true, shell: false, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => { child.kill(); reject(unavailable()); }, 20_000);
    timer.unref();
    child.stdin.on("error", () => undefined);
    child.once("error", () => { clearTimeout(timer); reject(unavailable()); });
    child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(unavailable()); });
    child.stdin.end(`${JSON.stringify({ mode: "recover", name })}\n`);
  });
}

export class LocalRuntimeReconciler implements RuntimeResourceReconciler {
  private readonly helper?: NativeJobHelperCache;
  constructor(options: { runtimeRoot?: string } = {}) {
    if (options.runtimeRoot !== undefined) this.helper = new NativeJobHelperCache(options.runtimeRoot);
  }
  async reconcileLease(record: RuntimeLeaseRecord): Promise<void> {
    if (record.recoveryKind !== NATIVE_JOB_KIND || record.temporaryId !== `tmp-${record.leaseId}` ||
      (record.pending !== true && record.sandboxId !== nativeSandboxId(record.leaseId))) throw unavailable();
    const name = nativeJobName(record.runtimeBootId, record.leaseId);
    await recoverWindowsJob(name, await this.helper?.executable());
  }
  async killSandbox(): Promise<void> { throw unavailable(); }
  async removeTemporary(): Promise<void> { throw unavailable(); }
}
