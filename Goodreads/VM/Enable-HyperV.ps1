param(
    [string]$OutputDirectory = (Join-Path $env:ProgramData 'GoodreadsGiveawaysVM\setup')
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script as Administrator. It never restarts Windows.'
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$statusPath = Join-Path $OutputDirectory 'hyper-v-status.json'
$status = [ordered]@{ startedAt = [DateTimeOffset]::Now.ToString('o'); state = 'enabling'; restartRequired = $false }
try {
    $result = Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart -LogPath (Join-Path $OutputDirectory 'hyper-v-dism.log')
    $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
    $status.state = [string]$feature.State
    $status.restartRequired = [bool]$result.RestartNeeded -or $feature.State -eq 'EnablePending'
    $status.finishedAt = [DateTimeOffset]::Now.ToString('o')
    $status | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
    Write-Output "Hyper-V: $($status.state). Restart required: $($status.restartRequired). Windows was not restarted."
} catch {
    $status.state = 'failed'
    $status.error = $_.Exception.Message
    $status.finishedAt = [DateTimeOffset]::Now.ToString('o')
    $status | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
    throw
}
