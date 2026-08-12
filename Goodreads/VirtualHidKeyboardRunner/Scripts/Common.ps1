Set-StrictMode -Version Latest

function Get-ProjectRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}

function Get-MSBuildPath {
    $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw 'Visual Studio Installer vswhere.exe was not found.'
    }

    $installationPath = @(& $vswhere -latest -products * -requires Component.Microsoft.Windows.DriverKit -property installationPath)[0]
    if (-not $installationPath) {
        throw 'A Visual Studio installation with Windows Driver Kit integration was not found.'
    }

    $msbuild = Join-Path $installationPath 'MSBuild\Current\Bin\amd64\MSBuild.exe'
    if (-not (Test-Path -LiteralPath $msbuild)) {
        throw "The 64-bit MSBuild executable was not found at $msbuild."
    }

    return $msbuild
}

function Get-WindowsKitTool {
    param(
        [Parameter(Mandatory)]
        [string] $RelativePath
    )

    $kitsRoot = 'C:\Program Files (x86)\Windows Kits\10'
    $tool = Join-Path $kitsRoot $RelativePath
    if (-not (Test-Path -LiteralPath $tool)) {
        throw "The required Windows Kit tool was not found at $tool."
    }

    return $tool
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)]
        [string] $FilePath,

        [Parameter()]
        [string[]] $ArgumentList = @()
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE."
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-TestCertificateMetadataPath {
    $root = Get-ProjectRoot
    return Join-Path (Join-Path $root 'artifacts') 'TestCertificate.json'
}

function Get-TestPackagePath {
    $root = Get-ProjectRoot
    return Join-Path (Join-Path $root 'artifacts') 'TestDriverPackage'
}

