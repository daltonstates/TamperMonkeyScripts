param(
    [string]$SettingsPath="$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json",
    [string]$StateDirectory,
    [string[]]$ProfileDirectory,
    [int]$EntryLimit,
    [int]$BatchEntryLimit,
    [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
if($CheckOnly){[void](Read-VMSettings $SettingsPath);'Manual requests use the same host/guest queue and inactivity policy.';return}
$invoke=@{SettingsPath=$SettingsPath;Repeat=$true}
foreach($key in @('ProfileDirectory','EntryLimit','BatchEntryLimit')){if($PSBoundParameters.ContainsKey($key)){$invoke[$key]=$PSBoundParameters[$key]}}
& (Join-Path $PSScriptRoot 'Invoke-VMWorkflow.ps1') @invoke
exit $LASTEXITCODE
