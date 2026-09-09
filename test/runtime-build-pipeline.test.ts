import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

interface PowerShellCommand {
  name: string | null;
  text: string;
}

function windowsPath(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1));
}

async function readPowerShellCommands(scriptUrl: URL): Promise<PowerShellCommand[]> {
  const path = windowsPath(scriptUrl).replaceAll("'", "''");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$tokens = $null; $errors = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { throw ($errors | Out-String) }; @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { [pscustomobject]@{ name = $_.GetCommandName(); text = $_.Extent.Text } }) | ConvertTo-Json -Compress`,
  ]);
  const parsed = JSON.parse(stdout) as PowerShellCommand | PowerShellCommand[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function bracedBlockAt(source: string, anchor: string): string {
  const anchorIndex = source.indexOf(anchor);
  expect(anchorIndex).toBeGreaterThanOrEqual(0);
  const openingBrace = source.indexOf("{", anchorIndex);
  expect(openingBrace).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  throw new Error(`Unclosed block after ${anchor}`);
}

describe("managed WSL guest build pipeline", () => {
  it("is a syntactically valid PowerShell script", async () => {
    const scriptPath = new URL("../scripts/build-runtime-guest.ps1", import.meta.url);
    const path = windowsPath(scriptPath);
    await expect(execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[scriptblock]::Create((Get-Content -LiteralPath '${path.replaceAll("'", "''")}' -Raw)) | Out-Null`,
    ])).resolves.toBeDefined();
  });

  it("pins official Alpine input and confines mutations to OpenBotBuild", async () => {
    const scriptUrl = new URL("../scripts/build-runtime-guest.ps1", import.meta.url);
    const script = await readFile(scriptUrl, "utf8");
    expect(script).toContain("$ManagedDistroName = \"OpenBotBuild\"");
    expect(script).toContain("https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-3.24.1-x86_64.tar.gz");
    expect(script).toContain("41f73e3cf5fa919b8aa5ca6b30dc48f0da2720776d7423e2a7748211456fe081");
    expect(script).toContain("--import");
    expect(script).toContain("--version\", \"2\"");
    expect(script).toContain("RUSTFLAGS='-C target-feature=+crt-static'");
    expect(script).toContain("x86_64-alpine-linux-musl");
    expect(script).toContain("OPENBOT_GUEST_BASE_ROOTFS='/openbot-base'");
    expect(script).toContain("OPENBOT_GUEST_ROOTFS='/openbot-rootfs'");
    expect(script).toContain("--terminate\", $ManagedDistroName");
    expect(script).toContain("--unregister\", $ManagedDistroName");
    expect(script).not.toMatch(/--(?:import|terminate|unregister)[^\n]*Ubuntu(?:-24\.04)?/iu);
    expect(script).not.toMatch(/wsl\.exe[^\n]*\$PersonalDistroNames/iu);
    const commands = await readPowerShellCommands(scriptUrl);
    const mutableDistroTargets = commands.filter(({ name, text }) => (
      /--(?:import|terminate|unregister)\b/iu.test(text)
      || (name?.toLowerCase() === "remove-item" && /\$distroPath\b/u.test(text) && /-Recurse\b/iu.test(text))
    ));
    expect(mutableDistroTargets.map(({ name }) => name)).toEqual([
      "Remove-Item",
      "Invoke-WslChecked",
      "Invoke-WslChecked",
      "Invoke-WslChecked",
      "Remove-Item",
    ]);
    expect(mutableDistroTargets.filter(({ name }) => name === "Invoke-WslChecked")).toHaveLength(3);
    for (const { name, text } of mutableDistroTargets) {
      if (name === "Remove-Item") {
        expect(text).toMatch(/-LiteralPath\s+\$distroPath\b/iu);
      } else {
        expect(text).toMatch(/--(?:import|terminate|unregister)[\s\S]*\$ManagedDistroName\b/iu);
      }
      expect(text).not.toMatch(/\$PersonalDistroNames\b|Ubuntu(?:-24\.04)?/iu);
    }
  });

  it("requires validated guest cleanup identifiers before argv mutations", async () => {
    const script = await readFile(new URL("../scripts/run-runtime-wsl-live.mjs", import.meta.url), "utf8");
    expect(script).toContain("const safeRuntimeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;");
    expect(script).toContain('"test", "!", "-e", target');
    expect(script).toContain('["-d", distro, "--user", "root", "--", "rmdir", partialCgroupPath]');
    expect(script).toContain('assertRuntimeIdentifier(runtimeBootId, "runtime boot identity")');
    expect(script).not.toContain("/bin/sh");
    const runtimeValidation = script.indexOf('assertRuntimeIdentifier(partialLeaseRequest.runtimeBootId, "partial runtime boot identity")');
    const leaseValidation = script.indexOf('assertRuntimeIdentifier(partialLeaseRequest.leaseId, "partial lease identity")');
    const mutationPositions = [
      script.indexOf('runner.run(["-d", distro, "--user", "root", "--", "mkdir", "-p", partialSandboxPath])'),
      script.indexOf('runner.run(["-d", distro, "--user", "root", "--", "rmdir", partialCgroupPath])'),
    ];
    for (const position of [runtimeValidation, leaseValidation, ...mutationPositions]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(leaseValidation).toBeGreaterThan(runtimeValidation);
    for (const mutationPosition of mutationPositions) {
      expect(mutationPosition).toBeGreaterThan(leaseValidation);
    }
  });

  it("includes permanent distro state changes in the live-gate verdict", async () => {
    const script = await readFile(new URL("../scripts/verify-runtime-wsl-live.ps1", import.meta.url), "utf8");
    const verdictLine = script.split(/\r?\n/u).find((line) => line.includes("WSL before/after proof failed")) ?? "";

    expect(verdictLine).toContain("-not $summary.personalDistroProof.stateSnapshotEqual");
  });

  it("removes only the owned empty Start Menu residue from the temporary WSL distro", async () => {
    const script = await readFile(new URL("../scripts/verify-runtime-wsl-live.ps1", import.meta.url), "utf8");

    const cleanup = script.slice(
      script.indexOf("function Remove-OwnedEmptyDistroStartMenuResidue"),
      script.indexOf("function Throw-BlockedEnvironment"),
    );
    const orderedGuards = [
      "$distroStartMenuPreexisting",
      "Assert-ExactLiveDistro $distroName",
      '[Environment]::GetFolderPath("Programs")',
      "GetDirectoryName($candidate)",
      "[IO.FileAttributes]::ReparsePoint",
      "Get-ChildItem -LiteralPath $distroStartMenuPath -Force",
      "if ($children.Count -eq 0)",
      "Remove-Item -LiteralPath $distroStartMenuPath -Force -ErrorAction Stop",
    ].map((token) => cleanup.indexOf(token));
    for (const position of orderedGuards) expect(position).toBeGreaterThanOrEqual(0);
    expect(orderedGuards).toEqual([...orderedGuards].sort((left, right) => left - right));
    const emptyDirectoryGuard = bracedBlockAt(cleanup, "if ($children.Count -eq 0)");
    expect(emptyDirectoryGuard).toContain("Remove-Item -LiteralPath $distroStartMenuPath -Force -ErrorAction Stop");
    expect(cleanup.match(/Remove-Item -LiteralPath \$distroStartMenuPath -Force -ErrorAction Stop/gu)).toHaveLength(1);
    expect(cleanup).toContain("temporary distro Start Menu residue still exists");
  });
});
