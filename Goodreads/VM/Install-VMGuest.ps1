param(
    [string]$PackagePath = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [switch]$VerifyOnly,
    [switch]$Enable,
    [switch]$ClearPending
)

$ErrorActionPreference = 'Stop'
$computer = Get-CimInstance Win32_ComputerSystem
if ($computer.Manufacturer -ne 'Microsoft Corporation' -or $computer.Model -ne 'Virtual Machine') {
    throw 'This installer changes only the dedicated Hyper-V guest. Do not run it on your physical PC.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run the guest installer as Administrator under the guest account that will run the giveaways.'
}
$root = 'C:\GoodreadsVM'
if ([IO.Path]::GetFullPath($PackagePath).TrimEnd('\') -ne $root) {
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    foreach ($name in @('Goodreads', 'runtime', 'keyfire-config.json', 'daily-settings.template.json')) {
        Copy-Item -LiteralPath (Join-Path $PackagePath $name) -Destination $root -Recurse -Force
    }
}
$python = Join-Path $root 'runtime\python.exe'
$pythonw = Join-Path $root 'runtime\pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonw)) { throw 'The guest package is missing its Python runtime.' }
$output = Join-Path $root 'output'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$outputAcl = Get-Acl -LiteralPath $output
$outputAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $output -AclObject $outputAcl
$companionRoot = Join-Path $env:LOCALAPPDATA 'GoodreadsKeyfireCompanion'
New-Item -ItemType Directory -Path $companionRoot -Force | Out-Null
if ((Get-Item -LiteralPath $companionRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The guest companion folder must not be a link.' }
$companionAcl = [Security.AccessControl.DirectorySecurity]::new()
$companionAcl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $companionAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $companionRoot -AclObject $companionAcl
$pairingPath = Join-Path $companionRoot 'pairing-key.txt'
if (Test-Path -LiteralPath $pairingPath) {
    if ((Get-Item -LiteralPath $pairingPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The guest helper key must not be a link.' }
    if (([IO.File]::ReadAllText($pairingPath)).Trim() -notmatch '^[a-f0-9]{64}$') { throw 'The existing guest helper key is invalid.' }
} else {
    $randomBytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
    $pairingKey = [BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
    [IO.File]::WriteAllText($pairingPath, $pairingKey, [Text.UTF8Encoding]::new($false))
    $pairingKey = $null
}
$template = Get-Content -LiteralPath (Join-Path $root 'daily-settings.template.json') -Raw | ConvertFrom-Json
$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path -LiteralPath $edge)) { $edge = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }
$template | Add-Member -Force NoteProperty edgePath $edge
$template | Add-Member -Force NoteProperty userDataDirectory (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')
$localState = Get-Content -LiteralPath (Join-Path $template.userDataDirectory 'Local State') -Raw | ConvertFrom-Json
foreach ($profile in $template.profiles) {
    # Guest profile directories need not have the same numbers as on the host.
    $matches = @($localState.profile.info_cache.PSObject.Properties | Where-Object {
        $_.Value.name -eq $profile.name -and $_.Name -match '^(Default|Profile \d+)$' -and
        (Test-Path -LiteralPath (Join-Path $template.userDataDirectory $_.Name) -PathType Container)
    })
    if ($matches.Count -ne 1) { throw "Name exactly one guest Edge profile '$($profile.name)' before installing the workflow." }
    $profile.directory = $matches[0].Name
}
$template | Add-Member -Force NoteProperty keyfireConfig (Join-Path $root 'keyfire-config.json')
$template | Add-Member -Force NoteProperty closeCompletedListings $true
$dailySettings = Join-Path $output 'daily-settings.json'
[IO.File]::WriteAllText($dailySettings, ($template | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$dailyRunner = Join-Path $root 'Goodreads\DailyGiveaways.py'
& $python $dailyRunner --config $dailySettings --check
if ($LASTEXITCODE -ne 0) { throw 'Finish the Edge profiles and macro setup in this guest before installing the logon workflow.' }
if ($ClearPending) {
    & $python $dailyRunner --config $dailySettings --clear-pending
    if ($LASTEXITCODE -ne 0) { throw 'Could not clear the unfinished-work marker; check for a running queue.' }
}
$wrapper = Join-Path $root 'Goodreads\VM\GuestWorkflow.py'
$guestSettings = Join-Path $root 'guest-settings.json'
$settings = @{ enabled = $false; dailyRunner = $dailyRunner; dailySettings = $dailySettings; shutdownAfterSuccess = $true }
if ($Enable) {
    $verificationPath = Join-Path $output 'daily-verification.json'
    $verification = Get-Content -LiteralPath $verificationPath -Raw | ConvertFrom-Json
    if (-not $verification.endedAt -or -not $verification.verificationOnly -or
        @($verification.profiles).Count -ne @($template.profiles).Count -or
        @($verification.profiles | Where-Object { $_.state -ne 'verified' -or $_.listingClosed -ne $true }).Count -gt 0 -or
        [DateTimeOffset]::Parse($verification.endedAt) -lt [DateTimeOffset]::Now.AddDays(-1)) {
        throw 'Verify every guest profile successfully before enabling the guest workflow.'
    }
    $autoLogon = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    if ($autoLogon.AutoAdminLogon -ne '1' -or $autoLogon.DefaultUserName -ne $env:USERNAME) {
        throw 'Configure Sysinternals Autologon for this guest account, then rerun with -Enable.'
    }
    $settings.enabled = $true
}
[IO.File]::WriteAllText($guestSettings, ($settings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$taskName = 'Goodreads VM workflow'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and @($existing.Actions | Where-Object { $_.Arguments -like ('*' + $wrapper + '*') }).Count -ne 1) {
    throw 'An unrelated task already uses this name. It was not changed.'
}
$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"' + $wrapper + '" --settings "' + $guestSettings + '"') -WorkingDirectory $root
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$logonTrigger.Delay = 'PT45S'
if ($Enable) { Set-TimeZone -Id 'Eastern Standard Time'; [TimeZoneInfo]::ClearCachedData() }
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $logonTrigger -Principal $principal -Settings $taskSettings -Description 'After the scheduled VM boot and automatic sign-in, run the morning giveaway queue once, close its windows, and shut down this VM after success.' -Force | Out-Null
Disable-ScheduledTask -TaskName $taskName | Out-Null
if ($Enable) {
    # Apply power and idle settings only inside the guest, never on the host.
    & powercfg.exe /change standby-timeout-ac 0
    if ($LASTEXITCODE -ne 0) { throw 'Could not set the guest sleep timeout.' }
    & powercfg.exe /change hibernate-timeout-ac 0
    if ($LASTEXITCODE -ne 0) { throw 'Could not set the guest hibernation timeout.' }
    Set-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive -Value '0'
    Enable-ScheduledTask -TaskName $taskName | Out-Null
}
if ($VerifyOnly) {
    & $python $wrapper --settings $guestSettings --verify-only --keep-running
    if ($LASTEXITCODE -ne 0) { throw 'Guest verification failed. The guest will stay running for inspection.' }
}
Write-Output "Guest workflow installed. Enabled: $Enable. Install Giveaways.js and sign into Goodreads in every Edge profile."
