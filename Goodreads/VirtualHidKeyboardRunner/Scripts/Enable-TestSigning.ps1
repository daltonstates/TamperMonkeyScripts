#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$secureBootEnabled = $null
try {
    $secureBootEnabled = Confirm-SecureBootUEFI
} catch {
    Write-Warning "Secure Boot state could not be queried: $($_.Exception.Message)"
}

if ($secureBootEnabled -eq $true) {
    throw 'Secure Boot is enabled. Use a disposable VM or manage Secure Boot and BitLocker manually; this script will not disable either protection.'
}

$bitLocker = $null
if (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue) {
    try {
        $bitLocker = Get-BitLockerVolume -MountPoint $env:SystemDrive
    } catch {
        Write-Warning "BitLocker state could not be queried: $($_.Exception.Message)"
    }
}

if ($bitLocker -and $bitLocker.ProtectionStatus -eq 'On') {
    throw 'BitLocker protection is enabled on the OS volume. Prepare a disposable VM or explicitly manage the recovery-key and suspension workflow before changing boot configuration.'
}

if (-not $Apply) {
    Write-Host 'Preflight passed. Re-run with -Apply to set TESTSIGNING ON. A reboot will then be required.'
    exit 0
}

Invoke-NativeCommand -FilePath 'bcdedit.exe' -ArgumentList @('/set', 'testsigning', 'on')
Write-Host 'TESTSIGNING is enabled in the boot configuration. Reboot Windows before installing the test driver.'

