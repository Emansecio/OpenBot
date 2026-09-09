param(
    [string]$ShortcutPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'OpenBot.lnk')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$smokeRoot = Join-Path $tempBase ('openbot-shortcut-smoke-' + [Guid]::NewGuid().ToString('N'))
$smokeFull = [IO.Path]::GetFullPath($smokeRoot)
$tempPrefix = $tempBase + [IO.Path]::DirectorySeparatorChar
if (-not $smokeFull.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe shortcut smoke root'
}

if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
    throw "OpenBot shortcut not found: $ShortcutPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$expectedTarget = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not [IO.Path]::GetFullPath($shortcut.TargetPath).Equals([IO.Path]::GetFullPath($expectedTarget), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Shortcut target is not wscript.exe: $($shortcut.TargetPath)"
}

$shortcutArguments = ([string]$shortcut.Arguments).Trim()
$quotedLauncher = [regex]::Match($shortcutArguments, '^"(?<path>[^"]+)"$')
if ($quotedLauncher.Success) {
    $shortcutLauncher = [IO.Path]::GetFullPath($quotedLauncher.Groups['path'].Value)
} elseif ($shortcutArguments.Length -gt 0 -and $shortcutArguments.IndexOf('"') -lt 0) {
    $shortcutLauncher = [IO.Path]::GetFullPath($shortcutArguments)
} else {
    throw "Shortcut must pass exactly one hidden launcher path: $shortcutArguments"
}
if (-not (Test-Path -LiteralPath $shortcutLauncher -PathType Leaf)) {
    throw "Shortcut hidden launcher does not exist: $shortcutLauncher"
}

$repoLauncher = [IO.Path]::GetFullPath((Join-Path $scriptDir 'openbot-desktop.vbs'))
$launcherRoot = [IO.Path]::GetFullPath((Split-Path -Parent $shortcutLauncher))
$installedLauncher = [IO.Path]::GetFullPath((Join-Path $launcherRoot 'OpenBot.vbs'))
$workingDirectory = [IO.Path]::GetFullPath([string]$shortcut.WorkingDirectory)
$isRepoShortcut = $shortcutLauncher.Equals($repoLauncher, [StringComparison]::OrdinalIgnoreCase)
$isInstalledShortcut = $shortcutLauncher.Equals($installedLauncher, [StringComparison]::OrdinalIgnoreCase) -and
    $workingDirectory.Equals($launcherRoot, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-Path -LiteralPath (Join-Path $launcherRoot 'OpenBot.cmd') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $launcherRoot 'state.json') -PathType Leaf)

if ($isRepoShortcut) {
    $launcherCommand = Join-Path $scriptDir 'openbot-desktop.cmd'
    $gatewayScript = Join-Path $repoRoot 'dist\main.js'
    $logsRoot = Join-Path $repoRoot 'logs'
} elseif ($isInstalledShortcut) {
    $state = Get-Content -LiteralPath (Join-Path $launcherRoot 'state.json') -Raw | ConvertFrom-Json
    if ($null -eq $state.PSObject.Properties['product'] -or [string]$state.product -cne 'OpenBot') {
        throw 'Installed shortcut state has an unexpected product identity'
    }
    if ($null -eq $state.PSObject.Properties['installRoot'] -or
        -not [IO.Path]::GetFullPath([string]$state.installRoot).Equals($launcherRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installed shortcut state does not belong to the launcher root'
    }
    if ($null -eq $state.PSObject.Properties['activeVersion'] -or [string]::IsNullOrWhiteSpace([string]$state.activeVersion)) {
        throw 'Installed shortcut state does not declare an active version'
    }
    $activeReleaseId = if ($null -ne $state.PSObject.Properties['activeReleaseId'] -and
        -not [string]::IsNullOrWhiteSpace([string]$state.activeReleaseId)) {
        [string]$state.activeReleaseId
    } else {
        [string]$state.activeVersion
    }
    $versionsRoot = [IO.Path]::GetFullPath((Join-Path $launcherRoot 'versions')).TrimEnd('\')
    $releaseRoot = [IO.Path]::GetFullPath((Join-Path $versionsRoot $activeReleaseId))
    $versionsPrefix = $versionsRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $releaseRoot.StartsWith($versionsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installed shortcut active version escapes the managed versions root'
    }
    $preflightOutput = @(& (Get-Command node -ErrorAction Stop).Source (Join-Path $scriptDir 'launch.mjs') --preflight --root $releaseRoot 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Installed shortcut active release failed the canonical preflight: $($preflightOutput -join [Environment]::NewLine)"
    }
    try {
        $preflight = ($preflightOutput -join [Environment]::NewLine) | ConvertFrom-Json
    } catch {
        throw "Installed shortcut preflight returned invalid evidence: $($_.Exception.Message)"
    }
    if ($preflight.ok -ne $true -or $null -eq $preflight.manifest) {
        throw 'Installed shortcut preflight did not return a valid manifest'
    }
    $manifest = $preflight.manifest
    if ($null -eq $manifest.PSObject.Properties['product'] -or [string]$manifest.product -cne 'OpenBot' -or
        $null -eq $manifest.PSObject.Properties['appId'] -or [string]$manifest.appId -cne 'local.openbot' -or
        $null -eq $manifest.PSObject.Properties['version'] -or [string]$manifest.version -cne [string]$state.activeVersion -or
        $null -eq $manifest.PSObject.Properties['releaseId'] -or [string]$manifest.releaseId -cne $activeReleaseId -or
        $null -eq $manifest.PSObject.Properties['buildId'] -or
        $null -eq $state.PSObject.Properties['activeBuildId'] -or
        [string]$manifest.buildId -cne [string]$state.activeBuildId -or
        $null -eq $manifest.PSObject.Properties['entrypoint'] -or [string]$manifest.entrypoint -cne 'OpenBot.cmd' -or
        $null -eq $manifest.PSObject.Properties['contentSha256'] -or
        $null -eq $state.PSObject.Properties['activeContentSha256'] -or
        [string]$manifest.contentSha256 -cne [string]$state.activeContentSha256 -or
        $null -eq $state.PSObject.Properties['manifestSha256'] -or
        [string]$manifest.contentSha256 -cne [string]$state.manifestSha256) {
        throw 'Installed shortcut active release identity does not match install state'
    }
    $launcherCommand = Join-Path $launcherRoot 'OpenBot.cmd'
    $gatewayScript = Join-Path $releaseRoot 'app\dist\main.js'
    $logsRoot = Join-Path $launcherRoot 'logs'
} else {
    throw "Shortcut does not target a recognized OpenBot hidden launcher: $shortcutLauncher"
}
if (-not (Test-Path -LiteralPath $gatewayScript -PathType Leaf)) {
    throw "Shortcut gateway entrypoint does not exist: $gatewayScript"
}

$appData = Join-Path $smokeRoot 'roaming'
$localData = Join-Path $smokeRoot 'local'
$dataRoot = Join-Path $smokeRoot 'data'
$userData = Join-Path $smokeRoot 'electron'
New-Item -ItemType Directory -Path $appData, $localData, $dataRoot, $userData -Force | Out-Null

$savedEnvironment = @{}
$environmentNames = @('APPDATA', 'LOCALAPPDATA', 'OPENBOT_DATA_ROOT', 'OPENBOT_LOCAL_DATA_ROOT', 'OPENBOT_USER_DATA', 'ELECTRON_PATH')
foreach ($name in $environmentNames) {
    $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    $savedEnvironment[$name] = if ($null -eq $item) { $null } else { [string]$item.Value }
}

$primary = $null
$secondary = $null
$electronPid = $null
$gatewayPid = $null
$windowReady = $false
$visibleConsole = $false
$portReleased = $false
$tokenFoundInLogs = $false

function Stop-VerifiedProcess {
    param(
        [AllowNull()][object]$ProcessId,
        [string]$CommandPart,
        [switch]$Tree
    )
    if ($null -eq $ProcessId) { return }
    $pidValue = [int]$ProcessId
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
    if ($null -eq $info) { return }
    if (([string]$info.CommandLine).IndexOf($CommandPart, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Refusing cleanup for unowned PID $pidValue"
    }
    if ($Tree) {
        & taskkill.exe /PID $pidValue /T /F 2>$null | Out-Null
    } else {
        Stop-Process -Id $pidValue -Force -ErrorAction Stop
    }
}

try {
    $env:APPDATA = $appData
    $env:LOCALAPPDATA = $localData
    $env:OPENBOT_DATA_ROOT = $dataRoot
    $env:OPENBOT_LOCAL_DATA_ROOT = $localData
    $env:OPENBOT_USER_DATA = $userData
    $env:ELECTRON_PATH = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 1340)
    try {
        $listener.Start()
    } catch {
        throw "Port 1340 is not free before shortcut smoke: $($_.Exception.Message)"
    } finally {
        $listener.Stop()
    }

    $primary = Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $shortcut.WorkingDirectory -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(35)
    do {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:1340/health' -TimeoutSec 1
            if ($health.ok -eq $true -and [int]$health.pid -gt 0) {
                $gatewayPid = [int]$health.pid
                break
            }
        } catch {
            # Startup is still in progress.
        }
        if ($primary.HasExited) { throw "Primary shortcut exited before health, code $($primary.ExitCode)" }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if ($null -eq $gatewayPid) { throw 'Shortcut gateway did not become healthy' }

    $deadline = (Get-Date).AddSeconds(30)
    do {
        $electronInfo = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -ieq 'electron.exe' -and
            ([string]$_.CommandLine).IndexOf('electron-main\main.cjs', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            ([string]$_.CommandLine).IndexOf($userData, [StringComparison]::OrdinalIgnoreCase) -ge 0
        } | Select-Object -First 1
        if ($null -ne $electronInfo) {
            $electronPid = [int]$electronInfo.ProcessId
            $electronProcess = Get-Process -Id $electronPid -ErrorAction SilentlyContinue
            if ($null -ne $electronProcess -and $electronProcess.MainWindowHandle -ne 0) {
                $windowReady = $true
                break
            }
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if (-not $windowReady) { throw 'Electron main window did not become visible' }

    $launcherProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq 'cmd.exe' -and ([string]$_.CommandLine).IndexOf($launcherCommand, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    foreach ($launcherInfo in $launcherProcesses) {
        $launcherProcess = Get-Process -Id ([int]$launcherInfo.ProcessId) -ErrorAction SilentlyContinue
        if ($null -ne $launcherProcess -and $launcherProcess.MainWindowHandle -ne 0) { $visibleConsole = $true }
    }
    if ($visibleConsole) { throw 'Shortcut launcher exposed a visible console window' }

    $gatewayInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $gatewayPid" -ErrorAction SilentlyContinue
    if ($null -eq $gatewayInfo -or $gatewayInfo.Name -ine 'node.exe' -or
        ([string]$gatewayInfo.CommandLine).IndexOf($gatewayScript, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Gateway ownership probe failed before the second shortcut launch'
    }

    $secondary = Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $shortcut.WorkingDirectory -WindowStyle Hidden -PassThru
    if (-not $secondary.WaitForExit(45000)) {
        $processSnapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
        $matchingElectron = @($processSnapshot | Where-Object {
            $_.Name -ieq 'electron.exe' -and ([string]$_.CommandLine).IndexOf($userData, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }).Count
        $mainElectron = @($processSnapshot | Where-Object {
            $_.Name -ieq 'electron.exe' -and
            ([string]$_.CommandLine).IndexOf($userData, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            ([string]$_.CommandLine).IndexOf('electron-main\main.cjs', [StringComparison]::OrdinalIgnoreCase) -ge 0
        }).Count
        $launcherCount = @($processSnapshot | Where-Object {
            $_.Name -ieq 'cmd.exe' -and ([string]$_.CommandLine).IndexOf($launcherCommand, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }).Count
        throw "Secondary shortcut did not exit; Electron=$matchingElectron main=$mainElectron launcher=$launcherCount"
    }
    if ($secondary.ExitCode -ne 0) { throw "Secondary shortcut exit code was $($secondary.ExitCode)" }

    $electronProcess = Get-Process -Id $electronPid -ErrorAction Stop
    if (-not $electronProcess.CloseMainWindow()) { throw 'Electron main window refused a graceful close request' }
    if (-not $primary.WaitForExit(30000)) { throw 'Primary shortcut did not finish after graceful Electron close' }
    if ($primary.ExitCode -ne 0) { throw "Primary shortcut exit code was $($primary.ExitCode)" }

    $deadline = (Get-Date).AddSeconds(15)
    do {
        $portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 1340)
        $portProbe.Server.ExclusiveAddressUse = $true
        try {
            $portProbe.Start()
            $portReleased = $true
            break
        } catch {
            # The previous gateway still owns the port.
        } finally {
            $portProbe.Stop()
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if (-not $portReleased) { throw 'Gateway still owns port 1340 after primary exit' }

    $tokenPath = Join-Path $dataRoot 'gateway.token'
    if (Test-Path -LiteralPath $tokenPath -PathType Leaf) {
        $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
        if (-not [string]::IsNullOrWhiteSpace($token)) {
            $matches = Get-ChildItem -LiteralPath $logsRoot -File -ErrorAction SilentlyContinue |
                Select-String -SimpleMatch -Pattern $token -ErrorAction SilentlyContinue
            $tokenFoundInLogs = $null -ne $matches
        }
    }
    if ($tokenFoundInLogs) { throw 'Gateway token was found in local logs' }

    [pscustomobject]@{
        shortcut = $ShortcutPath
        gatewayHealthy = $true
        mainWindowVisible = $windowReady
        visibleConsole = $visibleConsole
        secondaryExitCode = $secondary.ExitCode
        primaryExitCode = $primary.ExitCode
        portReleased = $portReleased
        gatewayTokenFoundInLogs = $tokenFoundInLogs
        isolated = $true
    } | ConvertTo-Json -Compress
} finally {
    Stop-VerifiedProcess -ProcessId $electronPid -CommandPart $userData -Tree
    Stop-VerifiedProcess -ProcessId $gatewayPid -CommandPart $gatewayScript
    if ($null -ne $primary -and -not $primary.HasExited) { Stop-Process -Id $primary.Id -Force -ErrorAction SilentlyContinue }
    if ($null -ne $secondary -and -not $secondary.HasExited) { Stop-Process -Id $secondary.Id -Force -ErrorAction SilentlyContinue }
    foreach ($name in $environmentNames) {
        if ($null -eq $savedEnvironment[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        } else {
            Set-Item -LiteralPath "Env:$name" -Value $savedEnvironment[$name]
        }
    }
    if ($smokeFull.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $smokeFull -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $smokeFull) {
            throw "Shortcut smoke cleanup did not remove its temporary root: $smokeFull"
        }
    }
}
