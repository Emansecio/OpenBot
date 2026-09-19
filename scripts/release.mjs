import { existsSync, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rcedit } from "rcedit";
import {
  PRODUCT_NAME,
  RELEASE_SCHEMA_VERSION,
  assertPreflight,
  assertNoReparseAncestors,
  assertNoReparsePath,
  assertNoReparseTree,
  copyTree,
  fileSha256,
  isMainModule,
  parseArgs,
  pathExists,
  randomSuffix,
  releaseIdFor,
  releaseFileName,
  removeTree,
  safeVersion,
  treeDigest,
  writeLifecycleWrappers,
  writeVersionLauncher,
} from "./release-common.mjs";
import { verifyBackendArtifacts } from "./verify-backend-artifacts.mjs";

// Keep packaging local and deterministic: all inputs are paths already present
// on the build machine. No npm install, download, signing, or update service is
// invoked by this script.
async function copyFile(source, destination) {
  await assertNoReparsePath(source);
  await assertNoReparseAncestors(destination);
  await fs.mkdir(dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  await assertNoReparsePath(destination);
}

async function readPackageVersion(sourceRoot) {
  const packageJson = JSON.parse(await fs.readFile(join(sourceRoot, "package.json"), "utf8"));
  return { packageJson, version: safeVersion(packageJson.version) };
}

export function productionPackagePaths(packageLock) {
  const packages = packageLock && typeof packageLock === "object" ? packageLock.packages : null;
  if (!packages || typeof packages !== "object") return null;
  return Object.entries(packages)
    .filter(([path, metadata]) => path.startsWith("node_modules/") && metadata?.dev !== true)
    .map(([path]) => path.slice("node_modules/".length).replaceAll("\\", "/"));
}

function packagePathAllowed(relativePath, allowedPaths) {
  if (allowedPaths === null || relativePath === "") return true;
  return allowedPaths.some((allowed) => allowed === relativePath || relativePath.startsWith(`${allowed}/`) || allowed.startsWith(`${relativePath}/`));
}

async function sourceBuildId(sourceRoot, inputs) {
  const hash = createHash("sha256");
  for (const input of inputs) {
    if (!existsSync(input)) continue;
    const stat = await fs.stat(input);
    const digest = stat.isDirectory() ? await treeDigest(input) : await fileSha256(input);
    hash.update(relative(sourceRoot, input).replaceAll("\\", "/")).update("\0").update(digest).update("\0");
  }
  return hash.digest("hex");
}

async function zipDirectory(sourceRoot, destination) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = `Compress-Archive -Path ${quote(join(sourceRoot, "*"))} -DestinationPath ${quote(destination)} -Force`;
  const { execFile: execFileCallback } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFileCallback)("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

export async function buildRelease(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot());
  const outputRoot = resolve(options.outputRoot ?? join(sourceRoot, "release"));
  const { packageJson, version: packageVersion } = await readPackageVersion(sourceRoot);
  const version = safeVersion(options.version ?? packageVersion);
  const platform = String(options.platform ?? process.platform);
  const arch = String(options.arch ?? process.arch);
  if (platform !== "win32") throw new Error(`Windows release packaging requires win32, got ${platform}`);
  if (arch !== "x64") throw new Error(`Unsupported Windows architecture: ${arch}; only x64 DPAPI is currently produced`);

  const nodeExecutable = resolve(options.nodeExecutable ?? process.execPath);
  const electronDist = resolve(options.electronDist ?? join(sourceRoot, "node_modules", "electron", "dist"));
  const sourceDist = resolve(options.distRoot ?? join(sourceRoot, "dist"));
  // Never package a stale backend tree, including an explicitly custom
  // distRoot. Fixture packagers may provide a source root without a TypeScript
  // source tree to exercise publication mechanics; there is no source/output
  // parity to check in that deliberately minimal fixture.
  if (existsSync(join(sourceRoot, "src"))) {
    const backendArtifacts = verifyBackendArtifacts({ sourceRoot, distRoot: sourceDist });
    if (!backendArtifacts.ok) {
      throw new Error(`Backend artifacts are invalid:\n${backendArtifacts.errors.join("\n")}`);
    }
  }
  const sourceClientDist = resolve(options.clientDist ?? join(sourceRoot, "client", "extracted", "dist"));
  const sourceNodeModules = resolve(options.nodeModules ?? join(sourceRoot, "node_modules"));
  let allowedProductionPackages = null;
  try {
    allowedProductionPackages = productionPackagePaths(JSON.parse(await fs.readFile(join(sourceRoot, "package-lock.json"), "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const dpapiRelative = `app/native/dpapi/win32-${arch}/openbot-dpapi.node`;
  const dpapiSource = resolve(options.dpapiNative ?? join(sourceRoot, "native", "dpapi", `win32-${arch}`, "openbot-dpapi.node"));
  const sourceIcon = resolve(options.icon ?? join(sourceRoot, "assets", "openbot.ico"));
  const sourceWindowIcon = resolve(options.windowIcon ?? join(sourceRoot, "assets", "openbot.png"));
  const buildId = options.buildId ?? await sourceBuildId(sourceRoot, [
    join(sourceRoot, "package.json"),
    join(sourceRoot, "package-lock.json"),
    join(sourceRoot, "tsconfig.json"),
    join(sourceRoot, "src"),
    sourceDist,
    join(sourceRoot, "scripts"),
    sourceClientDist,
    join(sourceRoot, "assets"),
  ]);
  const releaseId = releaseIdFor(version, buildId);
  const packageName = releaseFileName({ version, releaseId, platform, arch });
  const outputDirectory = join(outputRoot, packageName);
  const stagingDirectory = join(outputRoot, `.${packageName}.${randomSuffix()}.staging`);
  const zipPath = join(outputRoot, `${packageName}.zip`);
  const zipStagingPath = join(outputRoot, `.${packageName}.${randomSuffix()}.staging.zip`);
  const sidecarPath = join(outputRoot, `${packageName}.manifest.json`);
  const sidecarStagingPath = join(outputRoot, `.${packageName}.${randomSuffix()}.manifest.staging`);

  await fs.mkdir(outputRoot, { recursive: true });
  await assertNoReparseTree(outputRoot);
  await removeTree(stagingDirectory);
  await fs.rm(zipStagingPath, { force: true });
  await fs.rm(sidecarStagingPath, { force: true });

  try {
    await fs.mkdir(stagingDirectory, { recursive: true });
    await copyFile(nodeExecutable, join(stagingDirectory, "runtime", "node.exe"));
    await copyTree(electronDist, join(stagingDirectory, "runtime", "electron"));
    await copyFile(sourceIcon, join(stagingDirectory, "assets", "openbot.ico"));
    await copyFile(sourceWindowIcon, join(stagingDirectory, "assets", "openbot.png"));
    await rcedit(join(stagingDirectory, "runtime", "electron", "electron.exe"), { icon: sourceIcon });
    await copyTree(sourceDist, join(stagingDirectory, "app", "dist"), {
      filter: (source) => !/\.(?:d\.ts|d\.ts\.map|js\.map)$/iu.test(source),
    });
    await copyTree(sourceClientDist, join(stagingDirectory, "app", "client", "extracted", "dist"), {
      filter: (source) => !/\.map$/iu.test(source),
    });
    const aboutPath = join(stagingDirectory, "app", "client", "extracted", "dist", "renderer", "assets", "openbot-local-settings.js");
    if (existsSync(aboutPath)) {
      const aboutSource = await fs.readFile(aboutPath, "utf8");
      const stamped = aboutSource.replace(
        /\["Version 0\.16\.0", "Versão [^"]+"\]/u,
        `["Version 0.16.0", "Versão ${version} · build ${buildId.slice(0, 16)}"]`,
      );
      if (stamped === aboutSource && aboutSource.includes("Version 0.16.0")) throw new Error("OpenBot About version marker could not be stamped");
      await fs.writeFile(aboutPath, stamped, "utf8");
    }
    await copyTree(sourceNodeModules, join(stagingDirectory, "app", "node_modules"), {
      filter: (source) => {
        const normalized = source.replaceAll("\\", "/");
        const dependencyPath = relative(sourceNodeModules, source).replaceAll("\\", "/");
        // Electron is already copied as a runtime. Keeping a second 350 MB
        // copy in app/node_modules makes the local package needlessly large.
        return packagePathAllowed(dependencyPath, allowedProductionPackages)
          && !normalized.includes("/node_modules/electron/")
          && !normalized.endsWith("/node_modules/electron")
          && !normalized.includes("/node_modules/@electron/");
      },
    });
    if (existsSync(dpapiSource)) {
      await copyFile(dpapiSource, join(stagingDirectory, dpapiRelative));
    } else if (existsSync(join(sourceRoot, "src"))) {
      throw new Error(`Missing DPAPI native addon for win32-${arch}: ${dpapiSource}`);
    }
    await fs.writeFile(
      join(stagingDirectory, "app", "package.json"),
      `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`,
      "utf8",
    );
    await copyFile(
      join(sourceRoot, "scripts", "openbot-browser-host.cjs"),
      join(stagingDirectory, "app", "scripts", "openbot-browser-host.cjs"),
    );
    await copyFile(join(sourceRoot, "scripts", "openbot-electron.cjs"), join(stagingDirectory, "app", "scripts", "openbot-electron.cjs"));
    await copyFile(join(sourceRoot, "scripts", "execution-diagnostics.mjs"), join(stagingDirectory, "app", "scripts", "execution-diagnostics.mjs"));
    const extractedPackage = join(sourceRoot, "client", "extracted", "package.json");
    try {
      await copyFile(extractedPackage, join(stagingDirectory, "app", "client", "extracted", "package.json"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const scriptName of ["launch.mjs", "shutdown-gateway.mjs", "release-common.mjs", "install.mjs", "update.mjs", "uninstall.mjs", "recovery-center.mjs", "shortcut-appid.mjs"]) {
      await copyFile(join(sourceRoot, "scripts", scriptName), join(stagingDirectory, "scripts", scriptName));
    }
    await writeVersionLauncher(stagingDirectory);
    await writeLifecycleWrappers(stagingDirectory);

    const manifest = {
      schemaVersion: RELEASE_SCHEMA_VERSION,
      product: PRODUCT_NAME,
      version,
      productVersion: version,
      buildId,
      releaseId,
      platform,
      arch,
      appId: options.appId ?? "local.openbot",
      entrypoint: `${PRODUCT_NAME}.cmd`,
      artifactType: "portable-directory",
      runtime: {
        node: "runtime/node.exe",
        electron: "runtime/electron/electron.exe",
        native: "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        ...(existsSync(dpapiSource) ? { dpapi: dpapiRelative } : {}),
      },
      requiredFiles: [
        "assets/openbot.ico",
        "assets/openbot.png",
        "runtime/node.exe",
        "runtime/electron/electron.exe",
        "app/scripts/openbot-browser-host.cjs",
        "app/scripts/openbot-electron.cjs",
        "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        ...(existsSync(dpapiSource) ? [dpapiRelative] : []),
        "app/dist/main.js",
        "app/scripts/execution-diagnostics.mjs",
        "app/client/extracted/dist/electron-main/main.cjs",
        "app/client/extracted/dist/renderer/index.html",
        `${PRODUCT_NAME}.cmd`,
        `${PRODUCT_NAME}.vbs`,
        "Uninstall-OpenBot.cmd",
        "Repair-OpenBot.cmd",
        "Update-OpenBot.cmd",
        "Rollback-OpenBot.cmd",
        "Recovery-OpenBot.cmd",
      "scripts/launch.mjs",
      "scripts/shutdown-gateway.mjs",
      "scripts/release-common.mjs",
        "scripts/install.mjs",
        "scripts/update.mjs",
        "scripts/uninstall.mjs",
        "scripts/recovery-center.mjs",
        "scripts/shortcut-appid.mjs",
      ],
      signed: false,
      signature: null,
      security: "unsigned-local",
      generatedAt: new Date().toISOString(),
      packageJsonVersion: version,
    };
    const manifestPath = join(stagingDirectory, "manifest.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const contentSha256 = await treeDigest(stagingDirectory, { exclude: ["manifest.json"] });
    manifest.contentSha256 = contentSha256;
    manifest.sha256 = contentSha256;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assertPreflight(stagingDirectory, { arch });

    let artifact = outputDirectory;
    let sha256 = contentSha256;
    if (options.skipZip !== true) {
      await zipDirectory(stagingDirectory, zipStagingPath);
      artifact = zipPath;
      sha256 = await fileSha256(zipStagingPath);
    }
    const sidecar = {
      ...manifest,
      artifact: artifact,
      artifactName: artifact.split(/[\\/]/).pop(),
      artifactSha256: sha256,
      sha256,
      payloadSha256: contentSha256,
      signed: false,
      signature: null,
      security: "unsigned-local",
    };
    await fs.writeFile(sidecarStagingPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

    const backupSuffix = randomSuffix();
    const backups = {
      directory: `${outputDirectory}.previous-${backupSuffix}`,
      zip: `${zipPath}.previous-${backupSuffix}`,
      sidecar: `${sidecarPath}.previous-${backupSuffix}`,
    };
    const oldArtifacts = {
      directory: await pathExists(outputDirectory),
      zip: options.skipZip !== true && await pathExists(zipPath),
      sidecar: await pathExists(sidecarPath),
    };
    const promoted = { directory: false, zip: false, sidecar: false };
    try {
      if (oldArtifacts.directory) await fs.rename(outputDirectory, backups.directory);
      if (oldArtifacts.zip) await fs.rename(zipPath, backups.zip);
      if (oldArtifacts.sidecar) await fs.rename(sidecarPath, backups.sidecar);
      await fs.rename(stagingDirectory, outputDirectory);
      promoted.directory = true;
      if (options.failPublicationAt === "after-directory") throw new Error("Simulated release publication failure after directory promotion");
      if (options.skipZip !== true) {
        await fs.rename(zipStagingPath, zipPath);
        promoted.zip = true;
      }
      await fs.rename(sidecarStagingPath, sidecarPath);
      promoted.sidecar = true;
      await removeTree(backups.directory).catch(() => undefined);
      if (oldArtifacts.zip) await fs.rm(backups.zip, { force: true }).catch(() => undefined);
      if (oldArtifacts.sidecar) await fs.rm(backups.sidecar, { force: true }).catch(() => undefined);
    } catch (error) {
      if (promoted.sidecar) await fs.rm(sidecarPath, { force: true });
      if (promoted.zip) await fs.rm(zipPath, { force: true });
      if (promoted.directory) await removeTree(outputDirectory);
      if (oldArtifacts.directory && await pathExists(backups.directory)) await fs.rename(backups.directory, outputDirectory);
      if (oldArtifacts.zip && await pathExists(backups.zip)) await fs.rename(backups.zip, zipPath);
      if (oldArtifacts.sidecar && await pathExists(backups.sidecar)) await fs.rename(backups.sidecar, sidecarPath);
      throw error;
    }
    return {
      root: outputDirectory,
      artifact,
      manifest: sidecar,
      manifestPath: sidecarPath,
    };
  } catch (error) {
    await removeTree(stagingDirectory);
    await fs.rm(zipStagingPath, { force: true });
    await fs.rm(sidecarStagingPath, { force: true });
    throw error;
  }
}

export function defaultSourceRoot(metaUrl = import.meta.url) {
  return resolve(fileURLToPath(new URL("../", metaUrl)));
}

export function helpText() {
  return [
    "OpenBot local Windows release pipeline",
    "",
    "Usage: node scripts/release.mjs [options]",
    "  --source-root <dir>  checkout root (defaults to this checkout)",
    "  --output <dir>       artifact output directory",
    "  --version <version>  override package version",
    "  --platform <name>    target platform (win32)",
    "  --arch <name>        target architecture (x64 only; arm64/ia32 are not produced)",
    "  --skip-zip           keep the portable directory only",
    "  --fail-publication-at test hook for transactional rollback",
    "  --help               show this help",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help === true) {
    process.stdout.write(`${helpText()}\n`);
    return null;
  }
  if (args["print-source-root"] === true) {
    const sourceRoot = defaultSourceRoot(import.meta.url);
    process.stdout.write(`${sourceRoot}\n`);
    return sourceRoot;
  }
  const result = await buildRelease({
    sourceRoot: args["source-root"],
    outputRoot: args.output,
    version: args.version,
    platform: args.platform,
    arch: args.arch,
    nodeExecutable: args.node,
    electronDist: args["electron-dist"],
    distRoot: args.dist,
    clientDist: args["client-dist"],
    nodeModules: args["node-modules"],
    skipZip: args["skip-zip"] === true,
    failPublicationAt: args["fail-publication-at"],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  });
}
