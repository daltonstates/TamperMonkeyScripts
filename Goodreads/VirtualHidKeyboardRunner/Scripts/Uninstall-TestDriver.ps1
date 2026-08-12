#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [string] $PackagePath,
    [switch] $RemoveCertificate
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $PackagePath) {
    $PackagePath = Get-TestPackagePath
}
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path

$devcon = Get-WindowsKitTool 'Tools\10.0.28000.0\x64\devcon.exe'
Write-Host 'Removing only ROOT\VirtualHidKeyboard device instances...'
& $devcon remove 'ROOT\VirtualHidKeyboard'
if ($LASTEXITCODE -notin @(0, 1)) {
    throw "DevCon remove exited with code $LASTEXITCODE."
}

$driverPackages = @(Get-WindowsDriver -Online -All | Where-Object {
    $_.OriginalFileName -like '*\VirtualHidKeyboardDriver.inf'
})
foreach ($driverPackage in $driverPackages) {
    Invoke-NativeCommand -FilePath 'pnputil.exe' -ArgumentList @(
        '/delete-driver', $driverPackage.Driver, '/uninstall', '/force'
    )
}

if ($RemoveCertificate) {
    $certificatePath = Join-Path $PackagePath 'VirtualHidKeyboardTest.cer'
    if (Test-Path -LiteralPath $certificatePath) {
        $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
        foreach ($storePath in @('Cert:\LocalMachine\Root', 'Cert:\LocalMachine\TrustedPublisher')) {
            $installedCertificate = Join-Path $storePath $certificate.Thumbprint
            if (Test-Path -LiteralPath $installedCertificate) {
                Remove-Item -LiteralPath $installedCertificate
            }
        }
    }
}

Write-Host 'Virtual HID Keyboard device and matching driver-store package removed.'
Write-Host 'TESTSIGNING was not changed because other test drivers may depend on it.'

