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
$catalog = Join-Path $PackagePath 'VirtualHidKeyboardDriver.cat'
$driver = Join-Path $PackagePath 'VirtualHidKeyboardDriver.sys'

$signTool = Get-WindowsKitTool 'bin\10.0.28000.0\x64\signtool.exe'
Invoke-NativeCommand -FilePath $signTool -ArgumentList @('verify', '/kp', '/v', $catalog)
Invoke-NativeCommand -FilePath $signTool -ArgumentList @('verify', '/kp', '/v', '/c', $catalog, $driver)

$allDevices = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue)
$devices = @($allDevices | Where-Object {
    $_.InstanceId -like 'ROOT\VIRTUALHIDKEYBOARD\*'
})
if ($devices.Count -eq 0) {
    throw 'The ROOT\VirtualHidKeyboard device is not present.'
}

$failedDevice = $devices | Where-Object Status -ne 'OK' | Select-Object -First 1
if ($failedDevice) {
    throw "The virtual keyboard device is present but reports status '$($failedDevice.Status)'."
}

$descendantIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($device in $devices) {
    [void]$descendantIds.Add($device.InstanceId)
}
$descendants = New-Object System.Collections.Generic.List[object]
for ($depth = 0; $depth -lt 5; $depth++) {
    $foundAtDepth = @()
    foreach ($candidate in $allDevices) {
        if ($descendantIds.Contains($candidate.InstanceId)) {
            continue
        }

        $parent = (Get-PnpDeviceProperty `
            -InstanceId $candidate.InstanceId `
            -KeyName 'DEVPKEY_Device_Parent' `
            -ErrorAction SilentlyContinue).Data
        if ($parent -and $descendantIds.Contains([string]$parent)) {
            $foundAtDepth += $candidate
        }
    }

    if ($foundAtDepth.Count -eq 0) {
        break
    }
    foreach ($child in $foundAtDepth) {
        [void]$descendantIds.Add($child.InstanceId)
        $descendants.Add($child)
    }
}

$keyboardChild = $descendants | Where-Object Class -eq 'Keyboard' | Select-Object -First 1
if (-not $keyboardChild) {
    throw 'The root source driver is present, but Windows did not enumerate its virtual HID keyboard child.'
}

if (-not ('VirtualHidKeyboard.ControlProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace VirtualHidKeyboard
{
    public static class ControlProbe
    {
        private const uint GenericWrite = 0x40000000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private const uint IoctlSubmitReport = 0x8337A000;

        public static void SubmitReleaseReport()
        {
            using (SafeFileHandle handle = CreateFile(
                @"\\.\VirtualHidKeyboardControl",
                GenericWrite,
                FileShareRead | FileShareWrite,
                IntPtr.Zero,
                OpenExisting,
                0,
                IntPtr.Zero))
            {
                if (handle.IsInvalid)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                byte[] report = new byte[8];
                uint bytesReturned;
                if (!DeviceIoControl(handle, IoctlSubmitReport, report, (uint)report.Length,
                        IntPtr.Zero, 0, out bytesReturned, IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DeviceIoControl(
            SafeFileHandle device,
            uint ioControlCode,
            byte[] inputBuffer,
            uint inputBufferSize,
            IntPtr outputBuffer,
            uint outputBufferSize,
            out uint bytesReturned,
            IntPtr overlapped);
    }
}
'@
}

[VirtualHidKeyboard.ControlProbe]::SubmitReleaseReport()
Write-Host 'Driver signatures, PnP status, control channel, and all-keys-release report verified successfully.'
$devices | Format-Table Status, Class, FriendlyName, InstanceId -AutoSize
$keyboardChild | Format-Table Status, Class, FriendlyName, InstanceId -AutoSize
