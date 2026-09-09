$ErrorActionPreference = 'Stop'
$script:BlockedHosts = @('cursor.sh', 'cursorvm.com', 'statsigcdn.com', 'sentry.io')

# A TCP row contains an IP, not a trustworthy hostname. Resolve expected names
# first and compare only normalized IPv4/IPv6 addresses.
function Normalize-IpAddress {
  param([Parameter(Mandatory = $true)][string]$Address)
  $value = $Address.Trim().TrimStart('[').TrimEnd(']')
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  try {
    $parsed = [System.Net.IPAddress]::Parse($value)
    if ($parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6 -and $parsed.IsIPv4MappedToIPv6) {
      return $parsed.MapToIPv4().ToString().ToLowerInvariant()
    }
    return $parsed.ToString().ToLowerInvariant()
  } catch { return $null }
}

function Resolve-ExpectedHostAddresses {
  param([Parameter(Mandatory = $true)][string]$Hostname, [scriptblock]$Resolver = $null)
  try {
    $records = @()
    $resolutionErrors = @()
    foreach ($type in @('A', 'AAAA')) {
      try {
        $records += if ($null -ne $Resolver) { @(& $Resolver $Hostname $type) } else { @(Resolve-DnsName -Name $Hostname -Type $type -ErrorAction Stop) }
      } catch { $resolutionErrors += $_.Exception.Message }
    }
    $ips = @($records | ForEach-Object {
      $candidate = if ($_.IPAddress) { $_.IPAddress } elseif ($_ -is [string]) { $_ } else { $null }
      Normalize-IpAddress $candidate
    } | Where-Object { $_ } | Sort-Object -Unique)
    if ($ips.Count -eq 0) { return [pscustomobject]@{ Hostname = $Hostname; Status = 'unknown'; Addresses = @(); Error = ($resolutionErrors -join '; ') } }
    return [pscustomobject]@{ Hostname = $Hostname; Status = 'resolved'; Addresses = $ips; Error = $null }
  } catch {
    return [pscustomobject]@{ Hostname = $Hostname; Status = 'unknown'; Addresses = @(); Error = $_.Exception.Message }
  }
}

function Get-NetworkIdentity {
  param([Parameter(Mandatory = $true)][object]$Connection, [Parameter(Mandatory = $true)][hashtable]$ResolvedHosts)
  $remoteIp = Normalize-IpAddress ([string]$Connection.RemoteAddress)
  if ($null -eq $remoteIp) {
    return [pscustomobject]@{ Status = 'unknown'; RemoteAddress = $null; Hostnames = @(); MatchedBlockedHost = $null }
  }
  if ($remoteIp -in @('127.0.0.1', '::1')) {
    return [pscustomobject]@{ Status = 'local'; RemoteAddress = $remoteIp; Hostnames = @(); MatchedBlockedHost = $null }
  }
  $matches = @($ResolvedHosts.GetEnumerator() | Where-Object { $_.Value.Status -eq 'resolved' -and $remoteIp -in $_.Value.Addresses } | ForEach-Object { $_.Key })
  $blockedMatch = @($matches | Where-Object { $script:BlockedHosts -contains $_ })
  if ($blockedMatch.Count -gt 0) {
    return [pscustomobject]@{ Status = 'blocked'; RemoteAddress = $remoteIp; Hostnames = $matches; MatchedBlockedHost = $blockedMatch[0] }
  }
  $status = if ($matches.Count -gt 0) { 'allowed-or-unlisted' } else { 'unknown' }
  return [pscustomobject]@{ Status = $status; RemoteAddress = $remoteIp; Hostnames = $matches; MatchedBlockedHost = $null }
}

function Invoke-NetworkMonitor {
  param(
    [int]$DurationSeconds = $(if ($env:OPENBOT_MONITOR_SECONDS) { [int]$env:OPENBOT_MONITOR_SECONDS } else { 30 }),
    [string]$LogPath = $(if ($env:OPENBOT_NETWORK_LOG) { $env:OPENBOT_NETWORK_LOG } else { 'openbot-network.log' }),
    [scriptblock]$ResolveHost = $null, [scriptblock]$GetConnections = $null, [switch]$NoSleep
  )
  $resolved = @{}
  foreach ($hostname in $script:BlockedHosts) { $resolved[$hostname] = Resolve-ExpectedHostAddresses -Hostname $hostname -Resolver $ResolveHost }
  $end = (Get-Date).AddSeconds([Math]::Max(0, $DurationSeconds))
  do {
    $connections = if ($null -ne $GetConnections) { & $GetConnections } else { Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue }
    foreach ($connection in @($connections)) {
      $identity = Get-NetworkIdentity -Connection $connection -ResolvedHosts $resolved
      if ($identity.Status -eq 'local') { continue }
      $record = [pscustomobject]@{ Timestamp = Get-Date -Format o; OwningProcess = $connection.OwningProcess; RemoteAddress = $identity.RemoteAddress; RemotePort = $connection.RemotePort; IdentityStatus = $identity.Status; Hostnames = @($identity.Hostnames) }
      $record | ConvertTo-Json -Compress | Add-Content -Path $LogPath
      if ($identity.Status -eq 'blocked') { throw "blocked egress detected for resolved host $($identity.MatchedBlockedHost) at $($identity.RemoteAddress)" }
    }
    if (-not $NoSleep) { Start-Sleep -Seconds 1 }
  } while ((Get-Date) -lt $end -and $DurationSeconds -gt 0)
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-NetworkMonitor }
