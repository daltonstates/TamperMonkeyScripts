param(
    [string]$SettingsPath="$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json",
    [string]$StateDirectory,
    [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
if($CheckOnly){[void](Read-VMSettings $SettingsPath);'Manual requests use the same host/guest queue and inactivity policy.';return}
& (Join-Path $PSScriptRoot 'Invoke-VMWorkflow.ps1') -SettingsPath $SettingsPath -Repeat
exit $LASTEXITCODE
