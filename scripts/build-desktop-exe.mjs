import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertNoReparseAncestors, assertNoReparsePath, isMainModule, parseArgs, randomSuffix } from "./release-common.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// OpenBot.cmd selects the installed release, including after update/rollback.
export async function buildDesktopExe(root) {
  if (process.platform !== "win32") throw new Error("OpenBot.exe requires Windows");
  if (!root) throw new Error("--root must name an existing OpenBot installation");
  root = resolve(root);
  await assertNoReparseAncestors(root);
  await assertNoReparsePath(join(root, "OpenBot.cmd"));
  const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const executable = join(root, "OpenBot.exe");
  const staging = join(root, `.OpenBot-${randomSuffix()}.exe`);
  await assertNoReparsePath(executable, { allowMissing: true });
  try {
    await promisify(execFile)(compiler, [
      "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
      "/reference:System.Windows.Forms.dll",
      `/win32icon:${join(sourceRoot, "assets", "openbot.ico")}`,
      `/out:${staging}`, join(sourceRoot, "scripts", "OpenBotLauncher.cs"),
    ], { windowsHide: true, timeout: 30_000 });
    await assertNoReparsePath(executable, { allowMissing: true });
    await fs.rename(staging, executable);
    return { ok: true, executable };
  } finally {
    await fs.rm(staging, { force: true });
  }
}

if (isMainModule(import.meta.url)) {
  buildDesktopExe(parseArgs(process.argv.slice(2)).root)
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
