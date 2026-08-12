[CmdletBinding()]
param(
    [string] $Subject = 'CN=Virtual HID Keyboard Test',
    [ValidateRange(1, 10)]
    [int] $ValidYears = 3,
    [switch] $CreateNew
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-ProjectRoot
$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null

$certificate = $null
if (-not $CreateNew) {
    $certificate = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
        Where-Object {
            $_.Subject -eq $Subject -and
            $_.HasPrivateKey -and
            $_.NotAfter -gt (Get-Date).AddDays(30)
        } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
}

if (-not $certificate) {
    Write-Host "Creating test code-signing certificate: $Subject"
    $certificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $Subject `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -HashAlgorithm 'SHA256' `
        -KeyAlgorithm 'RSA' `
        -KeyLength 3072 `
        -KeyExportPolicy NonExportable `
        -NotAfter (Get-Date).AddYears($ValidYears)
} else {
    Write-Host "Reusing test certificate $($certificate.Thumbprint)."
}

$certificatePath = Join-Path $artifacts 'VirtualHidKeyboardTest.cer'
Export-Certificate -Cert $certificate -FilePath $certificatePath -Force | Out-Null

foreach ($storePath in @('Cert:\CurrentUser\Root', 'Cert:\CurrentUser\TrustedPublisher')) {
    if (-not (Test-Path -LiteralPath (Join-Path $storePath $certificate.Thumbprint))) {
        Import-Certificate -FilePath $certificatePath -CertStoreLocation $storePath | Out-Null
    }
}

$metadata = [ordered]@{
    Subject = $certificate.Subject
    Thumbprint = $certificate.Thumbprint
    NotBefore = $certificate.NotBefore.ToUniversalTime().ToString('o')
    NotAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
    PublicCertificate = $certificatePath
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Get-TestCertificateMetadataPath) -Encoding UTF8

Write-Host "Test certificate ready: $($certificate.Thumbprint)"
Write-Output $certificate

