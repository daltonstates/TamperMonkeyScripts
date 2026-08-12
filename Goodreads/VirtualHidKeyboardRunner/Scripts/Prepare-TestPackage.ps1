[CmdletBinding()]
param(
    [switch] $CreateNewCertificate
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-ProjectRoot
& (Join-Path $PSScriptRoot 'Build.ps1') -Configuration Release
if ($LASTEXITCODE -ne 0) {
    throw 'The build step failed.'
}

& (Join-Path $PSScriptRoot 'New-TestCertificate.ps1') -CreateNew:$CreateNewCertificate | Out-Null
$certificateMetadata = Get-Content -LiteralPath (Get-TestCertificateMetadataPath) -Raw | ConvertFrom-Json
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($certificateMetadata.Thumbprint)"

$applicationPackage = Join-Path (Join-Path $root 'artifacts') 'Application'
$controllerPublish = Join-Path $applicationPackage 'Controller'
$monitorPublish = Join-Path $applicationPackage 'RawInputMonitor'
$controllerProject = Join-Path (Join-Path $root 'Controller') 'VirtualHidKeyboardRunner.csproj'
$monitorProject = Join-Path (Join-Path (Join-Path $root 'Diagnostics') 'RawInputMonitor') 'RawInputMonitor.csproj'

Write-Host 'Publishing self-contained Windows x64 applications...'
Invoke-NativeCommand -FilePath 'dotnet.exe' -ArgumentList @(
    'publish', $controllerProject, '--configuration', 'Release', '--runtime', 'win-x64',
    '--self-contained', 'true', '--output', $controllerPublish,
    '-p:PublishSingleFile=true', '-p:DebugType=None', '--nologo'
)
Invoke-NativeCommand -FilePath 'dotnet.exe' -ArgumentList @(
    'publish', $monitorProject, '--configuration', 'Release', '--runtime', 'win-x64',
    '--self-contained', 'true', '--output', $monitorPublish,
    '-p:PublishSingleFile=true', '-p:DebugType=None', '--nologo'
)

$package = Get-TestPackagePath
New-Item -ItemType Directory -Path $package -Force | Out-Null

$builtPackage = Join-Path (Join-Path (Join-Path (Join-Path $root 'Driver') 'x64') 'Release') 'VirtualHidKeyboardDriver'
$builtDriver = Join-Path (Join-Path (Join-Path (Join-Path $root 'Driver') 'x64') 'Release') 'VirtualHidKeyboardDriver.sys'
$sourceInf = Join-Path $builtPackage 'VirtualHidKeyboardDriver.inf'
if (-not (Test-Path -LiteralPath $sourceInf) -or -not (Test-Path -LiteralPath $builtDriver)) {
    throw 'The WDK build did not produce the expected driver package.'
}

$packageInf = Join-Path $package 'VirtualHidKeyboardDriver.inf'
$packageDriver = Join-Path $package 'VirtualHidKeyboardDriver.sys'
$packageCatalog = Join-Path $package 'VirtualHidKeyboardDriver.cat'
$packageCertificate = Join-Path $package 'VirtualHidKeyboardTest.cer'
$packageManifest = Join-Path $package 'manifest.json'

foreach ($staleOutput in @($packageCatalog, $packageCertificate, $packageManifest)) {
    if (Test-Path -LiteralPath $staleOutput) {
        Remove-Item -LiteralPath $staleOutput
    }
}

Copy-Item -LiteralPath $sourceInf -Destination $packageInf -Force
Copy-Item -LiteralPath $builtDriver -Destination $packageDriver -Force

$signTool = Get-WindowsKitTool 'bin\10.0.28000.0\x64\signtool.exe'
$inf2Cat = Get-WindowsKitTool 'bin\10.0.28000.0\x86\Inf2Cat.exe'

Write-Host 'Embedding the test signature in the driver binary...'
Invoke-NativeCommand -FilePath $signTool -ArgumentList @(
    'sign', '/v', '/fd', 'SHA256', '/s', 'My', '/sha1', $certificate.Thumbprint, $packageDriver
)

Write-Host 'Generating a catalog from the signed package contents...'
Invoke-NativeCommand -FilePath $inf2Cat -ArgumentList @(
    "/driver:$package", '/os:10_X64', '/verbose'
)

if (-not (Test-Path -LiteralPath $packageCatalog)) {
    $generatedCatalog = Get-ChildItem -LiteralPath $package -Filter '*.cat' | Select-Object -First 1
    if (-not $generatedCatalog) {
        throw 'Inf2Cat did not produce a catalog file.'
    }
    Move-Item -LiteralPath $generatedCatalog.FullName -Destination $packageCatalog -Force
}

Write-Host 'Signing the driver package catalog...'
Invoke-NativeCommand -FilePath $signTool -ArgumentList @(
    'sign', '/v', '/fd', 'SHA256', '/s', 'My', '/sha1', $certificate.Thumbprint, $packageCatalog
)
Copy-Item -LiteralPath $certificateMetadata.PublicCertificate -Destination $packageCertificate -Force

Write-Host 'Verifying Authenticode integrity before machine-wide test trust is installed...'
Invoke-NativeCommand -FilePath $signTool -ArgumentList @('verify', '/pa', '/v', $packageCatalog)
Invoke-NativeCommand -FilePath $signTool -ArgumentList @('verify', '/pa', '/v', '/c', $packageCatalog, $packageDriver)

$manifest = Get-ChildItem -LiteralPath $package -File |
    Where-Object Name -ne 'manifest.json' |
    Sort-Object Name |
    ForEach-Object {
    [ordered]@{
        File = $_.Name
        Bytes = $_.Length
        Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath $packageManifest -Encoding UTF8

Write-Host "Test-signed driver package ready at $package"
Write-Host "Self-contained applications ready at $applicationPackage"
Write-Output $package
