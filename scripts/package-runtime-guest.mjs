import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  chmod,
  lstat,
  lutimes,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT_PREFIX = ".openbot-runtime-package-";
const ARCHIVE_TEMP_PREFIX = ".openbot-runtime-package-archive-";
const DETERMINISTIC_DATE = new Date("2000-01-01T00:00:00.000Z");
const GUEST_POLICY = Object.freeze({
  schemaVersion: 1,
  networkProfile: "none",
  executables: Object.freeze(["node", "python3", "python", "git", "corepack", "npm"]),
});

const pathKey = (value) => resolve(value).replace(/[\\/]+$/, "").toLowerCase();

export const isPathWithin = (parent, candidate) => {
  const parentKey = pathKey(parent);
  const candidateKey = pathKey(candidate);
  const descendant = relative(parentKey, candidateKey);
  return descendant === "" || (!descendant.startsWith("..") && !isAbsolute(descendant));
};

const isMissing = (error) => error && typeof error === "object" && error.code === "ENOENT";

// Rust's supervisor orders digest entries by the raw Linux pathname bytes.
// UTF-8 is the representation used by the Linux rootfs produced by the WSL
// build, and Buffer.compare gives the same byte-wise ordering on Windows and
// Linux (unlike localeCompare).
const comparePathBytes = (left, right) => Buffer.from(left).compare(Buffer.from(right));

export const isAllowedBaseDanglingSymlink = (name, target) => name === "sbin/mount.drvfs" && target === "/init";

/**
 * Reject symlinked path components in host-controlled input paths. A symlink
 * inside a Linux rootfs is handled separately because normal rootfs images
 * legitimately contain links such as /lib64 -> usr/lib64.
 */
export async function assertNoSymlinkPathComponents(inputPath, label) {
  const target = resolve(inputPath);
  const root = parse(target).root;
  let current = root;
  const parts = target.slice(root.length).split(/[\\/]+/u).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symbolic-link path component: ${current}`);
  }
}

export async function assertRegularFile(inputPath, label) {
  const metadata = await lstat(inputPath).catch((error) => {
    if (isMissing(error)) throw new Error(`${label} does not exist: ${inputPath}`);
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a regular file: ${inputPath}`);
  return metadata;
}

export async function assertDirectory(inputPath, label) {
  const metadata = await lstat(inputPath).catch((error) => {
    if (isMissing(error)) throw new Error(`${label} does not exist: ${inputPath}`);
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be a regular directory: ${inputPath}`);
  return metadata;
}

/**
 * Validate a supervisor as the exact guest binary we support today: a
 * little-endian 64-bit x86 Linux ELF (ET_EXEC or PIE ET_DYN). This is a
 * structural gate; static linking remains a separate Linux toolchain gate.
 */
export function assertLinuxX64Elf(bytes, label = "guest supervisor") {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 20) throw new Error(`${label} is not a complete ELF header.`);
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error(`${label} is not an ELF binary.`);
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error(`${label} must be a little-endian 64-bit ELF.`);
  if (bytes[6] !== 1) throw new Error(`${label} has an unsupported ELF version.`);
  if (bytes[7] !== 0 && bytes[7] !== 3) throw new Error(`${label} is not a Linux/SYSV ELF binary.`);
  const type = bytes.readUInt16LE(16);
  if (type !== 2 && type !== 3) throw new Error(`${label} is not an executable ELF.`);
  const machine = bytes.readUInt16LE(18);
  if (machine !== 62) throw new Error(`${label} must target x86-64 Linux.`);
  return { type, machine, class: 64, littleEndian: true };
}

export async function validateSupervisorBinary(binary) {
  await assertNoSymlinkPathComponents(binary, "guest supervisor");
  await assertRegularFile(binary, "guest supervisor");
  const header = await readFile(binary, { encoding: null });
  assertLinuxX64Elf(header, "guest supervisor");
}

const safeSymlinkTarget = async (linkPath, rootfs, target, options = {}) => {
  const label = options.label ?? "Guest rootfs";
  const name = relative(rootfs, linkPath).replaceAll("\\", "/");
  if (target.includes("\0")) throw new Error(`${label} contains a symbolic link with NUL: ${linkPath}`);
  // Linux absolute links are rooted at the guest root, not at the Windows
  // drive root. Windows UNC/drive links are never valid guest links.
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(target)) {
    throw new Error(`${label} contains an absolute host symbolic link: ${linkPath}`);
  }
  const lexicalTarget = target.startsWith("/")
    ? resolve(rootfs, `.${target}`)
    : resolve(dirname(linkPath), target);
  if (!isPathWithin(rootfs, lexicalTarget)) throw new Error(`${label} symbolic link escapes rootfs: ${linkPath}`);
  if (options.allowWslInitLink && isAllowedBaseDanglingSymlink(name, target)) return;
  try {
    await lstat(lexicalTarget);
  } catch (error) {
    if (isMissing(error)) throw new Error(`${label} contains a dangling symbolic link: ${linkPath}`, { cause: error });
    throw error;
  }
};

const walkRootfs = async (rootfs, options = {}) => {
  const label = options.label ?? "Guest rootfs";
  const entries = [];
  const visit = async (directory) => {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => comparePathBytes(left.name, right.name));
    for (const child of children) {
      const childPath = join(directory, child.name);
      const metadata = await lstat(childPath);
      const name = relative(rootfs, childPath).replaceAll("\\", "/");
      if (metadata.isSymbolicLink()) {
        const target = await readlink(childPath);
        await safeSymlinkTarget(childPath, rootfs, target, options);
        entries.push({ name, type: "symlink", mode: metadata.mode & 0o7777, target });
      } else if (metadata.isDirectory()) {
        entries.push({ name, type: "directory", mode: metadata.mode & 0o7777 });
        await visit(childPath);
      } else if (metadata.isFile()) {
        entries.push({ name, type: "file", mode: metadata.mode & 0o7777, path: childPath });
      } else {
        throw new Error(`${label} contains an unsupported entry: ${childPath}`);
      }
    }
  };
  await visit(rootfs);
  return entries;
};

export async function validateRootfs(rootfs) {
  const root = resolve(rootfs);
  await assertNoSymlinkPathComponents(root, "guest rootfs");
  await assertDirectory(root, "guest rootfs");
  return walkRootfs(root);
}

const assertOuterGuestPath = async (baseRootfs, guestPath, label) => {
  const target = join(baseRootfs, ...guestPath.split("/").filter(Boolean));
  const metadata = await lstat(target).catch((error) => {
    if (isMissing(error)) throw new Error(`Guest base rootfs is missing ${guestPath}.`);
    throw error;
  });
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new Error(`Guest base rootfs ${label} is invalid: ${guestPath}`);
  }
  return { target, metadata };
};

export async function validateBaseRootfs(baseRootfs) {
  const root = resolve(baseRootfs);
  await assertNoSymlinkPathComponents(root, "guest base rootfs");
  await assertDirectory(root, "guest base rootfs");
  const entries = await walkRootfs(root, {
    label: "Guest base rootfs",
    // WSL injects /init after import. This single well-known link is the only
    // dangling link accepted in an outer distro image.
    allowWslInitLink: true,
  });

  const passwdPath = join(root, "etc", "passwd");
  await assertRegularFile(passwdPath, "guest base rootfs /etc/passwd");
  const rootRecord = (await readFile(passwdPath, "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.split(":"))
    .find((fields) => fields[0] === "root");
  if (
    !rootRecord || rootRecord.length !== 7 || rootRecord[2] !== "0" || rootRecord[3] !== "0" ||
    !rootRecord[5]?.startsWith("/") || !rootRecord[6]?.startsWith("/")
  ) throw new Error("Guest base rootfs /etc/passwd has no valid root uid/gid 0 account.");

  await assertOuterGuestPath(root, "/bin/sh", "shell");
  const mountDrvfs = await assertOuterGuestPath(root, "/sbin/mount.drvfs", "WSL drvfs helper");
  if (mountDrvfs.metadata.isSymbolicLink() && await readlink(mountDrvfs.target) !== "/init") {
    throw new Error("Guest base rootfs /sbin/mount.drvfs symlink must target /init.");
  }

  for (const reserved of ["usr/lib/openbot", "etc/openbot", "manifest.json"]) {
    const reservedPath = join(root, ...reserved.split("/"));
    const metadata = await lstat(reservedPath).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (metadata) throw new Error(`Guest base rootfs contains reserved OpenBot path: /${reserved}`);
  }
  return entries;
}

export async function digestFile(inputPath) {
  return createHash("sha256").update(await readFile(inputPath)).digest("hex");
}

export async function digestRootfs(rootfs, entries) {
  const checkedEntries = [...(entries ?? await validateRootfs(rootfs))]
    .sort((left, right) => comparePathBytes(left.name, right.name));
  const hash = createHash("sha256");
  for (const entry of checkedEntries) {
    hash.update(entry.type).update("\0").update(entry.name).update("\0");
    hash.update(String(entry.mode)).update("\0");
    if (entry.type === "file") hash.update(await readFile(entry.path));
    if (entry.type === "symlink") hash.update(entry.target);
    hash.update("\0");
  }
  return hash.digest("hex");
}

const normalizeTreeTimestamps = async (root) => {
  const visit = async (directory) => {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = join(directory, child.name);
      if (child.isDirectory()) await visit(childPath);
      try {
        if (child.isSymbolicLink()) await lutimes(childPath, DETERMINISTIC_DATE, DETERMINISTIC_DATE);
        else await utimes(childPath, DETERMINISTIC_DATE, DETERMINISTIC_DATE);
      } catch {
        // Timestamp normalization is best effort on filesystems that do not
        // expose link timestamps. The tar --mtime flag remains active.
      }
    }
  };
  await visit(root);
  try { await utimes(root, DETERMINISTIC_DATE, DETERMINISTIC_DATE); } catch { /* best effort */ }
};

const replaceFile = async (temporary, target, label) => {
  const existing = await lstat(target).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`${label} target is not a regular file: ${target}`);
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!existing) throw error;
    await rm(target, { force: true });
    await rename(temporary, target);
  }
};

const writeJsonAtomically = async (target, value) => {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await replaceFile(temporary, target, "manifest");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const tarArgs = (tarExecutable, archive, packageRoot, deterministic) => {
  const args = [];
  if (deterministic) args.push("--mtime=2000-01-01");
  args.push("-cf", archive, "-C", packageRoot, ".");
  return args;
};

const createArchive = async ({ tarExecutable, archive, packageRoot }) => {
  try {
    await execFileAsync(tarExecutable, tarArgs(tarExecutable, archive, packageRoot, true), { windowsHide: true });
  } catch (error) {
    // Some older tar implementations do not support --mtime. Retry without
    // that optional reproducibility flag, while preserving the package.
    await rm(archive, { force: true }).catch(() => undefined);
    await execFileAsync(tarExecutable, tarArgs(tarExecutable, archive, packageRoot, false), { windowsHide: true }).catch((retryError) => {
      retryError.cause = error;
      throw retryError;
    });
  }
};

export async function packageGuestRuntime(options = {}) {
  const binaryValue = options.binary ?? process.env.OPENBOT_GUEST_BINARY;
  const rootfsValue = options.rootfs ?? process.env.OPENBOT_GUEST_ROOTFS;
  const baseRootfsValue = options.baseRootfs ?? process.env.OPENBOT_GUEST_BASE_ROOTFS;
  if (!binaryValue || !rootfsValue || !baseRootfsValue) {
    throw new Error("Set OPENBOT_GUEST_BINARY, OPENBOT_GUEST_ROOTFS and OPENBOT_GUEST_BASE_ROOTFS before packaging the guest runtime.");
  }
  const binary = resolve(binaryValue);
  const rootfs = resolve(rootfsValue);
  const baseRootfs = resolve(baseRootfsValue);
  const output = resolve(options.output ?? process.env.OPENBOT_GUEST_PACKAGE ?? join("runtime", "guest", "openbot-runtime-package.tar"));
  const manifestPath = resolve(options.manifestPath ?? process.env.OPENBOT_GUEST_MANIFEST ?? join(dirname(output), "manifest.json"));
  const runtimeVersion = options.runtimeVersion ?? process.env.OPENBOT_RUNTIME_VERSION ?? "dev";
  const supervisorVersion = options.supervisorVersion ?? process.env.OPENBOT_GUEST_VERSION ?? "0.1.0";

  if (output === manifestPath) throw new Error("Guest package archive and external manifest must be different files.");
  await assertNoSymlinkPathComponents(binary, "guest supervisor");
  await assertNoSymlinkPathComponents(rootfs, "guest rootfs");
  await assertNoSymlinkPathComponents(baseRootfs, "guest base rootfs");
  await assertNoSymlinkPathComponents(dirname(output), "guest package output");
  await assertNoSymlinkPathComponents(dirname(manifestPath), "guest manifest output");
  if (
    isPathWithin(rootfs, output) || isPathWithin(rootfs, manifestPath) ||
    isPathWithin(baseRootfs, output) || isPathWithin(baseRootfs, manifestPath)
  ) {
    throw new Error("Guest package output must not be inside a source rootfs.");
  }
  if (isPathWithin(rootfs, baseRootfs) || isPathWithin(baseRootfs, rootfs)) {
    throw new Error("Guest base rootfs and nested runtime rootfs must not overlap.");
  }
  await validateSupervisorBinary(binary);
  await validateRootfs(rootfs);
  await validateBaseRootfs(baseRootfs);

  const packageRoot = join(dirname(output), `${PACKAGE_ROOT_PREFIX}${process.pid}-${randomUUID()}`);
  const archiveTemporary = join(dirname(output), `${ARCHIVE_TEMP_PREFIX}${process.pid}-${randomUUID()}.tar`);
  try {
    await cp(baseRootfs, packageRoot, { recursive: true, dereference: false, errorOnExist: false, verbatimSymlinks: true });
    await mkdir(join(packageRoot, "usr", "lib", "openbot", "rootfs"), { recursive: true });
    await mkdir(join(packageRoot, "etc", "openbot"), { recursive: true });
    await cp(binary, join(packageRoot, "usr", "lib", "openbot", "supervisor"), { dereference: false });
    await chmod(join(packageRoot, "usr", "lib", "openbot", "supervisor"), 0o755);
    await cp(rootfs, join(packageRoot, "usr", "lib", "openbot", "rootfs"), { recursive: true, dereference: false, errorOnExist: false, verbatimSymlinks: true });
    const packagedRootfs = join(packageRoot, "usr", "lib", "openbot", "rootfs");
    for (const mountpoint of ["workspace", "tmp", "run", "proc", "dev"]) {
      await mkdir(join(packagedRootfs, mountpoint), { recursive: true });
    }
    // The supervisor hashes the rootfs that is actually shipped under
    // /usr/lib/openbot/rootfs. Compute the digest only after the mandatory
    // mountpoint directories have been added; hashing the source tree here
    // would make every imported runtime fail closed with a false mismatch.
    const packagedRootfsEntries = await validateRootfs(packagedRootfs);
    const packagedRootfsDigest = await digestRootfs(packagedRootfs, packagedRootfsEntries);
    // Alpine minirootfs does not ship systemd. Explicitly keep WSL's systemd
    // integration disabled so boot does not emit a misleading failed user
    // session and the guest remains a plain init/WSL environment.
    await writeFile(join(packageRoot, "etc", "wsl.conf"), "[boot]\nsystemd=false\n\n[automount]\nenabled=false\n\n[interop]\nenabled=false\nappendWindowsPath=false\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(join(packageRoot, "etc", "openbot", "guest-policy.json"), `${JSON.stringify(GUEST_POLICY, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const manifest = {
      schemaVersion: 1,
      runtimeVersion,
      supervisorVersion,
      supervisorDigest: `sha256:${await digestFile(join(packageRoot, "usr", "lib", "openbot", "supervisor"))}`,
      rootfsDigest: `sha256:${packagedRootfsDigest}`,
    };
    await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(packageRoot, "etc", "openbot", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await normalizeTreeTimestamps(packageRoot);
    await mkdir(dirname(output), { recursive: true });
    const defaultTar = process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  await createArchive({ tarExecutable: options.tarExecutable ?? process.env.OPENBOT_TAR ?? defaultTar, archive: archiveTemporary, packageRoot });
    await replaceFile(archiveTemporary, output, "guest package archive");
    await writeJsonAtomically(manifestPath, manifest);
    return { output, manifestPath, manifest };
  } finally {
    await rm(packageRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(archiveTemporary, { force: true }).catch(() => undefined);
  }
}

const isMain = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await packageGuestRuntime();
    console.log(result.output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
