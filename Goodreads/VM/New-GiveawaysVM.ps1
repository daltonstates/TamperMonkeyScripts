param(
    [string]$SettingsPath = "$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json",
    [string]$IsoPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
Assert-VMAdministrator
$settings = Read-VMSettings $SettingsPath
Import-Module Hyper-V -ErrorAction Stop
if ((Get-Service vmms).Status -ne 'Running') { throw 'Restart Windows to finish enabling Hyper-V, then rerun this script.' }
if ($IsoPath -and (-not (Test-Path -LiteralPath $IsoPath -PathType Leaf) -or [IO.Path]::GetExtension($IsoPath) -ne '.iso')) {
    throw 'Choose an existing Windows x64 ISO.'
}
if ($settings.vmId) {
    $vm = Get-OwnedGiveawaysVM $settings
    if ([string]$vm.State -ne 'Off') { throw 'Shut down this VM before attaching installation media.' }
} else {
    if (Get-VM -Name $settings.vmName -ErrorAction SilentlyContinue) { throw 'A VM already uses this name. It was not changed.' }
    if (Test-Path -LiteralPath $settings.diskPath) { throw 'A disk already exists at this path. It was not reused or overwritten.' }
    New-Item -ItemType Directory -Path $settings.storageRoot -Force | Out-Null
    # Use Windows NAT without changing the physical network adapters.
    $switch = Get-VMSwitch -Name 'Default Switch' -ErrorAction Stop
    $vm = New-VM -Name $settings.vmName -Generation 2 -MemoryStartupBytes ($settings.memoryGB * 1GB) -Path $settings.storageRoot -NewVHDPath $settings.diskPath -NewVHDSizeBytes ($settings.diskGB * 1GB) -SwitchName $switch.Name
    Set-VM -VM $vm -Notes 'Managed by Goodreads giveaway VM workflow' -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -CheckpointType Disabled
    $settings.vmId = $vm.Id.ToString()
    Write-VMJson $SettingsPath $settings
}
Set-VMProcessor -VM $vm -Count $settings.processors
Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
if (-not (Get-VMSecurity -VM $vm).TpmEnabled) {
    Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
    Enable-VMTPM -VM $vm
}
# The copy service accepts the prepared guest ZIP after Windows is installed.
Enable-VMIntegrationService -VM $vm -Name 'Guest Service Interface'
if ($IsoPath) {
    $dvd = Get-VMDvdDrive -VM $vm
    if ($dvd) { Set-VMDvdDrive -VMDvdDrive $dvd -Path $IsoPath } else { Add-VMDvdDrive -VM $vm -Path $IsoPath }
    Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMDvdDrive -VM $vm)
}
Write-Output "Prepared $($settings.vmName): $($settings.memoryGB) GB RAM, $($settings.processors) CPUs, $($settings.diskGB) GB expanding disk."
Write-Output 'The VM was not started. Install Windows and configure the guest before enabling its schedule.'
