param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'GoodreadsGiveawaysVM\guest-package'),
    [string]$DailySettingsPath = "$env:LOCALAPPDATA\GoodreadsKeyfireCompanion\daily-settings.json",
    [string[]]$GuestProfileNames = @('Profile 1', 'Profile 2', 'Profile 3')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
$source = Split-Path -Parent $PSScriptRoot
$daily = Get-Content -LiteralPath $DailySettingsPath -Raw | ConvertFrom-Json
$python = Join-Path $Destination 'runtime\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Prepare the official embedded Python runtime under the package runtime folder first.' }
New-Item -ItemType Directory -Path (Join-Path $Destination 'Goodreads\VM') -Force | Out-Null
foreach ($name in @('DailyGiveaways.py', 'KeyfireGiveaways.py', 'Giveaways.js')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $Destination 'Goodreads') -Force
}
foreach ($name in @('GuestWorkflow.py', 'Install-VMGuest.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $Destination 'Goodreads\VM') -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $Destination 'README.md') -Force
# Include only the selected macro. Never copy Edge cookies, profiles, or the helper's private key.
$keyfire = Get-Content -LiteralPath $daily.keyfireConfig -Raw | ConvertFrom-Json
$macros = @($keyfire.assignments.PSObject.Properties | Where-Object {
    $_.Value.type -eq 'macro' -and $_.Value.label.Trim() -eq $daily.macroName -and
    (-not $daily.macroProfile -or $_.Name.Split('::')[0] -eq $daily.macroProfile)
})
if ($macros.Count -ne 1) { throw 'Exactly one saved macro must match the daily runner settings.' }
$assignments = @{}
$assignments[$macros[0].Name] = $macros[0].Value
Write-VMJson (Join-Path $Destination 'keyfire-config.json') @{ assignments = $assignments }
$template = $daily | Select-Object startAt, startJitterMinutes, macroName, macroProfile, profiles
if ($GuestProfileNames.Count -ne @($template.profiles).Count) { throw 'Provide one guest profile name for each scheduled account.' }
for ($i = 0; $i -lt $GuestProfileNames.Count; $i++) { $template.profiles[$i].name = $GuestProfileNames[$i] }
$template | Add-Member -Force NoteProperty closeCompletedListings $true
Write-VMJson (Join-Path $Destination 'daily-settings.template.json') $template
& $python (Join-Path $Destination 'Goodreads\KeyfireGiveaways.py') --config (Join-Path $Destination 'keyfire-config.json') --macro-name $daily.macroName --check
if ($LASTEXITCODE -ne 0) { throw 'The packaged macro failed validation.' }
Write-Output "Prepared guest package: $Destination"
