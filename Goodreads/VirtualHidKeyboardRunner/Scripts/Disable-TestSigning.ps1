#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $Apply) {
    Write-Host 'This restores TESTSIGNING OFF for the current Windows boot entry.'
    Write-Host 'Re-run with -Apply after uninstalling every test driver that depends on Test Mode.'
    exit 0
}

Invoke-NativeCommand -FilePath 'bcdedit.exe' -ArgumentList @('/set', 'testsigning', 'off')
Write-Host 'TESTSIGNING is disabled in the boot configuration. Reboot Windows to leave Test Mode.'

