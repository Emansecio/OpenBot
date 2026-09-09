[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [string]$PackagePath = "",
    [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}

$scriptVersion = "1.0.0"
$repo = [IO.Path]::GetFullPath($RepoRoot)
$guid = [guid]::NewGuid().ToString("D")
$distroName = "OpenBotRuntimeLive-$guid"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) $distroName
$distroPath = Join-Path $tempRoot "distro"
$stagingPath = Join-Path $tempRoot "staging"
$stagedArchive = Join-Path $stagingPath "openbot-runtime-package.tar"
$stagedManifest = Join-Path $stagingPath "manifest.json"
$distroTouched = $false
$tempCreated = $false
$distroStartMenuPath = $null
$distroStartMenuPreexisting = $false
$before = $null
$after = $null
$commands = [System.Collections.Generic.List[object]]::new()
$errors = [System.Collections.Generic.List[string]]::new()
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
$blockedEnvironment = $false
$oldLiveFlag = $env:OPENBOT_RUNTIME_WSL_LIVE_TEST
$oldLiveDistro = $env:OPENBOT_RUNTIME_LIVE_DISTRO
$oldLiveRoot = $env:OPENBOT_RUNTIME_LIVE_ROOT
$oldLiveArchive = $env:OPENBOT_RUNTIME_LIVE_ARCHIVE
$oldLiveManifest = $env:OPENBOT_RUNTIME_LIVE_MANIFEST

$summary = [ordered]@{
    schemaVersion = 1
    gateVersion = $scriptVersion
    status = "RED"
    distroName = $distroName
    tempRoot = $tempRoot
    before = $null
    after = $null
    package = $null
    production = $null
    commands = @()
    errors = @()
    cleanupErrors = @()
    startMenuCleanup = $null
    personalDistroProof = $null
}

function Convert-NormalizedText([object]$Value) {
    if ($null -eq $Value) { return "" }
    return (([string]$Value) -replace [char]0, "").Replace("`r", "")
}

function Get-Sha256Hex([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { return ((($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "").ToLowerInvariant()) }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Quote-ProcessArgument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-ProcessChecked {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$InputText = "",
        [int]$TimeoutMs = 120000
    )
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FileName
    $psi.Arguments = (($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " ")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw "could not start $FileName" }
        if ($InputText.Length -gt 0) { $process.StandardInput.Write($InputText) }
        $process.StandardInput.Close()
        # Drain both pipes concurrently. Reading stdout to completion before
        # stderr can deadlock WSL import/export when the stderr pipe fills.
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            try { if (-not $process.HasExited) { $process.Kill() } } catch { }
            try { $process.WaitForExit(2000) | Out-Null } catch { }
            try { $stdoutTask.Wait(2000) | Out-Null } catch { }
            try { $stderrTask.Wait(2000) | Out-Null } catch { }
            throw "$FileName timed out"
        }
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = Convert-NormalizedText $stdout
            Stderr = Convert-NormalizedText $stderr
        }
    } finally {
        $process.Dispose()
    }
}

function Assert-ExactLiveDistro([string]$Name) {
    if ($Name -ne $distroName -or $Name -cnotmatch '^OpenBotRuntimeLive-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        throw "WSL distro guard rejected the target"
    }
}

function Assert-OwnedPath([string]$Candidate, [string]$Label, [switch]$MustExist) {
    $checked = [IO.Path]::GetFullPath($Candidate)
    $rootFull = ([IO.Path]::GetFullPath($tempRoot)).TrimEnd('\', '/')
    $target = $checked.ToLowerInvariant()
    $base = $rootFull.ToLowerInvariant()
    if ($target -ne $base -and -not $target.StartsWith("$base\")) { throw "$Label escaped the temporary root" }
    $item = Get-Item -LiteralPath $checked -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$Label is a reparse point" }
    if ($MustExist -and $null -eq $item) { throw "$Label does not exist" }
    return $checked
}

function Invoke-WslGuarded {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$Mutating
    )
    if ($Arguments.Count -eq 0) { throw "empty WSL command" }
    if ($Arguments -contains "OpenBotRuntime" -or $Arguments -contains "OpenBotRuntimeCandidate" -or $Arguments -contains "Ubuntu" -or $Arguments -contains "Ubuntu-24.04") {
        throw "WSL command addressed a personal or permanent distro"
    }
    if ($Arguments[0] -in @("--import", "--export", "--terminate", "--unregister")) {
        Assert-ExactLiveDistro $Arguments[1]
        if ($Arguments[0] -eq "--import") {
            $null = Assert-OwnedPath $Arguments[2] "import directory"
            $null = Assert-OwnedPath $Arguments[3] "package archive" -MustExist
        }
        if ($Arguments[0] -eq "--export") { $null = Assert-OwnedPath $Arguments[2] "export archive" }
        $script:distroTouched = $true
    }
    $distroIndex = [Array]::IndexOf($Arguments, "-d")
    if ($distroIndex -ge 0) {
        Assert-ExactLiveDistro $Arguments[$distroIndex + 1]
        $script:distroTouched = $true
    }
    $result = Invoke-ProcessChecked "wsl.exe" $Arguments
    $commands.Add([ordered]@{ arguments = $Arguments; exitCode = $result.ExitCode })
    return $result
}

function Get-WslSnapshot {
    $quiet = Invoke-WslGuarded @("--list", "--quiet")
    if ($quiet.ExitCode -ne 0) { throw "WSL list failed" }
    $verbose = Invoke-WslGuarded @("--list", "--verbose")
    if ($verbose.ExitCode -ne 0) { throw "WSL verbose list failed" }
    $quietText = Convert-NormalizedText $quiet.Stdout
    $names = @($quietText -split "`n" | ForEach-Object {
        $name = $_.Trim().TrimStart('*').Trim()
        if ($name.Length -gt 0) { $name }
    })
    return [ordered]@{ names = $names; quiet = (Convert-NormalizedText $quiet.Stdout); verbose = (Convert-NormalizedText $verbose.Stdout) }
}

function Assert-CleanTermination([string]$Operation, [object]$Result) {
    if ($Result.ExitCode -eq 0) { return }
    $text = "$(Convert-NormalizedText $Result.Stdout)`n$(Convert-NormalizedText $Result.Stderr)"
    if (($Result.ExitCode -eq 1 -or $Result.ExitCode -eq -1 -or $Result.ExitCode -eq [uint32]::MaxValue) -and $text -match '(?i)no distribution|not found|not registered|does not exist|WSL_E_DISTRO_NOT_FOUND|already stopped|not running|is stopped') { return }
    throw "$Operation failed: $text"
}

function Remove-OwnedEmptyDistroStartMenuResidue {
    if ($distroStartMenuPreexisting -or [string]::IsNullOrWhiteSpace($distroStartMenuPath)) { return }
    Assert-ExactLiveDistro $distroName
    $programs = [IO.Path]::GetFullPath([Environment]::GetFolderPath("Programs")).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath($distroStartMenuPath)
    if (-not ([IO.Path]::GetDirectoryName($candidate)).Equals($programs, [StringComparison]::OrdinalIgnoreCase)) {
        throw "temporary distro Start Menu path escaped Programs"
    }
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        $item = Get-Item -LiteralPath $distroStartMenuPath -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) { return }
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "temporary distro Start Menu residue is not an owned directory"
        }
        $children = @(Get-ChildItem -LiteralPath $distroStartMenuPath -Force -ErrorAction Stop)
        if ($children.Count -eq 0) {
            Remove-Item -LiteralPath $distroStartMenuPath -Force -ErrorAction Stop
            if (-not (Test-Path -LiteralPath $distroStartMenuPath)) { return }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "temporary distro Start Menu residue still exists"
}

function Throw-BlockedEnvironment([string]$Message) {
    $script:blockedEnvironment = $true
    throw $Message
}

try {
    if ($env:OS -ne "Windows_NT") { Throw-BlockedEnvironment "this gate requires Windows" }
    $startMenuPrograms = [Environment]::GetFolderPath("Programs")
    if ([string]::IsNullOrWhiteSpace($startMenuPrograms)) { throw "Windows Programs directory is unavailable" }
    $distroStartMenuPath = Join-Path ([IO.Path]::GetFullPath($startMenuPrograms)) $distroName
    $distroStartMenuPreexisting = Test-Path -LiteralPath $distroStartMenuPath
    $status = Invoke-WslGuarded @("--status")
    if ($status.ExitCode -ne 0 -or $status.Stdout -notmatch '(?i)(Default\s+Version|Vers.{0,3}o\s+Padr.{0,3}o)\s*:\s*2') { Throw-BlockedEnvironment "WSL2 is unavailable" }
    $before = Get-WslSnapshot
    $summary.before = $before

    if ([string]::IsNullOrWhiteSpace($PackagePath)) {
        if ($env:OPENBOT_GUEST_PACKAGE) {
            $PackagePath = $env:OPENBOT_GUEST_PACKAGE
        } else {
            $repoPackage = Join-Path $repo "runtime\guest\openbot-runtime-package.tar"
            $stagingPackage = Join-Path $env:LOCALAPPDATA "OpenBot\runtime\staging\openbot-runtime-package.tar"
            $PackagePath = if (Test-Path -LiteralPath $repoPackage) { $repoPackage } else { $stagingPackage }
        }
    }
    if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($PackagePath))) "manifest.json" }
    $package = [IO.Path]::GetFullPath($PackagePath)
    $manifestFile = [IO.Path]::GetFullPath($ManifestPath)
    if (-not (Test-Path -LiteralPath $package) -or -not (Test-Path -LiteralPath $manifestFile)) { Throw-BlockedEnvironment "runtime guest package or manifest is unavailable" }
    foreach ($source in @($package, $manifestFile)) {
        $item = Get-Item -LiteralPath $source -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer) { throw "package input is invalid" }
    }
    $hash = Get-Sha256Hex $package
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.supervisorDigest -notmatch '^sha256:[0-9a-f]{64}$' -or $manifest.rootfsDigest -notmatch '^sha256:[0-9a-f]{64}$') { throw "package manifest is invalid" }
    if (($manifest.PSObject.Properties.Name -contains "archiveDigest") -and $manifest.archiveDigest -and $manifest.archiveDigest -ne "sha256:$hash") { throw "package archive digest mismatch" }
    $summary.package = [ordered]@{ archive = $package; manifest = $manifestFile; archiveDigest = "sha256:$hash"; runtimeVersion = $manifest.runtimeVersion; supervisorVersion = $manifest.supervisorVersion }

    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
    $tempCreated = $true
    $null = Assert-OwnedPath $stagedArchive "staged archive"
    $null = Assert-OwnedPath $stagedManifest "staged manifest"
    Copy-Item -LiteralPath $package -Destination $stagedArchive -Force
    Copy-Item -LiteralPath $manifestFile -Destination $stagedManifest -Force
    # From this point onward the child runner may have registered the distro;
    # cleanup is therefore attempted even when its first command fails.
    $distroTouched = $true
    $env:OPENBOT_RUNTIME_WSL_LIVE_TEST = "1"
    $env:OPENBOT_RUNTIME_LIVE_DISTRO = $distroName
    $env:OPENBOT_RUNTIME_LIVE_ROOT = $tempRoot
    $env:OPENBOT_RUNTIME_LIVE_ARCHIVE = $stagedArchive
    $env:OPENBOT_RUNTIME_LIVE_MANIFEST = $stagedManifest

    Push-Location $repo
    try {
        $npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $nodeCommand = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $build = Invoke-ProcessChecked $npmCommand @("run", "build", "--silent")
        if ($build.ExitCode -ne 0) { throw "production runtime build failed: $($build.Stderr)" }
        $live = Invoke-ProcessChecked $nodeCommand @("scripts\run-runtime-wsl-live.mjs")
        if ($live.ExitCode -ne 0) { throw "live production runner failed: $($live.Stderr)" }
        $summary.production = $live.Stdout | ConvertFrom-Json
    } finally {
        Pop-Location
    }
    $summary.status = "GREEN"
} catch {
    $errors.Add($_.Exception.Message)
} finally {
    if ($distroTouched) {
        try { Assert-CleanTermination "temporary distro termination" (Invoke-WslGuarded @("--terminate", $distroName) -Mutating) } catch { $cleanupErrors.Add($_.Exception.Message) }
        try {
            $unregister = Invoke-WslGuarded @("--unregister", $distroName) -Mutating
            Assert-CleanTermination "temporary distro unregister" $unregister
        } catch { $cleanupErrors.Add($_.Exception.Message) }
    }
    try { Remove-OwnedEmptyDistroStartMenuResidue } catch { $cleanupErrors.Add($_.Exception.Message) }
    $summary.startMenuCleanup = [ordered]@{
        path = $distroStartMenuPath
        preexisting = $distroStartMenuPreexisting
        absent = [string]::IsNullOrWhiteSpace($distroStartMenuPath) -or -not (Test-Path -LiteralPath $distroStartMenuPath)
    }
    try { if ($before) { $after = Get-WslSnapshot; $summary.after = $after } } catch { $cleanupErrors.Add("after snapshot failed: $($_.Exception.Message)") }
    if ($after) {
        $beforeNames = @($before.names | Sort-Object)
        $afterNames = @($after.names | Sort-Object)
        $nameSnapshotEqual = (($beforeNames -join "`n") -eq ($afterNames -join "`n"))
        $stateSnapshotEqual = $before.verbose -eq $after.verbose
        $summary.personalDistroProof = [ordered]@{
            beforeAfterEqual = $nameSnapshotEqual
            permanentSnapshotEqual = $nameSnapshotEqual
            stateSnapshotEqual = $stateSnapshotEqual
            temporaryAbsent = -not ($after.names -contains $distroName)
            forbiddenUntouched = ($after.names -contains "OpenBotRuntime") -eq ($before.names -contains "OpenBotRuntime") -and ($after.names -contains "Ubuntu") -eq ($before.names -contains "Ubuntu") -and ($after.names -contains "Ubuntu-24.04") -eq ($before.names -contains "Ubuntu-24.04")
        }
        if (-not $summary.personalDistroProof.beforeAfterEqual -or -not $summary.personalDistroProof.stateSnapshotEqual -or -not $summary.personalDistroProof.temporaryAbsent -or -not $summary.personalDistroProof.forbiddenUntouched) { $cleanupErrors.Add("WSL before/after proof failed") }
    }
    if ($tempCreated) {
        try { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Stop } catch { $cleanupErrors.Add("temporary root removal failed: $($_.Exception.Message)") }
        if (Test-Path -LiteralPath $tempRoot) { $cleanupErrors.Add("temporary root still exists") }
    }
    if ($null -eq $oldLiveFlag) { Remove-Item Env:OPENBOT_RUNTIME_WSL_LIVE_TEST -ErrorAction SilentlyContinue } else { $env:OPENBOT_RUNTIME_WSL_LIVE_TEST = $oldLiveFlag }
    if ($null -eq $oldLiveDistro) { Remove-Item Env:OPENBOT_RUNTIME_LIVE_DISTRO -ErrorAction SilentlyContinue } else { $env:OPENBOT_RUNTIME_LIVE_DISTRO = $oldLiveDistro }
    if ($null -eq $oldLiveRoot) { Remove-Item Env:OPENBOT_RUNTIME_LIVE_ROOT -ErrorAction SilentlyContinue } else { $env:OPENBOT_RUNTIME_LIVE_ROOT = $oldLiveRoot }
    if ($null -eq $oldLiveArchive) { Remove-Item Env:OPENBOT_RUNTIME_LIVE_ARCHIVE -ErrorAction SilentlyContinue } else { $env:OPENBOT_RUNTIME_LIVE_ARCHIVE = $oldLiveArchive }
    if ($null -eq $oldLiveManifest) { Remove-Item Env:OPENBOT_RUNTIME_LIVE_MANIFEST -ErrorAction SilentlyContinue } else { $env:OPENBOT_RUNTIME_LIVE_MANIFEST = $oldLiveManifest }
}

$summary.commands = @($commands)
$summary.errors = @($errors)
$summary.cleanupErrors = @($cleanupErrors)
if ($summary.errors.Count -gt 0 -or $summary.cleanupErrors.Count -gt 0) {
    $summary.status = if ($blockedEnvironment -and $summary.cleanupErrors.Count -eq 0) { "BLOCKED_ENV" } else { "RED" }
}
Write-Output ($summary | ConvertTo-Json -Depth 12 -Compress)
if ($summary.status -eq "GREEN") { exit 0 }
if ($summary.status -eq "BLOCKED_ENV") { exit 2 }
exit 1
