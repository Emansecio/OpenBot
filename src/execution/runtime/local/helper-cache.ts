import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { WorkspaceSandbox } from "../../workspace.js";
import { nativePowerShellPath } from "./environment.js";
import { WINDOWS_JOB_SOURCE } from "./windows-job-script.js";

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sourceDigest = digest(WINDOWS_JOB_SOURCE);
const cacheDirectory = "native-helper-cache";
const cacheVersion = `${process.arch}-${sourceDigest}`;
const failure = (): Error => new Error("Native helper cache could not be verified.");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const compiler = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  Add-Type -TypeDefinition $request.source -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll -OutputAssembly $request.target -OutputType ConsoleApplication
  exit 0
} catch { exit 1 }
`;

/** Local generated cache, not an installed addon. Never removes an existing cache version. */
export class NativeJobHelperCache {
  private preparing?: Promise<string>;
  constructor(readonly runtimeRoot: string) {}

  async executable(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    // One compile per cache instance. Every later spawn rechecks files and digest.
    if (!this.preparing) this.preparing = this.prepare(signal).finally(() => { this.preparing = undefined; });
    const result = await this.preparing;
    signal?.throwIfAborted();
    return result;
  }

  private async prepare(signal?: AbortSignal): Promise<string> {
    const root = await WorkspaceSandbox.create(this.runtimeRoot, { allowAncestorLinks: true });
    const directory = await root.resolveDestination(cacheDirectory);
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const cache = await WorkspaceSandbox.create(await root.resolveExisting(cacheDirectory));
    const verify = async (): Promise<string> => {
      const target = await cache.resolveExisting(`${cacheVersion}/supervisor.exe`);
      const manifestPath = await cache.resolveExisting(`${cacheVersion}/manifest.json`);
      const regular = async (path: string, limit: number): Promise<Buffer> => {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > limit) throw failure();
        return readFile(path);
      };
      const bytes = await regular(target, 1024 * 1024);
      const manifest = JSON.parse((await regular(manifestPath, 4096)).toString("utf8")) as Record<string, unknown>;
      if (manifest.schemaVersion !== 1 || manifest.sourceDigest !== sourceDigest || manifest.binaryDigest !== digest(bytes)) throw failure();
      return target;
    };
    const destination = await cache.resolveDestination(cacheVersion);
    try { await lstat(destination); return await verify(); }
    catch (error) { if (!missing(error)) throw failure(); }
    signal?.throwIfAborted();
    const stagingName = `.build-${randomUUID()}`;
    const staging = await cache.resolveDestination(stagingName);
    await mkdir(staging);
    try {
      const target = await cache.resolveDestination(`${stagingName}/supervisor.exe`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(nativePowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(compiler, "utf16le").toString("base64")], {
          windowsHide: true, shell: false, cwd: staging, stdio: ["pipe", "ignore", "ignore"],
          // Framework csc cannot use a non-ANSI absolute TEMP. A relative TEMP
          // resolves inside this verified staging cwd, including Unicode roots.
          // Minimal env: the compiler needs no gateway tokens or provider keys.
          env: {
            SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
            SystemDrive: process.env.SystemDrive ?? "C:",
            TEMP: ".",
            TMP: ".",
          },
        });
        let expired = false;
        const abort = (): void => { child.kill(); };
        const timer = setTimeout(() => { expired = true; abort(); }, 20_000); timer.unref();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdin.on("error", () => undefined);
        child.once("error", () => undefined);
        child.once("close", (code) => {
          clearTimeout(timer); signal?.removeEventListener("abort", abort);
          if (code === 0 && !expired && !signal?.aborted) resolve(); else reject(failure());
        });
        child.stdin.end(`${JSON.stringify({ source: WINDOWS_JOB_SOURCE, target })}\n`);
      });
      signal?.throwIfAborted();
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 1024 * 1024) throw failure();
      const binaryDigest = digest(await readFile(target));
      const manifestPath = await cache.resolveDestination(`${stagingName}/manifest.json`);
      const handle = await open(manifestPath, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, sourceDigest, binaryDigest })); await handle.sync(); } finally { await handle.close(); }
      await cache.resolveExisting(stagingName);
      await cache.resolveDestination(cacheVersion);
      try { await rename(staging, destination); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      return await verify();
    } finally {
      try { await cache.resolveExisting(stagingName); await rm(staging, { recursive: true }); }
      catch (error) { if (!missing(error) && (error as { code?: string })?.code !== "not_found") throw error; }
    }
  }
}
