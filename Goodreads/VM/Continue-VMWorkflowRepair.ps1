param(
    [string]$SettingsPath="$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json",
    [Parameter(Mandatory=$true)][pscredential]$GuestCredential
)
# Compatibility entry point. There is one installer and one scheduled queue.
& (Join-Path $PSScriptRoot 'Update-VMWorkflow.ps1') -SettingsPath $SettingsPath -GuestCredential $GuestCredential
