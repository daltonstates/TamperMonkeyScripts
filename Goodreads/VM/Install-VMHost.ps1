param(
    [Parameter(Mandatory = $true)][string]$SettingsPath,
    [switch]$Enable
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
Assert-VMAdministrator
$settings = Read-VMSettings $SettingsPath
if ((Get-TimeZone).Id -ne 'Eastern Standard Time') { throw 'The VM schedule requires the Eastern Windows time zone.' }
$operator = [Security.Principal.WindowsIdentity]::GetCurrent().User
Protect-VMStorage $settings.storageRoot $operator
$runtime = Join-Path $env:ProgramData 'GoodreadsGiveawaysVM'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
# SYSTEM executes these files, so ordinary users must not be able to replace them.
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach ($sidText in @('S-1-5-18', 'S-1-5-32-544')) {
    $sid = [Security.Principal.SecurityIdentifier]::new($sidText)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($operator, 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $runtime -AclObject $acl
foreach ($name in @('VM.Common.ps1', 'VM.Transport.ps1', 'Invoke-VMWorkflow.ps1', 'New-GiveawaysVM.ps1', 'Read-GuestReports.py', 'Run-VMNow.ps1')) {
    $source = Join-Path $PSScriptRoot $name
    $target = Join-Path $runtime $name
    if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($target)) { Copy-Item -LiteralPath $source -Destination $target -Force }
}
$settings.reportDirectory = Join-Path $runtime 'reports'
$installedSettings = Join-Path $runtime 'vm-settings.json'
if ((Test-Path -LiteralPath $installedSettings) -and [IO.Path]::GetFullPath($installedSettings) -ne [IO.Path]::GetFullPath($SettingsPath)) {
    $previousSettings = Read-VMSettings $installedSettings
    if ($previousSettings.vmId) { throw 'An existing VM installation has an identity. Use its installed settings to update it.' }
}
Write-VMJson $installedSettings $settings
$taskName = 'Goodreads giveaway VM'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$runner = Join-Path $runtime 'Invoke-VMWorkflow.ps1'
if ($existing -and @($existing.Actions | Where-Object { $_.Arguments -like ('*' + $runner + '*') }).Count -ne 1) {
    throw 'An unrelated scheduled task already uses this name. It was not changed.'
}
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"') -WorkingDirectory $runtime
$startAt = [DateTime]::ParseExact($settings.hostStartAt, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$trigger = New-ScheduledTaskTrigger -Daily -At $startAt
# A fixed offset makes 03:55 EDT become 02:55 EST after the autumn change.
# With no offset, Task Scheduler uses the host's Eastern time and DST rules.
# https://learn.microsoft.com/windows/win32/api/taskschd/nf-taskschd-itrigger-put_startboundary
$trigger.StartBoundary = $startAt.ToString("yyyy-MM-dd'T'HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Description 'Request the Goodreads queue at 04:00 Eastern, including an already-running VM. Export reports live and shut down only after report delivery and designated-job checks.' -Force | Out-Null
if (-not $Enable -and (-not $existing -or [string]$existing.State -eq 'Disabled')) { Disable-ScheduledTask -TaskName $taskName | Out-Null }
if ($Enable) {
    $oldTask = Get-ScheduledTask -TaskName 'Goodreads daily profiles' -ErrorAction SilentlyContinue
    if ($oldTask) {
        if ([string]$oldTask.State -eq 'Running') { throw 'Wait for the existing host giveaway run to finish before switching schedules.' }
        if (@($oldTask.Actions | Where-Object { $_.Arguments -like '*DailyGiveaways.py*' }).Count -ne 1) { throw 'The old task has an unexpected action; it was not changed.' }
        Disable-ScheduledTask -TaskName $oldTask.TaskName | Out-Null
    }
    Enable-ScheduledTask -TaskName $taskName | Out-Null
}
$state = (Get-ScheduledTask -TaskName $taskName).State
Write-Output "Installed $taskName at $($settings.hostStartAt) Eastern as SYSTEM. State: $state."
Write-Output "Settings: $installedSettings"
