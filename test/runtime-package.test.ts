import { mkdtemp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The packager is an executable ESM script and intentionally has no emitted declaration.
import { assertLinuxX64Elf, digestRootfs, isAllowedBaseDanglingSymlink, packageGuestRuntime, validateBaseRootfs, validateRootfs } from "../scripts/package-runtime-guest.mjs";

const execFileAsync = promisify(execFile);

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-runtime-package-test-"));
  temporaryRoots.push(root);
  return root;
};

const fakeElf = () => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  bytes.writeUInt16LE(3, 16); // ET_DYN (PIE)
  bytes.writeUInt16LE(62, 18); // x86-64
  return bytes;
};

const makeBaseRootfs = async (root: string) => {
  const baseRootfs = join(root, "base-rootfs");
  await mkdir(join(baseRootfs, "etc"), { recursive: true });
  await mkdir(join(baseRootfs, "bin"), { recursive: true });
  await mkdir(join(baseRootfs, "sbin"), { recursive: true });
  await writeFile(join(baseRootfs, "etc", "passwd"), "root:x:0:0:root:/root:/bin/sh\n");
  await writeFile(join(baseRootfs, "bin", "sh"), "#!/bin/sh\n");
  await writeFile(join(baseRootfs, "sbin", "mount.drvfs"), "#!/bin/sh\n");
  return baseRootfs;
};

describe("guest runtime package hardening", () => {
  it("accepts only a Linux x86-64 executable ELF", () => {
    expect(assertLinuxX64Elf(fakeElf())).toMatchObject({ type: 3, machine: 62, class: 64 });
    const invalidHeaders: Array<[string, (bytes: Buffer) => void, RegExp]> = [
      ["magic", (bytes) => { bytes[0] = 0; }, /not an ELF/iu],
      ["class", (bytes) => { bytes[4] = 1; }, /little-endian 64-bit/iu],
      ["endianness", (bytes) => { bytes[5] = 2; }, /little-endian 64-bit/iu],
      ["version", (bytes) => { bytes[6] = 2; }, /unsupported ELF version/iu],
      ["ABI", (bytes) => { bytes[7] = 9; }, /Linux\/SYSV/iu],
      ["type", (bytes) => { bytes.writeUInt16LE(1, 16); }, /executable ELF/iu],
      ["machine", (bytes) => { bytes.writeUInt16LE(40, 18); }, /x86-64 Linux/iu],
    ];
    for (const [label, mutate, message] of invalidHeaders) {
      const invalid = fakeElf();
      mutate(invalid);
      expect(() => assertLinuxX64Elf(invalid), label).toThrow(message);
    }
    expect(() => assertLinuxX64Elf(Buffer.alloc(19))).toThrow(/complete ELF header/iu);
  });

  it("walks rootfs in a stable order and includes type/mode in its digest", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "usr", "bin"), { recursive: true });
    await writeFile(join(root, "é-first"), "unicode");
    await writeFile(join(root, "z-last"), "z");
    await writeFile(join(root, "usr", "bin", "node"), "node");
    const first = await validateRootfs(root);
    const second = await validateRootfs(root);
    expect(Buffer.compare(Buffer.from("z-last"), Buffer.from("é-first"))).toBeLessThan(0);
    expect(first.map((entry: { type: string; name: string }) => `${entry.type}:${entry.name}`)).toEqual([
      "directory:usr",
      "directory:usr/bin",
      "file:usr/bin/node",
      "file:z-last",
      "file:é-first",
    ]);
    const digest = await digestRootfs(root, first);
    await expect(digestRootfs(root, second)).resolves.toBe(digest);
    const modeChanged = first.map((entry: { name: string; mode: number }) => (
      entry.name === "usr/bin/node" ? { ...entry, mode: entry.mode ^ 0o111 } : entry
    ));
    await expect(digestRootfs(root, modeChanged)).resolves.not.toBe(digest);
    const typeChanged = first.map((entry: { name: string; type: string }) => (
      entry.name === "usr/bin/node" ? { ...entry, type: "directory" } : entry
    ));
    await expect(digestRootfs(root, typeChanged)).resolves.not.toBe(digest);
  });

  it("rejects a rootfs link that escapes the guest root", async () => {
    const root = await makeRoot();
    const rootfs = join(root, "rootfs");
    await mkdir(rootfs, { recursive: true });
    await mkdir(join(root, "outside"), { recursive: true });
    await symlink(join(root, "outside"), join(rootfs, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(validateRootfs(rootfs)).rejects.toThrow(/symbolic link/iu);
  });

  it("requires a bootable outer rootfs and permits only the WSL /init helper link", async () => {
    const root = await makeRoot();
    const baseRootfs = await makeBaseRootfs(root);
    await expect(validateBaseRootfs(baseRootfs)).resolves.toBeInstanceOf(Array);

    await rm(join(baseRootfs, "etc", "passwd"));
    await expect(validateBaseRootfs(baseRootfs)).rejects.toThrow(/etc\/passwd/iu);
    await writeFile(join(baseRootfs, "etc", "passwd"), "root:x:0:0:root:/root:/bin/sh\n");
    await rm(join(baseRootfs, "bin", "sh"));
    await expect(validateBaseRootfs(baseRootfs)).rejects.toThrow(/bin\/sh/iu);
    await writeFile(join(baseRootfs, "bin", "sh"), "#!/bin/sh\n");

    expect(isAllowedBaseDanglingSymlink("sbin/mount.drvfs", "/init")).toBe(true);
    expect(isAllowedBaseDanglingSymlink("sbin/other", "/init")).toBe(false);
    expect(isAllowedBaseDanglingSymlink("sbin/mount.drvfs", "/missing")).toBe(false);

    if (process.platform !== "win32") {
      await rm(join(baseRootfs, "sbin", "mount.drvfs"));
      await symlink("/init", join(baseRootfs, "sbin", "mount.drvfs"), "file");
      expect(await readlink(join(baseRootfs, "sbin", "mount.drvfs"))).toBe("/init");
      await expect(validateBaseRootfs(baseRootfs)).resolves.toBeInstanceOf(Array);
      await rm(join(baseRootfs, "sbin", "mount.drvfs"));
      await symlink("missing", join(baseRootfs, "sbin", "mount.drvfs"), "file");
      await expect(validateBaseRootfs(baseRootfs)).rejects.toThrow(/dangling symbolic link/iu);
    }
  });

  it("cleans staging after tar failure and never leaves a partial package", async () => {
    const root = await makeRoot();
    const binary = join(root, "supervisor");
    const rootfs = join(root, "rootfs");
    const baseRootfs = await makeBaseRootfs(root);
    const output = join(root, "out", "openbot-runtime-package.tar");
    await writeFile(binary, fakeElf());
    await mkdir(rootfs, { recursive: true });
    await writeFile(join(rootfs, "hello"), "guest");

    await expect(packageGuestRuntime({ binary, rootfs, baseRootfs, output, tarExecutable: "definitely-not-a-real-tar" })).rejects.toThrow();
    const leftovers = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.name.startsWith(".openbot-runtime-package-"));
    expect(leftovers).toHaveLength(0);
    const outputLeftovers = (await readdir(join(root, "out"), { withFileTypes: true }))
      .filter((entry) => entry.name.startsWith(".openbot-runtime-package-"));
    expect(outputLeftovers).toHaveLength(0);
    await expect(readFile(output)).rejects.toThrow();
  });

  it("writes the driver sidecar manifest next to a successful archive", async () => {
    const root = await makeRoot();
    const binary = join(root, "supervisor");
    const rootfs = join(root, "rootfs");
    const baseRootfs = await makeBaseRootfs(root);
    const output = join(root, "out", "openbot-runtime-package.tar");
    const manifestPath = join(root, "out", "manifest.json");
    await writeFile(binary, fakeElf());
    await mkdir(rootfs, { recursive: true });
    await writeFile(join(rootfs, "hello"), "guest");

    const tarExecutable = process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
    const result = await packageGuestRuntime({ binary, rootfs, baseRootfs, output, manifestPath, tarExecutable });
    expect(result.manifestPath).toBe(manifestPath);
    const firstArchive = await readFile(output);
    expect(firstArchive).toBeInstanceOf(Buffer);
    await expect(readFile(manifestPath, "utf8").then((value) => JSON.parse(value))).resolves.toEqual(result.manifest);

    const listing = (await execFileAsync(tarExecutable, ["-tf", output])).stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((entry) => entry.replace(/^\.\//u, ""));
    expect(listing).toContain("etc/passwd");
    expect(listing).toContain("bin/sh");
    expect(listing).toContain("sbin/mount.drvfs");
    expect(listing).toContain("usr/lib/openbot/supervisor");
    expect(listing).toContain("usr/lib/openbot/rootfs/hello");
    expect(listing).toContain("etc/openbot/guest-policy.json");
    const policy = JSON.parse((await execFileAsync(tarExecutable, ["-xOf", output, "etc/openbot/guest-policy.json"]))
      .stdout) as Record<string, unknown>;
    expect(policy).toEqual({
      schemaVersion: 1,
      networkProfile: "none",
      executables: ["node", "python3", "python", "git", "corepack", "npm"],
    });
    const wslConfig = (await execFileAsync(tarExecutable, ["-xOf", output, "etc/wsl.conf"]))
      .stdout;
    expect(wslConfig).toContain("systemd=false");
    expect(wslConfig).not.toContain("systemd=true");

    // Validate the digest against the tree actually shipped in the archive,
    // including the supervisor-required mountpoint directories. The source
    // fixture intentionally lacks those directories, so hashing it directly
    // would be a false positive.
    const extracted = join(root, "extracted");
    await mkdir(extracted, { recursive: true });
    await execFileAsync(tarExecutable, ["-xf", output, "-C", extracted]);
    const packagedRootfs = join(extracted, "usr", "lib", "openbot", "rootfs");
    const packagedEntries = await validateRootfs(packagedRootfs);
    await expect(digestRootfs(packagedRootfs, packagedEntries)).resolves.toBe(result.manifest.rootfsDigest.slice("sha256:".length));
    expect(result.manifest.rootfsDigest).not.toBe(`sha256:${await digestRootfs(rootfs)}`);

    await packageGuestRuntime({ binary, rootfs, baseRootfs, output, manifestPath, tarExecutable });
    await expect(readFile(output)).resolves.toEqual(firstArchive);
  });
});
