import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// @ts-expect-error executable ESM script intentionally has no declaration file.
import { getArtifactSigningStatus, verifyArtifactSignature } from "../scripts/artifact-signing.mjs";
// @ts-expect-error executable ESM script intentionally has no declaration file.
import { verifyWindowsArtifactGate } from "../scripts/verify-windows-artifact-gate.mjs";
// @ts-expect-error executable ESM script intentionally has no declaration file.
import { releaseRequiredFiles, treeDigest } from "../scripts/release-common.mjs";

const execFileAsync = promisify(execFile);

async function freshRoot(prefix = "openbot-windows-test-") { return mkdtemp(join(tmpdir(), prefix)); }

async function validReleaseFixture() {
  const fixtureRoot = await freshRoot("openbot-windows-release-");
  const source = join(fixtureRoot, "OpenBot-0.1.0-win32-x64");
  const dpapiNative = "app/native/dpapi/win32-x64/openbot-dpapi.node";
  for (const relativePath of releaseRequiredFiles({ dpapiNative })) {
    const target = join(source, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `fixture:${relativePath}`);
  }
  await writeFile(join(source, "app/package.json"), JSON.stringify({ version: "0.1.0" }));
  await copyFile(resolve("native/dpapi/win32-x64/openbot-dpapi.node"), join(source, dpapiNative));
  const contentSha256 = await treeDigest(source, { exclude: ["manifest.json"] });
  const buildId = "1".repeat(64);
  const manifest = {
    schemaVersion: 1,
    product: "OpenBot",
    version: "0.1.0",
    productVersion: "0.1.0",
    buildId,
    releaseId: `0.1.0-${buildId.slice(0, 16)}`,
    generatedAt: "2026-09-01T00:00:00.000Z",
    packageJsonVersion: "0.1.0",
    platform: "win32",
    arch: "x64",
    artifactType: "portable-directory",
    runtime: { dpapi: dpapiNative },
    signed: false,
    signature: null,
    security: "unsigned-local",
    contentSha256,
  };
  await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
  return { fixtureRoot, source, manifest };
}

type PowerShellProbeResult = {
  error?: Error;
  status: number | null;
  stdout?: string | null;
};

type PowerShellProbe = (executable: string) => PowerShellProbeResult;

function probePowerShell(executable: string): PowerShellProbeResult {
  return spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

function resolvePowerShell(probePowerShellVersion: PowerShellProbe = probePowerShell) {
  if (process.platform !== "win32") return null;
  const candidates = ["powershell.exe", "pwsh.exe"];
  for (const executable of candidates) {
    const probe = probePowerShellVersion(executable);
    if (probe.error != null || probe.status !== 0 || typeof probe.stdout !== "string") continue;
    const major = Number(probe.stdout.trim());
    if (Number.isInteger(major) && major >= 5) return { executable, major };
  }
  return null;
}

const powerShell = resolvePowerShell();

async function runPowerShell(command: string) {
  if (powerShell == null) throw new Error("supported PowerShell environment unavailable");
  return execFileAsync(powerShell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
}

function quotePowerShell(value: string) { return `'${value.replaceAll("'", "''")}'`; }

async function createZip(source: string, destination: string) {
  await runPowerShell(`Compress-Archive -Path ${quotePowerShell(join(source, "*"))} -DestinationPath ${quotePowerShell(destination)} -Force`);
}

describe("Windows artifact target gate", () => {
  it("returns an explicit unsupported-platform result off Windows", async () => {
    await expect(verifyWindowsArtifactGate({ platform: "linux", directory: "unused" })).resolves.toMatchObject({
      ok: false,
      supported: false,
      status: "unsupported-platform",
    });
  });

  it("keeps SHA-256 integrity separate from authenticity and signing", () => {
    const manifest = { signed: false, signature: null, security: "unsigned-local" };
    expect(getArtifactSigningStatus(manifest)).toMatchObject({ state: "unsigned", authentic: false });
    expect(verifyArtifactSignature(manifest)).toMatchObject({ signed: false, signature: null });
    expect(() => verifyArtifactSignature({ ...manifest, signed: true })).toThrow(/unsigned-local|supported/iu);
  });

  it("documents the complete Windows chain and clean-root copy boundary", async () => {
    const workflow = await readFile(".github/workflows/windows-artifact-gate.yml", "utf8");
    const ordered = [
      "npm ci", "npm run typecheck", "npm run build", "npm test", "npm run verify:provenance",
      "npm run verify:renderer-boundary", "npm run verify:client-artifacts", "npm run verify:visual-ui -- --artifacts-only", "npm run release:package",
      "Copy-Item -LiteralPath $dir.FullName", "verify-windows-artifact-gate.mjs", "launch.mjs --preflight", "npm run smoke:local",
    ];
    let previous = -1;
    for (const token of ordered) {
      const position = workflow.indexOf(token);
      expect(position, `workflow token missing: ${token}`).toBeGreaterThan(previous);
      previous = position;
    }
    expect(workflow).toContain("if: success()");
    expect(workflow).not.toMatch(/OPENAI_API_KEY|Bearer\s+\$|private.?key/iu);
  });

  it.skipIf(process.platform !== "win32" || powerShell?.executable !== "powershell.exe")("verifies a real ZIP from a distinct clean root and rejects divergent ZIP contents", async () => {
    const { fixtureRoot, source, manifest } = await validReleaseFixture();
    const cleanRoot = await freshRoot();
    const divergentCleanRoot = await freshRoot("openbot-windows-divergent-");
    const nonempty = await freshRoot("openbot-windows-nonempty-");
    const nested = join(source, ".gate-clean-root");
    const artifactZip = join(fixtureRoot, "artifact.zip");
    const sidecar = join(fixtureRoot, "artifact.manifest.json");
    await createZip(source, artifactZip);
    const zipBytes = await readFile(artifactZip);
    await writeFile(sidecar, JSON.stringify({
      ...manifest,
      artifactSha256: createHash("sha256").update(zipBytes).digest("hex"),
    }));
    await writeFile(join(nonempty, "marker"), "must reject");
    try {
      const result = await verifyWindowsArtifactGate({
        directory: source,
        zip: artifactZip,
        sidecar,
        cleanRoot,
      });
      expect(result).toMatchObject({ ok: true, status: "green" });
      expect(JSON.stringify(result)).not.toContain(cleanRoot);
      expect(result.checks).toEqual(expect.arrayContaining(["directory-zip-equivalence", "sidecar-integrity-only"]));

      await writeFile(join(source, "app/package.json"), JSON.stringify({ version: "0.1.0", variant: "divergent" }));
      const divergentDigest = await treeDigest(source, { exclude: ["manifest.json"] });
      await writeFile(join(source, "manifest.json"), JSON.stringify({ ...manifest, contentSha256: divergentDigest }));
      const divergent = await verifyWindowsArtifactGate({ directory: source, zip: artifactZip, cleanRoot: divergentCleanRoot });
      expect(divergent).toMatchObject({ ok: false, status: "red" });

      const nonemptyEvidence = await verifyWindowsArtifactGate({ directory: source, cleanRoot: nonempty });
      expect(nonemptyEvidence).toMatchObject({ ok: false, errors: ["clean root must be fresh empty directory"] });
      const overlapEvidence = await verifyWindowsArtifactGate({ directory: source, cleanRoot: nested });
      expect(overlapEvidence).toMatchObject({ ok: false, errors: ["clean root overlap rejected"] });
      expect(existsSync(nested)).toBe(false);
    } finally {
      await rm(cleanRoot, { recursive: true, force: true });
      await rm(divergentCleanRoot, { recursive: true, force: true });
      await rm(nonempty, { recursive: true, force: true });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(process.platform !== "win32")("rejects a nonexistent clean root nested under a source without creating it or leaking paths", async () => {
    const source = await freshRoot("openbot-windows-overlap-source-");
    const missingClean = join(source, "new-clean-root");
    const canary = "C:\\Users\\Canary\\workspace\\secret";
    try {
      const result = await verifyWindowsArtifactGate({ directory: source, cleanRoot: missingClean });
      expect(result.ok).toBe(false);
      expect(existsSync(missingClean)).toBe(false);
      expect(JSON.stringify(result)).not.toContain(missingClean);
      expect(JSON.stringify(result)).not.toContain(canary);
    } finally { await rm(source, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "win32")("sanitizes nonexistent source errors", async () => {
    const cleanRoot = await freshRoot("openbot-windows-sanitize-clean-");
    const sourceRoot = await freshRoot("openbot-windows-sanitize-source-");
    const missingSource = join(sourceRoot, "missing-release");
    const canary = "C:\\Users\\Canary\\workspace\\secret";
    try {
      const result = await verifyWindowsArtifactGate({ directory: missingSource, cleanRoot });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(missingSource);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(result.errors).toEqual(["artifact source unavailable"]);
    } finally {
      await rm(cleanRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("rejects sidecars without ZIPs and divergent sidecar metadata", async () => {
    const { fixtureRoot, source: releaseDir, manifest } = await validReleaseFixture();
    const cleanRoot = await freshRoot("openbot-windows-sidecar-");
    const source = await freshRoot("openbot-windows-sidecar-source-");
    const fakeZip = join(source, "artifact.zip");
    const sidecar = join(source, "artifact.manifest.json");
    await writeFile(fakeZip, "fixture zip bytes");
    await writeFile(sidecar, JSON.stringify({ ...manifest, artifactSha256: createHash("sha256").update("fixture zip bytes").digest("hex"), version: "9.9.9" }));
    try {
      await expect(verifyWindowsArtifactGate({ directory: releaseDir, sidecar, cleanRoot })).resolves.toMatchObject({
        ok: false,
        errors: ["sidecar requires zip artifact"],
      });
      const result = await verifyWindowsArtifactGate({
        zip: fakeZip,
        sidecar,
        cleanRoot,
        materialize: async () => ({ root: releaseDir, cleanup: async () => undefined }),
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toMatch(/sidecar metadata diverges/iu);
    } finally {
      await rm(cleanRoot, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("rejects divergent redundant sidecar payload hashes", async () => {
    const { fixtureRoot, source: releaseDir, manifest } = await validReleaseFixture();
    const cleanRoot = await freshRoot("openbot-windows-hash-clean-");
    const source = await freshRoot("openbot-windows-hash-source-");
    const fakeZip = join(source, "artifact.zip");
    const sidecar = join(source, "artifact.manifest.json");
    const bytes = "fixture zip bytes";
    await writeFile(fakeZip, bytes);
    await writeFile(sidecar, JSON.stringify({
      ...manifest,
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      payloadSha256: "0".repeat(64),
    }));
    try {
      const result = await verifyWindowsArtifactGate({ zip: fakeZip, sidecar, cleanRoot, materialize: async () => ({ root: releaseDir, cleanup: async () => undefined }) });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(["payload hash consistency failed"]);
    } finally {
      await rm(cleanRoot, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("rejects transient and reparse source entries", async () => {
    const cleanRoot = await freshRoot("openbot-windows-transient-clean-");
    const source = await freshRoot("openbot-windows-transient-source-");
    await mkdir(join(source, ".release.staging"));
    try {
      const transient = await verifyWindowsArtifactGate({ directory: source, cleanRoot });
      expect(transient.ok).toBe(false);
      expect(transient.errors).toEqual(["transient artifact entry rejected"]);
      await rm(join(source, ".release.staging"), { recursive: true, force: true });
      const outside = await freshRoot("openbot-windows-reparse-outside-");
      const reparseClean = await freshRoot("openbot-windows-reparse-clean-");
      try {
        await writeFile(join(outside, "secret"), "outside");
        await symlink(outside, join(source, "escape"), "junction");
        const reparse = await verifyWindowsArtifactGate({ directory: source, cleanRoot: reparseClean });
        expect(reparse.ok).toBe(false);
        expect(reparse.errors).toEqual(["reparse entry rejected"]);
      } finally {
        await rm(reparseClean, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      await rm(cleanRoot, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("falls back safely while classifying PowerShell probes", () => {
    const unavailable = new Error("executable unavailable");
    const timedOut = new Error("probe timed out");
    const fallbackCalls: string[] = [];

    expect(resolvePowerShell((executable) => {
      fallbackCalls.push(executable);
      return executable === "powershell.exe"
        ? { error: unavailable, status: null }
        : { status: 0, stdout: "7\n" };
    })).toEqual({ executable: "pwsh.exe", major: 7 });
    expect(fallbackCalls).toEqual(["powershell.exe", "pwsh.exe"]);

    expect(resolvePowerShell(() => ({ status: 0, stdout: "4\n" }))).toBeNull();
    expect(resolvePowerShell((executable) => executable === "powershell.exe"
      ? { error: timedOut, status: null }
      : { status: 0, stdout: "7" })).toEqual({ executable: "pwsh.exe", major: 7 });
    expect(resolvePowerShell(() => ({ error: unavailable, status: null }))).toBeNull();
  });

  it.skipIf(process.platform !== "win32" || powerShell == null)("uses resolver fixtures and compares normalized IPs in PowerShell", async () => {
    const command = [
      ". ./scripts/monitor-rede.ps1",
      "$script:BlockedHosts=@('cursor.sh')",
      "$r=Resolve-ExpectedHostAddresses -Hostname 'cursor.sh' -Resolver { param($h,$type) if($type -eq 'A'){ @([pscustomobject]@{IPAddress='192.0.2.7'}) } else { @([pscustomobject]@{IPAddress='[2001:db8::7]'}) } }",
      "$i=Get-NetworkIdentity -Connection ([pscustomobject]@{RemoteAddress='::ffff:192.0.2.7'}) -ResolvedHosts @{'cursor.sh'=$r}",
      "$i | ConvertTo-Json -Compress",
    ].join("; ");
    const result = await runPowerShell(command);
    expect(JSON.parse(result.stdout)).toMatchObject({ Status: "blocked", RemoteAddress: "192.0.2.7" });
  });

  it.skipIf(process.platform !== "win32" || powerShell == null)("does not classify malformed or hostname remote addresses as local", async () => {
    const command = [
      ". ./scripts/monitor-rede.ps1",
      "$script:BlockedHosts=@('cursor.sh')",
      "$r=[pscustomobject]@{Status='resolved';Addresses=@('192.0.2.7')}",
      "$a=Get-NetworkIdentity -Connection ([pscustomobject]@{RemoteAddress='not-a-hostname'}) -ResolvedHosts @{'cursor.sh'=$r}",
      "$b=Get-NetworkIdentity -Connection ([pscustomobject]@{RemoteAddress='203.0.113.9'}) -ResolvedHosts @{'cursor.sh'=$r}",
      "@($a,$b) | ConvertTo-Json -Compress",
    ].join("; ");
    const result = await runPowerShell(command);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ Status: "unknown" }),
      expect.objectContaining({ Status: "unknown", RemoteAddress: "203.0.113.9" }),
    ]);
  });

  it.skipIf(process.platform !== "win32" || powerShell == null)("treats resolver failure and unproven identity as unknown", async () => {
    const command = [
      ". ./scripts/monitor-rede.ps1",
      "$script:BlockedHosts=@('cursor.sh')",
      "$r=Resolve-ExpectedHostAddresses -Hostname 'cursor.sh' -Resolver { param($h) throw 'fixture DNS failure' }",
      "$i=Get-NetworkIdentity -Connection ([pscustomobject]@{RemoteAddress='203.0.113.8'}) -ResolvedHosts @{'cursor.sh'=$r}",
      "$i | ConvertTo-Json -Compress",
    ].join("; ");
    const result = await runPowerShell(command);
    expect(JSON.parse(result.stdout)).toMatchObject({ Status: "unknown", RemoteAddress: "203.0.113.8" });
  });
});
