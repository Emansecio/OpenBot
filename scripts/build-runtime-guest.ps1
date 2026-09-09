param(
    [ValidateSet("Build", "Cleanup")]
    [string]$Action = "Build",
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA "OpenBot\runtime"),
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PackageOutput = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# This script is deliberately limited to one disposable WSL distro.  The
# names below are policy, not user input: never broaden them to "the first
# distro" or to an arbitrary distro supplied on the command line.
$ManagedDistroName = "OpenBotBuild"
$PersonalDistroNames = @("Ubuntu", "Ubuntu-24.04")
$AlpineVersion = "3.24.1"
$AlpineUrl = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-3.24.1-x86_64.tar.gz"
$AlpineSha256 = "41f73e3cf5fa919b8aa5ca6b30dc48f0da2720776d7423e2a7748211456fe081"
$RuntimeVersion = "0.1.0-alpine3.24.1"
$SupervisorVersion = "0.1.0"

if ($ManagedDistroName -ne "OpenBotBuild") {
    throw "The build pipeline has an invalid managed distro policy."
}

$runtimeRootFull = [IO.Path]::GetFullPath($RuntimeRoot)
$buildRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRootFull "build"))
$distroPath = [IO.Path]::GetFullPath((Join-Path $buildRoot "distro"))
$downloadPath = [IO.Path]::GetFullPath((Join-Path $buildRoot "alpine-minirootfs-$AlpineVersion-x86_64.tar.gz"))
if ([string]::IsNullOrWhiteSpace($PackageOutput)) {
    $PackageOutput = Join-Path $runtimeRootFull "staging\openbot-runtime-package.tar"
}
$packageOutputFull = [IO.Path]::GetFullPath($PackageOutput)
$packageDirectory = Split-Path -Parent $packageOutputFull
$manifestOutputFull = Join-Path $packageDirectory "manifest.json"

function Normalize-PathKey {
    param([Parameter(Mandatory)][string]$Path)
    return ([IO.Path]::GetFullPath($Path)).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).ToLowerInvariant()
}

function Assert-ExactManagedPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Expected,
        [Parameter(Mandatory)][string]$Label
    )
    if ((Normalize-PathKey $Path) -ne (Normalize-PathKey $Expected)) {
        throw "$Label is outside the exact managed path: $Path"
    }
}

Assert-ExactManagedPath -Path $distroPath -Expected (Join-Path $buildRoot "distro") -Label "OpenBotBuild import path"
Assert-ExactManagedPath -Path $downloadPath -Expected (Join-Path $buildRoot "alpine-minirootfs-$AlpineVersion-x86_64.tar.gz") -Label "Alpine download path"

if (-not (Test-Path -LiteralPath $buildRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
}

function Invoke-WslChecked {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$FailureMessage
    )
    # Windows PowerShell 5.1 materializes native stderr as non-terminating
    # ErrorRecord objects. With the script-wide Stop policy, ordinary cargo
    # progress on stderr would abort an otherwise successful build.
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& wsl.exe @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        $details = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        if ($details.Length -gt 4000) { $details = $details.Substring(0, 4000) }
        throw "$FailureMessage (exit $exitCode). $details"
    }
    return $output
}

function Get-WslDistroNames {
    $output = Invoke-WslChecked -Arguments @("--list", "--quiet") -FailureMessage "Unable to list WSL distributions"
    $names = @(
        $output |
            ForEach-Object { ($_.ToString().Trim() -replace '^\*\s*', '').Trim() } |
            Where-Object { $_ -and $_ -notmatch "^\x00+$" }
    )
    return $names
}

function Assert-WslSafetyBoundary {
    $names = @(Get-WslDistroNames)
    # Personal distros may be present, but they are never an input to any
    # mutating command below. Keep this explicit so future edits cannot
    # accidentally fall back to a personal distro.
    foreach ($personal in $PersonalDistroNames) {
        if ($names -contains $personal) {
            Write-Verbose "Preserving personal distro '$personal'."
        }
    }
    return $names
}

function ConvertTo-WslPath {
    param([Parameter(Mandatory)][string]$WindowsPath)
    # wsl.exe applies one Unix-style escaping pass to argv on Windows. Double
    # backslashes so wslpath receives the literal drive path instead of
    # `C:pathtofile`.
    $escapedForWsl = $WindowsPath.Replace('\', '\\')
    $converted = Invoke-WslChecked -Arguments @("-d", $ManagedDistroName, "--user", "root", "--", "wslpath", "-a", "-u", $escapedForWsl) -FailureMessage "Unable to convert a managed Windows path to WSL"
    $value = ($converted | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }) -join ""
    if ([string]::IsNullOrWhiteSpace($value) -or $value -notmatch "^/") {
        throw "wslpath returned an invalid path for '$WindowsPath'."
    }
    return $value
}

function Quote-BashLiteral {
    param([Parameter(Mandatory)][string]$Value)
    $single = [string][char]39
    $escapedSingle = $single + [char]92 + $single + $single
    return $single + $Value.Replace($single, $escapedSingle) + $single
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    if (Get-Command -Name Get-FileHash -ErrorAction SilentlyContinue) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try {
            return ((($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "").ToLowerInvariant())
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function Ensure-AlpineArchive {
    if (Test-Path -LiteralPath $downloadPath -PathType Leaf) {
        $existingHash = Get-Sha256 -Path $downloadPath
        if ($existingHash -eq $AlpineSha256) {
            Write-Host "Alpine minirootfs already verified: $downloadPath"
            return
        }
        Write-Warning "Existing Alpine archive has an unexpected SHA-256; it will not be used."
    }

    $temporary = Join-Path $buildRoot (".alpine-minirootfs-$AlpineVersion-$([guid]::NewGuid().ToString('N')).tmp")
    try {
        Write-Host "Downloading official Alpine $AlpineVersion minirootfs..."
        Invoke-WebRequest -Uri $AlpineUrl -UseBasicParsing -OutFile $temporary
        $downloadHash = Get-Sha256 -Path $temporary
        if ($downloadHash -ne $AlpineSha256) {
            throw "Alpine minirootfs SHA-256 mismatch. Expected $AlpineSha256, got $downloadHash."
        }
        Move-Item -LiteralPath $temporary -Destination $downloadPath -Force
        Write-Host "Verified Alpine minirootfs SHA-256: $downloadHash"
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Ensure-ManagedBuildDistro {
    $names = @(Assert-WslSafetyBoundary)
    if ($names -contains $ManagedDistroName) {
        return
    }
    if (Test-Path -LiteralPath $distroPath) {
        # The path is an exact reserved path under OpenBot runtime/build. It
        # can only be stale import state for OpenBotBuild; personal distro
        # paths are never derived or removed here.
        Remove-Item -LiteralPath $distroPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $distroPath -Force | Out-Null
    Invoke-WslChecked -Arguments @("--import", $ManagedDistroName, $distroPath, $downloadPath, "--version", "2") -FailureMessage "Unable to import managed OpenBotBuild distro" | Out-Null
    $after = @(Assert-WslSafetyBoundary)
    if (-not ($after -contains $ManagedDistroName)) {
        throw "WSL did not register the managed OpenBotBuild distro after import."
    }
}

function Invoke-ManagedShell {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$FailureMessage
    )
    return Invoke-WslChecked -Arguments @("-d", $ManagedDistroName, "--user", "root", "--", "sh", "-lc", $Command) -FailureMessage $FailureMessage
}

function Build-AndPackageGuest {
    $repoWsl = ConvertTo-WslPath -WindowsPath $RepoRoot
    $archiveWsl = ConvertTo-WslPath -WindowsPath $downloadPath
    $outputWsl = ConvertTo-WslPath -WindowsPath $packageOutputFull
    $manifestWsl = ConvertTo-WslPath -WindowsPath $manifestOutputFull
    $outputDirectoryWsl = $outputWsl.Substring(0, $outputWsl.LastIndexOf('/'))
    $sourceWsl = "$repoWsl/runtime/guest/supervisor"
    $binaryWsl = "$sourceWsl/target/x86_64-alpine-linux-musl/release/openbot-supervisor"

    $command = @"
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
apk update
apk add --no-cache alpine-base build-base binutils cargo rust rustfmt musl-dev nodejs npm python3 git ca-certificates tar
cd $(Quote-BashLiteral $repoWsl)
cargo fmt --manifest-path runtime/guest/supervisor/Cargo.toml --check
cargo test --locked --manifest-path runtime/guest/supervisor/Cargo.toml --release
RUSTFLAGS='-C target-feature=+crt-static' cargo build --locked --manifest-path runtime/guest/supervisor/Cargo.toml --release --target x86_64-alpine-linux-musl
test -x $(Quote-BashLiteral $binaryWsl)
readelf -h $(Quote-BashLiteral $binaryWsl) | grep -q 'Class:.*ELF64'
readelf -h $(Quote-BashLiteral $binaryWsl) | grep -q 'Type:.*DYN'
readelf -h $(Quote-BashLiteral $binaryWsl) | grep -q 'X86-64'
if readelf -d $(Quote-BashLiteral $binaryWsl) 2>/dev/null | grep -q 'NEEDED'; then
  echo 'supervisor is dynamically linked' >&2
  exit 42
fi

rm -rf -- /openbot-rootfs /openbot-base
mkdir -p /openbot-rootfs /openbot-base
tar -xzf $(Quote-BashLiteral $archiveWsl) -C /openbot-rootfs
tar -xzf $(Quote-BashLiteral $archiveWsl) -C /openbot-base

mkdir -p /openbot-rootfs/etc/apk/keys /openbot-rootfs/proc /openbot-rootfs/workspace /openbot-rootfs/tmp /openbot-rootfs/run /openbot-rootfs/dev
mkdir -p /openbot-base/etc/apk/keys /openbot-base/proc /openbot-base/workspace /openbot-base/tmp /openbot-base/run /openbot-base/dev
cp -a /etc/apk/keys/. /openbot-rootfs/etc/apk/keys/
cp -a /etc/apk/keys/. /openbot-base/etc/apk/keys/
cp /etc/apk/repositories /openbot-rootfs/etc/apk/repositories
cp /etc/apk/repositories /openbot-base/etc/apk/repositories
if [ -L /openbot-rootfs/etc/mtab ]; then : > /openbot-rootfs/proc/mounts; fi
if [ -L /openbot-base/etc/mtab ]; then : > /openbot-base/proc/mounts; fi
apk --root /openbot-rootfs --initdb add --no-cache alpine-base ca-certificates nodejs npm python3 git
ln -sfn /init /openbot-base/sbin/mount.drvfs
mkdir -p $(Quote-BashLiteral $outputDirectoryWsl)
OPENBOT_GUEST_BINARY=$(Quote-BashLiteral $binaryWsl) \
OPENBOT_GUEST_ROOTFS='/openbot-rootfs' \
OPENBOT_GUEST_BASE_ROOTFS='/openbot-base' \
OPENBOT_GUEST_PACKAGE=$(Quote-BashLiteral $outputWsl) \
OPENBOT_GUEST_MANIFEST=$(Quote-BashLiteral $manifestWsl) \
OPENBOT_RUNTIME_VERSION=$(Quote-BashLiteral $RuntimeVersion) \
OPENBOT_GUEST_VERSION=$(Quote-BashLiteral $SupervisorVersion) \
OPENBOT_TAR=tar \
node scripts/package-runtime-guest.mjs
test -s $(Quote-BashLiteral $outputWsl)
test -s $(Quote-BashLiteral $manifestWsl)
"@
    Invoke-ManagedShell -Command $command -FailureMessage "Managed guest build/package failed" | ForEach-Object { Write-Host $_ }
}

function Cleanup-ManagedBuildDistro {
    $names = @(Assert-WslSafetyBoundary)
    if ($names -contains $ManagedDistroName) {
        Invoke-WslChecked -Arguments @("--terminate", $ManagedDistroName) -FailureMessage "Unable to terminate OpenBotBuild" | Out-Null
        Invoke-WslChecked -Arguments @("--unregister", $ManagedDistroName) -FailureMessage "Unable to unregister OpenBotBuild" | Out-Null
    }
    if (Test-Path -LiteralPath $distroPath) {
        Remove-Item -LiteralPath $distroPath -Recurse -Force
    }
    Write-Host "Managed build distro cleaned: $ManagedDistroName"
}

Assert-WslSafetyBoundary | Out-Null
if ($Action -eq "Cleanup") {
    Cleanup-ManagedBuildDistro
    exit 0
}

Ensure-AlpineArchive
Ensure-ManagedBuildDistro
if (-not (Test-Path -LiteralPath $packageDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null
}
Build-AndPackageGuest
Write-Host "Guest runtime package ready: $packageOutputFull"
Write-Host "External manifest ready: $manifestOutputFull"
Write-Host "OpenBotBuild remains registered for explicit reuse or -Action Cleanup."
