import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function powershellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

describe("desktop E2E process ownership", () => {
  it("ignores a pre-existing process whose parent PID was reused", async () => {
    const scriptPath = new URL("../scripts/e2e-desktop-run.ps1", import.meta.url);
    const command = `
$source = Get-Content -LiteralPath '${powershellLiteral(decodeURIComponent(scriptPath.pathname).replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)))}' -Raw
$start = $source.IndexOf('function Convert-ProcessCreationDate')
$end = $source.IndexOf('function Stop-OwnTree')
if ($start -lt 0 -or $end -le $start) { throw 'process ownership functions not found' }
. ([scriptblock]::Create($source.Substring($start, $end - $start)))
$rootCreation = [datetime]'2026-08-16T06:14:00'
$snapshot = @(
    [pscustomobject]@{ ProcessId = 14936; ParentProcessId = 9012; CreationDate = $rootCreation },
    [pscustomobject]@{ ProcessId = 18964; ParentProcessId = 14936; CreationDate = [datetime]'2026-08-14T04:34:28' },
    [pscustomobject]@{ ProcessId = 20001; ParentProcessId = 14936; CreationDate = [datetime]'2026-08-16T06:14:01' }
)
$initialSnapshot = @(
    [pscustomobject]@{ ProcessId = 18964; ParentProcessId = 14936; CreationDate = [datetime]'2026-08-14T04:34:28' }
)
$result = @(Get-TreePids -RootPid 14936 -Snapshot $snapshot -InitialSnapshot $initialSnapshot)
if ($result -contains 18964) { throw 'pre-existing PID-reused process was treated as owned' }
if (-not ($result -contains 20001)) { throw 'real child launched after the root was not treated as owned' }
Write-Output ($result -join ',')
`;

    await expect(execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ])).resolves.toMatchObject({ stdout: expect.stringContaining("14936") });
  });

  it("re-enumerates a child that appears during teardown without killing a stale PID", async () => {
    const scriptPath = new URL("../scripts/e2e-desktop-run.ps1", import.meta.url);
    const command = `
$source = Get-Content -LiteralPath '${powershellLiteral(decodeURIComponent(scriptPath.pathname).replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)))}' -Raw
$start = $source.IndexOf('function Convert-ProcessCreationDate')
$end = $source.IndexOf('function Save-Environment')
if ($start -lt 0 -or $end -le $start) { throw 'process ownership functions not found' }
. ([scriptblock]::Create($source.Substring($start, $end - $start)))
$rootCreation = [datetime]'2026-08-16T06:14:00'
$root = [pscustomobject]@{ ProcessId = 14936; ParentProcessId = 9012; CreationDate = $rootCreation; CommandLine = 'electron main.cjs --user-data-dir=C:\\Temp\\owned' }
$child = [pscustomobject]@{ ProcessId = 20001; ParentProcessId = 14936; CreationDate = [datetime]'2026-08-16T06:14:01'; CommandLine = 'child' }
$lateChild = [pscustomobject]@{ ProcessId = 20002; ParentProcessId = 14936; CreationDate = [datetime]'2026-08-16T06:14:02'; CommandLine = 'late-child' }
$stale = [pscustomobject]@{ ProcessId = 18964; ParentProcessId = 14936; CreationDate = [datetime]'2026-08-14T04:34:28'; CommandLine = 'MicrosoftEdgeUpdate' }
$snapshots = [System.Collections.Generic.Queue[object[]]]::new()
$snapshots.Enqueue(@($root, $child))
$snapshots.Enqueue(@($root, $child))
$snapshots.Enqueue(@($root, $child))
$snapshots.Enqueue(@($root, $child))
$snapshots.Enqueue(@($lateChild, $stale))
$snapshots.Enqueue(@($lateChild, $stale))
$snapshots.Enqueue(@($lateChild, $stale))
$snapshots.Enqueue(@())
$snapshots.Enqueue(@())
$snapshotProvider = {
    if ($snapshots.Count -eq 0) { return @() }
    return $snapshots.Dequeue()
}
$killed = [System.Collections.Generic.List[int]]::new()
$killProcess = {
    param([int]$TargetPid)
    $killed.Add($TargetPid)
    return 0
}
Stop-OwnTree -ProcessId 14936 -ExpectedCommandPart 'main.cjs' -ExpectedRoot 'C:\\Temp\\owned' -SnapshotProvider $snapshotProvider -KillProcess $killProcess
if (-not ($killed -contains 20001)) { throw 'first child was not killed' }
if (-not ($killed -contains 14936)) { throw 'root was not killed' }
if (-not ($killed -contains 20002)) { throw 'late child was not re-enumerated and killed' }
if ($killed -contains 18964) { throw 'stale parent-PID reuse process was killed' }
Write-Output ($killed -join ',')
`;

    await expect(execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ])).resolves.toMatchObject({ stdout: expect.stringContaining("20002") });
  });
});
