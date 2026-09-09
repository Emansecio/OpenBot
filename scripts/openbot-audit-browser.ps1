param(
    [ValidateRange(0, 65535)]
    [int]$Port = 0,
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$launcher = Join-Path $scriptDir 'openbot-desktop.cmd'
$logsDir = Join-Path $repoRoot 'logs'
$statePath = Join-Path $logsDir 'audit-browser.json'

function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Assert-PortAvailable {
    param([int]$Candidate)

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Candidate)
    try {
        $listener.Start()
    }
    catch {
        throw "Porta CDP indisponivel em 127.0.0.1:$Candidate"
    }
    finally {
        $listener.Stop()
    }
}

function Resolve-AuditBrowser {
    foreach ($commandName in @('chrome.exe', 'msedge.exe')) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($null -ne $command) { return $command.Source }
    }

    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $programFilesX86 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($candidate in $candidates) {
        if ((Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    return $null
}

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Launcher nao encontrado: $launcher"
}
if (-not (Test-Path -LiteralPath $logsDir -PathType Container)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
}
if ($Port -eq 0) { $Port = Get-FreeLoopbackPort }
Assert-PortAvailable -Candidate $Port

$stdoutPath = Join-Path $logsDir "audit-browser-$Port.out.log"
$stderrPath = Join-Path $logsDir "audit-browser-$Port.err.log"
$previousPort = $env:OPENBOT_AUDIT_CDP_PORT
try {
    $env:OPENBOT_AUDIT_CDP_PORT = [string]$Port
    $launcherCommand = 'call "' + $launcher + '"'
    $launcherProcess = Start-Process -FilePath $env:ComSpec -ArgumentList @(
        '/d', '/c', $launcherCommand
    ) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
}
finally {
    if ($null -eq $previousPort) {
        Remove-Item -LiteralPath 'Env:OPENBOT_AUDIT_CDP_PORT' -ErrorAction SilentlyContinue
    }
    else {
        $env:OPENBOT_AUDIT_CDP_PORT = $previousPort
    }
}

$endpoint = "http://127.0.0.1:$Port"
$target = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    if ($launcherProcess.HasExited) {
        throw "OpenBot encerrou antes de publicar o CDP. Consulte $stdoutPath e $stderrPath. Feche outra instancia do OpenBot antes de tentar novamente."
    }
    try {
        $targets = @(Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 1)
        $target = $targets | Where-Object { $_.type -eq 'page' -and $_.title -eq 'OpenBot' } | Select-Object -First 1
        if ($null -ne $target) { break }
    }
    catch {
        # Electron ainda esta iniciando.
    }
    Start-Sleep -Milliseconds 250
}
if ($null -eq $target) {
    throw "OpenBot nao publicou um alvo CDP em $endpoint dentro de 60 segundos."
}

$devtoolsPath = [string]$target.devtoolsFrontendUrl
$devtoolsUrl = if ($devtoolsPath.StartsWith('/')) {
    $endpoint + $devtoolsPath
}
else { $devtoolsPath }
$webSocketUrl = [string]$target.webSocketDebuggerUrl
$browserPath = $null
$browserOpened = $false
if (-not $NoBrowser) {
    $browserPath = Resolve-AuditBrowser
    if (($null -ne $browserPath) -and -not [string]::IsNullOrWhiteSpace($devtoolsUrl)) {
        Start-Process -FilePath $browserPath -ArgumentList @('--new-window', $devtoolsUrl) | Out-Null
        $browserOpened = $true
    }
}

$state = [ordered]@{
    status = 'READY'
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    launcherPid = $launcherProcess.Id
    cdpPort = $Port
    endpoint = $endpoint
    targetId = [string]$target.id
    targetUrl = [string]$target.url
    devtoolsUrl = $devtoolsUrl
    webSocketDebuggerUrl = $webSocketUrl
    browser = $browserPath
    browserOpened = $browserOpened
    stdout = $stdoutPath
    stderr = $stderrPath
}
$state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Output ("OPENBOT_AUDIT_BROWSER_READY " + ($state | ConvertTo-Json -Compress -Depth 4))
