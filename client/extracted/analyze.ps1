param(
    [string]$File = "index-DVUCYGay.js",
    [string]$Pattern = "'(?:agent|tool|message|view|screen|tab|panel|terminal|computer|diff|preview|chat)[A-Za-z0-9\-\./_]{2,50}'",
    [int]$Top = 150,
    [switch]$CaseSensitive,
    [string]$Quote = "'"
)
$dir = "C:\SuperAgent\grokbot-src\extracted\dist\renderer\assets"
$c = Get-Content (Join-Path $dir $File) -Raw
$opts = if ($CaseSensitive) { 'None' } else { 'IgnoreCase' }
$s = [regex]::Matches($c, $Pattern, $opts)
$h = @{}
foreach ($m in $s) { $v = $m.Value.Trim($Quote); $h[$v] = ($h[$v] + 1) }
$h.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First $Top | ForEach-Object { Write-Output ($_.Key + ' = ' + $_.Value) }
