param(
    [string]$SettingsPath="$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json",
    [Parameter(Mandatory=$true)][pscredential]$GuestCredential
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
Assert-VMAdministrator
$settings=Read-VMSettings $SettingsPath
Import-Module Hyper-V
[void](Start-GiveawaysMorningVM $settings)
$session=New-PSSession -VMId ([guid]$settings.vmId) -Credential $GuestCredential
try{
    Invoke-Command -Session $session -ScriptBlock {
        $active=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -match 'DailyGiveaways\.py'})
        if($active.Count){throw 'An active giveaway queue must finish before updating its installed code.'}
        $archive='C:\GoodreadsVM\output\history\update-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
        New-Item -ItemType Directory -Path $archive -Force|Out-Null
        Copy-Item -LiteralPath 'C:\GoodreadsVM\Goodreads' -Destination $archive -Recurse
    }
    foreach($name in @('DailyGiveaways.py','KeyfireGiveaways.py','Giveaways.js')){
        Copy-Item -ToSession $session -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) $name) -Destination ('C:\GoodreadsVM\Goodreads\'+$name) -Force
    }
    foreach($name in @('GuestWorkflow.py','Install-VMGuest.ps1','Configure-TampermonkeyUpdates.cjs')){
        Copy-Item -ToSession $session -LiteralPath (Join-Path $PSScriptRoot $name) -Destination ('C:\GoodreadsVM\Goodreads\VM\'+$name) -Force
    }
    Invoke-Command -Session $session -ScriptBlock {
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
        & 'C:\GoodreadsVM\Goodreads\VM\Install-VMGuest.ps1' -Migrate -Enable
    }
    & (Join-Path $PSScriptRoot 'Install-VMHost.ps1') -SettingsPath $SettingsPath -Enable
}finally{Remove-PSSession $session}
Write-Output 'Installed runtime/tasks migrated. Verify the installed host scheduled entry point; setup checks alone do not verify the daily workflow.'
