[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string] $Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-ProjectRoot
$controllerProject = Join-Path (Join-Path $root 'Controller') 'VirtualHidKeyboardRunner.csproj'
$monitorProject = Join-Path (Join-Path (Join-Path $root 'Diagnostics') 'RawInputMonitor') 'RawInputMonitor.csproj'
$driverProject = Join-Path (Join-Path $root 'Driver') 'VirtualHidKeyboardDriver.vcxproj'
$msbuild = Get-MSBuildPath

Write-Host "Building controller ($Configuration)..."
Invoke-NativeCommand -FilePath 'dotnet.exe' -ArgumentList @(
    'build', $controllerProject, '--configuration', $Configuration, '--nologo'
)

Write-Host "Building Raw Input monitor ($Configuration)..."
Invoke-NativeCommand -FilePath 'dotnet.exe' -ArgumentList @(
    'build', $monitorProject, '--configuration', $Configuration, '--nologo'
)

Write-Host "Building unsigned driver package ($Configuration|x64)..."
Invoke-NativeCommand -FilePath $msbuild -ArgumentList @(
    $driverProject,
    '/t:Rebuild',
    "/p:Configuration=$Configuration",
    '/p:Platform=x64',
    '/p:EnableTestSign=false',
    '/m',
    '/nologo',
    '/verbosity:minimal'
)

Write-Host 'Build completed successfully.'
