#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [string] $PackagePath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $PackagePath) {
    $PackagePath = Get-TestPackagePath
}
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path

$inf = Join-Path $PackagePath 'VirtualHidKeyboardDriver.inf'
$catalog = Join-Path $PackagePath 'VirtualHidKeyboardDriver.cat'
$certificatePath = Join-Path $PackagePath 'VirtualHidKeyboardTest.cer'
foreach ($requiredFile in @($inf, $catalog, $certificatePath)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required package file is missing: $requiredFile"
    }
}

$bootConfiguration = & bcdedit.exe /enum '{current}'
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to read the current Windows boot configuration.'
}
if (-not ($bootConfiguration -match '(?im)^testsigning\s+Yes\s*$')) {
    throw 'Windows is not running in Test Mode. Run Enable-TestSigning.ps1 -Apply from an elevated terminal, reboot, and then retry this installer.'
}

$publicCertificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
foreach ($storePath in @('Cert:\LocalMachine\Root', 'Cert:\LocalMachine\TrustedPublisher')) {
    if (-not (Test-Path -LiteralPath (Join-Path $storePath $publicCertificate.Thumbprint))) {
        Import-Certificate -FilePath $certificatePath -CertStoreLocation $storePath | Out-Null
    }
}

$signTool = Get-WindowsKitTool 'bin\10.0.28000.0\x64\signtool.exe'
Invoke-NativeCommand -FilePath $signTool -ArgumentList @('verify', '/kp', '/v', $catalog)

$devcon = Get-WindowsKitTool 'Tools\10.0.28000.0\x64\devcon.exe'
$existingDevices = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
    $_.InstanceId -like 'ROOT\VIRTUALHIDKEYBOARD\*'
})

if ($existingDevices.Count -eq 0) {
    Write-Host 'Creating the root-enumerated Virtual HID Keyboard device...'
    Invoke-NativeCommand -FilePath $devcon -ArgumentList @('install', $inf, 'ROOT\VirtualHidKeyboard')
} else {
    Write-Host 'Updating the existing Virtual HID Keyboard device...'
    Invoke-NativeCommand -FilePath $devcon -ArgumentList @('update', $inf, 'ROOT\VirtualHidKeyboard')
}

Start-Sleep -Seconds 2
& (Join-Path $PSScriptRoot 'Verify-TestDriver.ps1') -PackagePath $PackagePath

