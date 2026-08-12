[CmdletBinding()]
param(
    [switch] $RawInputMonitor
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$root = Get-ProjectRoot
$publishedController = Join-Path (Join-Path (Join-Path (Join-Path $root 'artifacts') 'Application') 'Controller') 'VirtualHidKeyboardRunner.exe'
$publishedMonitor = Join-Path (Join-Path (Join-Path (Join-Path $root 'artifacts') 'Application') 'RawInputMonitor') 'VirtualHidRawInputMonitor.exe'
$builtController = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $root 'Controller') 'bin') 'Release') 'net10.0-windows') 'VirtualHidKeyboardRunner.exe'
$builtMonitor = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $root 'Diagnostics') 'RawInputMonitor') 'bin') 'Release') 'net10.0-windows') 'VirtualHidRawInputMonitor.exe'

$controller = if (Test-Path -LiteralPath $publishedController) { $publishedController } else { $builtController }
$monitor = if (Test-Path -LiteralPath $publishedMonitor) { $publishedMonitor } else { $builtMonitor }

if (-not (Test-Path -LiteralPath $controller)) {
    & (Join-Path $PSScriptRoot 'Build.ps1') -Configuration Release
}

if ($RawInputMonitor) {
    if (-not (Test-Path -LiteralPath $monitor)) {
        throw "The Raw Input monitor executable was not found at $monitor."
    }
    Start-Process -FilePath $monitor -WindowStyle Normal
}

Start-Process -FilePath $controller -Verb RunAs -WindowStyle Normal
