param(
    [string]$ElectronPath = $env:ELECTRON_PATH
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$nodePath = (Get-Command node -ErrorAction Stop).Source
$electronMain = Join-Path $repoRoot 'client\extracted\dist\electron-main\main.cjs'
$fixturePath = Join-Path $repoRoot 'test\e2e-desktop\fixture.mjs'
$checkerPath = Join-Path $repoRoot 'test\e2e-desktop\cdp-check.mjs'
$distMain = Join-Path $repoRoot 'dist\main.js'

if ([string]::IsNullOrWhiteSpace($ElectronPath)) {
    $ElectronPath = 'C:\Users\User\AppData\Local\hermes\hermes-agent\apps\desktop\node_modules\electron\dist\electron.exe'
}
$ElectronPath = [IO.Path]::GetFullPath($ElectronPath)

foreach ($requiredPath in @($ElectronPath, $electronMain, $fixturePath, $checkerPath, $distMain)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required path missing: $requiredPath"
    }
}

function Assert-PortFree {
    param([int]$Port)
    if ($Port -lt 1 -or $Port -gt 65535) { throw "Invalid port: $Port" }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try {
        $listener.Start()
    } catch {
        throw "Port $Port is not free: $($_.Exception.Message)"
    } finally {
        $listener.Stop()
    }
}

function Get-FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

function Test-UnderTemp {
    param([string]$Path)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $prefix = $tempBase + [IO.Path]::DirectorySeparatorChar
    return $candidate -ne $tempBase -and $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Test-UnderPath {
    param(
        [string]$Path,
        [string]$Base
    )
    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $basePath = [IO.Path]::GetFullPath($Base).TrimEnd('\')
    $prefix = $basePath + [IO.Path]::DirectorySeparatorChar
    return $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Convert-ProcessCreationDate {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return [datetime]$Value }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    $parsed = $null
    try {
        $parsed = [Management.ManagementDateTimeConverter]::ToDateTime($text)
    } catch {
        try {
            $parsed = [datetime]::Parse($text, [Globalization.CultureInfo]::InvariantCulture)
        } catch {
            $parsed = $null
        }
    }
    return $parsed
}

function Test-ProcessIdentity {
    param(
        [AllowNull()][object]$Expected,
        [AllowNull()][object]$Actual
    )
    if ($null -eq $Expected -or $null -eq $Actual) { return $false }
    $expectedCreation = Convert-ProcessCreationDate -Value $Expected.CreationDate
    $actualCreation = Convert-ProcessCreationDate -Value $Actual.CreationDate
    return $null -ne $expectedCreation -and $null -ne $actualCreation -and $expectedCreation -eq $actualCreation
}

function Get-TreePids {
    param(
        [int]$RootPid,
        [object[]]$Snapshot,
        [object[]]$InitialSnapshot = @()
    )

    $rootInfo = $Snapshot | Where-Object { [int]$_.ProcessId -eq $RootPid } | Select-Object -First 1
    if ($null -eq $rootInfo) { return @() }
    $rootCreation = Convert-ProcessCreationDate -Value $rootInfo.CreationDate
    if ($null -eq $rootCreation) {
        throw "Cannot establish creation time for root PID $RootPid"
    }

    $initialByPid = @{}
    foreach ($item in $InitialSnapshot) {
        if ($null -eq $item) { continue }
        $initialPid = [int]$item.ProcessId
        $initialByPid[$initialPid.ToString([Globalization.CultureInfo]::InvariantCulture)] = $item
    }

    $ids = @($RootPid)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($item in $Snapshot) {
            if ($null -eq $item) { continue }
            $childPid = [int]$item.ProcessId
            $parentPid = [int]$item.ParentProcessId
            if (($ids -contains $parentPid) -and -not ($ids -contains $childPid)) {
                $childCreation = Convert-ProcessCreationDate -Value $item.CreationDate
                if ($null -eq $childCreation -or $childCreation -le $rootCreation) { continue }
                $initialKey = $childPid.ToString([Globalization.CultureInfo]::InvariantCulture)
                if ($initialByPid.ContainsKey($initialKey)) {
                    $initialCreation = Convert-ProcessCreationDate -Value $initialByPid[$initialKey].CreationDate
                    if ($null -eq $initialCreation -or $childCreation -le $initialCreation) { continue }
                }
                $ids += $childPid
                $changed = $true
            }
        }
    }
    return @($ids | Select-Object -Unique)
}

function Stop-OwnTree {
    param(
        [int]$ProcessId,
        [string]$ExpectedCommandPart,
        [string]$ExpectedRoot,
        [object[]]$InitialSnapshot = @(),
        [scriptblock]$SnapshotProvider = $null,
        [scriptblock]$KillProcess = $null
    )
    if ($null -eq $SnapshotProvider) {
        $SnapshotProvider = { @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) }
    }
    if ($null -eq $KillProcess) {
        $KillProcess = {
            param([int]$TargetPid)
            & taskkill.exe /PID $TargetPid /F | Out-Null
            return $LASTEXITCODE
        }
    }

    $snapshot = @(& $SnapshotProvider)
    $processInfo = $snapshot | Where-Object { [int]$_.ProcessId -eq $ProcessId } | Select-Object -First 1
    if ($null -eq $processInfo) { return }
    $commandLine = [string]$processInfo.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) {
        throw "Refusing teardown: command line unavailable for PID $ProcessId"
    }
    if ($commandLine.IndexOf($ExpectedCommandPart, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $commandLine.IndexOf($ExpectedRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Refusing teardown: PID $ProcessId does not match owned command"
    }

    $ownedByPid = @{}
    $ownedOrder = @()
    $rootKey = $ProcessId.ToString([Globalization.CultureInfo]::InvariantCulture)
    $ownedByPid[$rootKey] = $processInfo
    $ownedOrder += $rootKey

    $deadline = (Get-Date).AddSeconds(8)
    $stableAbsentRounds = 0
    do {
        $current = @(& $SnapshotProvider)
        $currentRoot = $current | Where-Object { [int]$_.ProcessId -eq $ProcessId } | Select-Object -First 1
        if ($null -eq $currentRoot) {
            $discoverySnapshot = @($current + $processInfo)
        } elseif (Test-ProcessIdentity -Expected $processInfo -Actual $currentRoot) {
            $discoverySnapshot = $current
        } else {
            # The root PID was reused. Do not infer ownership from its parent PID.
            $discoverySnapshot = @()
        }

        if ($discoverySnapshot.Count -gt 0) {
            $discoveredPids = @(Get-TreePids -RootPid $ProcessId -Snapshot $discoverySnapshot -InitialSnapshot $InitialSnapshot)
            foreach ($discoveredPid in $discoveredPids) {
                $discoveredKey = ([int]$discoveredPid).ToString([Globalization.CultureInfo]::InvariantCulture)
                if ($ownedByPid.ContainsKey($discoveredKey)) { continue }
                $discoveredProcess = $discoverySnapshot | Where-Object { [int]$_.ProcessId -eq [int]$discoveredPid } | Select-Object -First 1
                if ($null -eq $discoveredProcess) { continue }
                $ownedByPid[$discoveredKey] = $discoveredProcess
                $ownedOrder += $discoveredKey
            }
        }

        for ($index = $ownedOrder.Count - 1; $index -ge 0; $index--) {
            $expected = $ownedByPid[$ownedOrder[$index]]
            $beforeKill = @(& $SnapshotProvider)
            $actual = $beforeKill | Where-Object { [int]$_.ProcessId -eq [int]$expected.ProcessId } | Select-Object -First 1
            if ($null -eq $actual -or -not (Test-ProcessIdentity -Expected $expected -Actual $actual)) { continue }

            $killExitCode = & $KillProcess ([int]$expected.ProcessId)
            if ($null -eq $killExitCode) { $killExitCode = 1 }
            if ([int]$killExitCode -ne 0) {
                $remainingAfterKill = @(& $SnapshotProvider)
                $stillOwned = $remainingAfterKill | Where-Object {
                    [int]$_.ProcessId -eq [int]$expected.ProcessId -and (Test-ProcessIdentity -Expected $expected -Actual $_)
                } | Select-Object -First 1
                if ($null -ne $stillOwned) {
                    throw "taskkill failed for owned PID $($expected.ProcessId) with exit code $killExitCode"
                }
            }
        }

        $current = @(& $SnapshotProvider)
        $remaining = @(
            foreach ($ownedKey in $ownedOrder) {
                $expected = $ownedByPid[$ownedKey]
                $actual = $current | Where-Object { [int]$_.ProcessId -eq [int]$expected.ProcessId } | Select-Object -First 1
                if ($null -ne $actual -and (Test-ProcessIdentity -Expected $expected -Actual $actual)) {
                    [int]$expected.ProcessId
                }
            }
        )
        if ($remaining.Count -eq 0) {
            $stableAbsentRounds++
            if ($stableAbsentRounds -ge 2) { return }
        } else {
            $stableAbsentRounds = 0
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    throw "Owned process tree did not exit: $($remaining -join ',')"
}

function Save-Environment {
    param([string[]]$Names)
    $saved = @{}
    foreach ($name in $Names) {
        $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        if ($null -eq $item) {
            $saved[$name] = @{ Present = $false; Value = $null }
        } else {
            $saved[$name] = @{ Present = $true; Value = [string]$item.Value }
        }
    }
    return $saved
}

function Restore-Environment {
    param([hashtable]$Saved)
    foreach ($name in $Saved.Keys) {
        $entry = $Saved[$name]
        if ($entry.Present) {
            Set-Item -LiteralPath "Env:$name" -Value $entry.Value
        } else {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
    }
}

function Redact-Secret {
    param(
        [AllowNull()][string]$Value,
        [AllowNull()][string]$Secret
    )
    if ($null -eq $Value) { return $null }
    if ([string]::IsNullOrEmpty($Secret)) { return $Value }
    return $Value.Replace($Secret, '<redacted>')
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $repoRoot ("logs\e2e-desktop\run-{0}-{1}" -f $timestamp, $PID)
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$runnerLog = Join-Path $runDir 'runner.log'
$fixtureOut = Join-Path $runDir 'fixture.stdout.log'
$fixtureErr = Join-Path $runDir 'fixture.stderr.log'
$readyEvidence = Join-Path $runDir 'fixture-ready-final.json'
$statusEvidence = Join-Path $runDir 'fixture-status-final.json'
$electronOut = Join-Path $runDir 'electron.stdout.log'
$electronErr = Join-Path $runDir 'electron.stderr.log'
$electronLog = Join-Path $runDir 'electron-chromium.log'
$cdpOut = Join-Path $runDir 'cdp.stdout.log'
$cdpErr = Join-Path $runDir 'cdp.stderr.log'

$ownedNames = @(
    'APPDATA', 'LOCALAPPDATA', 'OPENBOT_USER_DATA', 'OPENBOT_ATTACHMENT_STAGING',
    'SAND_USER_DATA_DIR', 'SAND_DATA_ROOT', 'SAND_HOST_GATEWAY_URL',
    'SAND_HOST_GATEWAY_TOKEN', 'SAND_HOST_GATEWAY_NETWORK_TOKEN',
    'OPENBOT_LOCAL_GATEWAY', 'OPENBOT_VISUAL_TEST', 'E2E_GATEWAY_TOKEN',
    'ELECTRON_RUN_AS_NODE'
)
$savedEnvironment = Save-Environment -Names $ownedNames
$runRoot = $null
$runRootCreated = $false
$fixtureRoot = $null
$readyFile = $null
$statusFile = $null
$fixtureProcess = $null
$electronProcess = $null
$cdpExit = 1
$failure = $null
$gatewayPort = $null
$cdpPort = $null
$gatewayToken = $null
$teardownSafe = $true
$processesAbsent = $true
$portsFree = $true
$diagnosticEvidence = $null
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$initialProcessSnapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)

try {
    $cdpPort = Get-FreePort

    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $runRoot = Join-Path $tempBase ("openbot-e2e-desktop-{0}-{1}" -f $timestamp, $PID)
    New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
    $runRootCreated = $true
    if (-not (Test-UnderTemp -Path $runRoot)) {
        throw "Refusing to use non-TEMP run root: $runRoot"
    }

    $appData = Join-Path $runRoot 'appdata'
    $localAppData = Join-Path $runRoot 'localappdata'
    $userData = Join-Path $runRoot 'user-data'
    $staging = Join-Path $runRoot 'staging'
    $dataRoot = Join-Path $runRoot 'data-root'
    $fixtureRoot = Join-Path $runRoot 'gateway'
    $readyFile = Join-Path $fixtureRoot 'ready.json'
    $statusFile = Join-Path $fixtureRoot 'status.json'
    foreach ($directory in @($appData, $localAppData, $userData, $staging, $dataRoot, $fixtureRoot)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }

    $tokenBytes = New-Object byte[] 24
    $tokenGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $tokenGenerator.GetBytes($tokenBytes)
    } finally {
        $tokenGenerator.Dispose()
    }
    $gatewayToken = [Convert]::ToBase64String($tokenBytes)

    $env:APPDATA = $appData
    $env:LOCALAPPDATA = $localAppData
    $env:OPENBOT_USER_DATA = $userData
    $env:OPENBOT_ATTACHMENT_STAGING = $staging
    $env:SAND_USER_DATA_DIR = $userData
    $env:SAND_DATA_ROOT = $dataRoot
    $env:SAND_HOST_GATEWAY_URL = 'http://127.0.0.1:0'
    $env:SAND_HOST_GATEWAY_TOKEN = $gatewayToken
    $env:SAND_HOST_GATEWAY_NETWORK_TOKEN = $gatewayToken
    $env:OPENBOT_LOCAL_GATEWAY = '1'
    $env:OPENBOT_VISUAL_TEST = '1'
    $env:E2E_GATEWAY_TOKEN = $gatewayToken
    Remove-Item -LiteralPath 'Env:ELECTRON_RUN_AS_NODE' -ErrorAction SilentlyContinue

    $fixtureProcess = Start-Process -FilePath $nodePath -ArgumentList @(
        $fixturePath, '--root', $fixtureRoot, '--ready-file', $readyFile, '--status-file', $statusFile, '--port', '0'
    ) -WorkingDirectory $repoRoot -RedirectStandardOutput $fixtureOut -RedirectStandardError $fixtureErr -WindowStyle Hidden -PassThru

    $fixtureReady = $false
    $fixtureReadyInfo = $null
    for ($attempt = 0; $attempt -lt 160; $attempt++) {
        if ($fixtureProcess.HasExited) {
            throw "Fixture exited before readiness (code $($fixtureProcess.ExitCode))"
        }
        if (Test-Path -LiteralPath $readyFile -PathType Leaf) {
            try {
                $fixtureReadyInfo = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
                $candidatePort = [int]$fixtureReadyInfo.port
                $candidatePid = [int]$fixtureReadyInfo.pid
                if ($candidatePort -ge 1 -and $candidatePort -le 65535 -and $candidatePid -eq $fixtureProcess.Id) {
                    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$candidatePort/health" -TimeoutSec 1
                    if ($health.ok -eq $true -and [int]$health.pid -eq $fixtureProcess.Id) {
                        $gatewayPort = $candidatePort
                        $fixtureReady = $true
                        break
                    }
                }
            } catch {
                # The fixture is still writing its ready file or binding its dynamic port.
            }
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $fixtureReady) { throw 'Fixture did not publish a valid dynamic ready-file/health PID' }
    $readyPaths = @($fixtureReadyInfo.storePath, $fixtureReadyInfo.configPath, $fixtureReadyInfo.keystoreDir, $fixtureReadyInfo.workspacesRoot, $fixtureReadyInfo.readyFile, $fixtureReadyInfo.statusFile)
    foreach ($readyPath in $readyPaths) {
        if (-not (Test-UnderPath -Path ([string]$readyPath) -Base $runRoot)) {
            throw "Fixture ready-file path escaped temp root: $readyPath"
        }
    }

    $env:SAND_HOST_GATEWAY_URL = "http://127.0.0.1:$gatewayPort"
    $metadata = [ordered]@{
        status = 'RUNNING'
        startedAt = $startedAt
        electronPath = $ElectronPath
        electronMain = $electronMain
        gatewayPort = $gatewayPort
        cdpPort = $cdpPort
        fixturePid = $fixtureProcess.Id
        readyFile = $readyFile
        statusFile = $statusFile
        appData = $appData
        localAppData = $localAppData
        userData = $userData
        staging = $staging
        dataRoot = $dataRoot
        fixtureRoot = $fixtureRoot
    }
    ($metadata | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $runDir 'run.json') -Encoding utf8

    $electronArguments = @(
        "--user-data-dir=$userData",
        '--no-sandbox',
        '--disable-gpu',
        '--use-fake-device-for-media-stream',
        '--enable-logging',
        "--log-file=$electronLog",
        "--remote-debugging-port=$cdpPort",
        $electronMain
    )
    $electronProcess = Start-Process -FilePath $ElectronPath -ArgumentList $electronArguments -WorkingDirectory $repoRoot -RedirectStandardOutput $electronOut -RedirectStandardError $electronErr -WindowStyle Hidden -PassThru

    $cdpArguments = @(
        $checkerPath, '--cdp-port', [string]$cdpPort, '--gateway-port', [string]$gatewayPort, '--status-file', $statusFile, '--evidence-dir', $runDir
    )
    Push-Location $repoRoot
    try {
        & $nodePath @cdpArguments > $cdpOut 2> $cdpErr
        $cdpExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($null -eq $cdpExit) { $cdpExit = 1 }
    if ($cdpExit -ne 0) {
        throw "CDP checker returned RED (exit code $cdpExit)"
    }
} catch {
    $failure = $_.Exception.Message
    "E2E_RUNNER_ERROR $(Redact-Secret -Value $failure -Secret $gatewayToken)" | Add-Content -LiteralPath $runnerLog -Encoding utf8
} finally {
    try {
        if ($null -ne $electronProcess) {
            Stop-OwnTree -ProcessId $electronProcess.Id -ExpectedCommandPart 'main.cjs' -ExpectedRoot $userData -InitialSnapshot $initialProcessSnapshot
        }
    } catch {
        $processesAbsent = $false
        $teardownSafe = $false
        $failure = if ($null -eq $failure) { "Electron teardown failed: $($_.Exception.Message)" } else { "$failure; Electron teardown failed: $($_.Exception.Message)" }
    }
    try {
        if ($null -ne $fixtureProcess) {
            Stop-OwnTree -ProcessId $fixtureProcess.Id -ExpectedCommandPart 'fixture.mjs' -ExpectedRoot $fixtureRoot -InitialSnapshot $initialProcessSnapshot
        }
    } catch {
        $processesAbsent = $false
        $teardownSafe = $false
        $failure = if ($null -eq $failure) { "Fixture teardown failed: $($_.Exception.Message)" } else { "$failure; Fixture teardown failed: $($_.Exception.Message)" }
    }

    try {
        if ($null -ne $gatewayPort) { Assert-PortFree -Port $gatewayPort }
        if ($null -ne $cdpPort) { Assert-PortFree -Port $cdpPort }
    } catch {
        $portsFree = $false
        $teardownSafe = $false
        $failure = if ($null -eq $failure) { "Port teardown check failed: $($_.Exception.Message)" } else { "$failure; Port teardown check failed: $($_.Exception.Message)" }
    }

    try {
        Restore-Environment -Saved $savedEnvironment
    } catch {
        $teardownSafe = $false
        $failure = if ($null -eq $failure) { "Environment restore failed: $($_.Exception.Message)" } else { "$failure; Environment restore failed: $($_.Exception.Message)" }
    }

    foreach ($evidencePair in @(
        @{ Source = $readyFile; Destination = $readyEvidence },
        @{ Source = $statusFile; Destination = $statusEvidence }
    )) {
        if ($null -eq $evidencePair.Source -or -not (Test-Path -LiteralPath $evidencePair.Source -PathType Leaf)) {
            continue
        }
        try {
            $evidenceRaw = Get-Content -LiteralPath $evidencePair.Source -Raw -ErrorAction Stop
            $evidenceSafe = Redact-Secret -Value $evidenceRaw -Secret $gatewayToken
            Set-Content -LiteralPath $evidencePair.Destination -Value $evidenceSafe -Encoding utf8
        } catch {
            $teardownSafe = $false
            $failure = if ($null -eq $failure) { "Fixture evidence copy failed: $($_.Exception.Message)" } else { "$failure; fixture evidence copy failed: $($_.Exception.Message)" }
        }
    }
    $diagnosticEvidence = [ordered]@{
        fixtureReadyFinal = Test-Path -LiteralPath $readyEvidence -PathType Leaf
        fixtureStatusFinal = Test-Path -LiteralPath $statusEvidence -PathType Leaf
        cdpReport = Test-Path -LiteralPath (Join-Path $runDir 'cdp-report.json') -PathType Leaf
        screenshots = @('window.png', 'incremental.png', 'cancel.png', 'skill-menu.png', 'skill-chip.png', 'skill.png', 'skill-final.png', 'retry.png', 'failure.png' | ForEach-Object {
            [ordered]@{
                name = $_
                present = Test-Path -LiteralPath (Join-Path $runDir $_) -PathType Leaf
            }
        })
    }

    $cleanupNote = $null
    if ($runRootCreated) {
        if (-not (Test-UnderTemp -Path $runRoot)) {
            $cleanupNote = "temp-root-preserved-outside-temp: $runRoot"
            $teardownSafe = $false
            $failure = if ($null -eq $failure) { 'Refused recursive cleanup outside TEMP' } else { "$failure; refused recursive cleanup outside TEMP" }
        } elseif (-not $teardownSafe) {
            $cleanupNote = "temp-root-preserved-after-teardown-failure: $runRoot"
        } else {
            try {
                Remove-Item -LiteralPath $runRoot -Recurse -Force
                $cleanupNote = 'temp-root-removed'
            } catch {
                $cleanupNote = "temp-root-preserved: $runRoot"
                $failure = if ($null -eq $failure) { $_.Exception.Message } else { "$failure; temp cleanup failed: $($_.Exception.Message)" }
            }
        }
    }

    $safeFailure = Redact-Secret -Value $failure -Secret $gatewayToken
    $status = if ([string]::IsNullOrEmpty($safeFailure) -and $cdpExit -eq 0 -and $teardownSafe -and $cleanupNote -eq 'temp-root-removed') { 'GREEN' } else { 'RED' }
    $finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $terminalMetadata = [ordered]@{
        status = $status
        startedAt = $startedAt
        finishedAt = $finishedAt
        electronPath = $ElectronPath
        electronMain = $electronMain
        gatewayPort = $gatewayPort
        cdpPort = $cdpPort
        fixturePid = if ($null -ne $fixtureProcess) { $fixtureProcess.Id } else { $null }
        electronPid = if ($null -ne $electronProcess) { $electronProcess.Id } else { $null }
        readyFile = $readyFile
        statusFile = $statusFile
        readyEvidence = $readyEvidence
        statusEvidence = $statusEvidence
        diagnosticEvidence = $diagnosticEvidence
        runRoot = $runRoot
        cleanup = $cleanupNote
        error = $safeFailure
    }
    ($terminalMetadata | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $runDir 'run.json') -Encoding utf8
    $summary = [ordered]@{
        status = $status
        finishedAt = $finishedAt
        cdpExit = $cdpExit
        gatewayPort = $gatewayPort
        cdpPort = $cdpPort
        fixturePid = if ($null -ne $fixtureProcess) { $fixtureProcess.Id } else { $null }
        electronPid = if ($null -ne $electronProcess) { $electronProcess.Id } else { $null }
        runDir = $runDir
        readyEvidence = $readyEvidence
        statusEvidence = $statusEvidence
        diagnosticEvidence = $diagnosticEvidence
        cleanup = $cleanupNote
        error = $safeFailure
        ownedProcessesAbsent = $processesAbsent
        portsFree = $portsFree
    }
    ($summary | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $runDir 'runner-summary.json') -Encoding utf8
    ($summary | ConvertTo-Json -Depth 6) | Add-Content -LiteralPath $runnerLog -Encoding utf8
    Write-Output ("E2E_RUNNER_SUMMARY " + ($summary | ConvertTo-Json -Compress -Depth 6))
    $gatewayToken = $null
    if ($status -eq 'GREEN') {
        exit 0
    }
    exit 1
}
