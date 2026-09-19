import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
// @ts-expect-error -- no declaration file is emitted for scripts/*.mjs
import { buildDesktopExe } from "../scripts/build-desktop-exe.mjs";
// @ts-expect-error -- no declaration file is emitted for scripts/*.mjs
import { managedReleaseShortcuts, writeReleaseShortcuts } from "../scripts/install.mjs";

it.skipIf(process.platform !== "win32")("launches the adjacent command from an EXE and preserves executable shortcut ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot exe & spaces-"));
  try {
    await writeFile(join(root, "OpenBot.cmd"), '@echo off\r\necho started> "%~dp0started.txt"\r\necho stdout\r\necho stderr 1>&2\r\nexit /b 0\r\n');
    const { executable } = await buildDesktopExe(root);
    const binary = await readFile(executable);
    expect(binary.subarray(0, 2).toString()).toBe("MZ");
    const pe = binary.readUInt32LE(0x3c);
    expect(binary.readUInt16LE(pe + 24 + 68)).toBe(2); // Windows GUI subsystem
    await promisify(execFile)(executable, [], { cwd: tmpdir(), windowsHide: true, timeout: 15_000 });
    expect((await readFile(join(root, "started.txt"), "utf8")).trim()).toBe("started");
    expect(await readdir(join(root, "logs"))).toEqual([]);
    const shortcuts = { desktop: join(root, "OpenBot.lnk") };
    await writeReleaseShortcuts(root, shortcuts);
    expect(await managedReleaseShortcuts(root, { shortcuts })).toEqual(shortcuts);
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command",
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${shortcuts.desktop.replaceAll("'", "''")}'); $s.TargetPath`,
    ], { windowsHide: true });
    expect(stdout.trim()).toBe(executable);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 45_000);
