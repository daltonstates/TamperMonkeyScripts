param(
    [string]$At = '04:00',
    [int]$SpacingMinutes = 30,
    [ValidateRange(0, 15)]
    [int]$StartJitterMinutes = 5,
    [string[]]$ProfileNames = @('Dalton', 'Profile 2', 'Profile 3'),
    [string[]]$ProfileDirectories = @('Default', 'Profile 2', 'Profile 3'),
    [string]$MacroName = 'Goodreads Giveaway - no refresh',
    [string]$MacroProfile = '',
    [switch]$CheckOnly,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
if ($ProfileNames.Count -ne $ProfileDirectories.Count -or $SpacingMinutes -lt 1) {
    throw 'Provide matching profile names and directories, with positive spacing.'
}
$parsedTime = [datetime]::ParseExact($At, 'HH:mm', [cultureinfo]::InvariantCulture)
$pythonPath = (& python -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Python 3 is required.' }
$pythonwPath = Join-Path (Split-Path -Parent $pythonPath) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonwPath)) { throw 'pythonw.exe is required to run without a console.' }
$edgePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path -LiteralPath $edgePath)) {
    $edgePath = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'
}
$outputPath = Join-Path $env:LOCALAPPDATA 'GoodreadsKeyfireCompanion'
$settingsPath = Join-Path $outputPath 'daily-settings.json'
$runnerPath = Join-Path $PSScriptRoot 'DailyGiveaways.py'
$profiles = @(for ($i = 0; $i -lt $ProfileNames.Count; $i++) {
    @{ name = $ProfileNames[$i]; directory = $ProfileDirectories[$i]; offsetMinutes = $i * $SpacingMinutes }
})
$settings = @{
    startAt = $At
    startJitterMinutes = $StartJitterMinutes
    closeCompletedListings = $true
    edgePath = $edgePath
    userDataDirectory = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
    keyfireConfig = Join-Path $env:APPDATA 'com.nodescaffold.trigr\keyforge-config.json'
    macroName = $MacroName
    macroProfile = $MacroProfile
    profiles = $profiles
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
if ((Get-TimeZone).Id -ne 'Eastern Standard Time') {
    throw 'This schedule is for Eastern Time. The Windows time zone differs; no task was installed.'
}
# Validate a candidate before replacing saved settings or registering a task.
$candidatePath = Join-Path $outputPath 'daily-settings.candidate.json'
try {
    [IO.File]::WriteAllText($candidatePath, ($settings | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
    & $pythonPath $runnerPath --config $candidatePath --check
    if ($LASTEXITCODE -ne 0) { throw 'Daily setup validation failed; no task was installed.' }
    if ($CheckOnly) { return }
    [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
} finally {
    if (Test-Path -LiteralPath $candidatePath) { Remove-Item -LiteralPath $candidatePath }
}

if ($VerifyOnly) {
    & $pythonPath $runnerPath --config $settingsPath --verify-only
    exit $LASTEXITCODE
}

$taskName = 'Goodreads daily profiles'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and @($existing.Actions | Where-Object { $_.Arguments -like '*DailyGiveaways.py*' }).Count -eq 0) {
    throw 'An unrelated task already uses this name. It was not changed.'
}
$action = New-ScheduledTaskAction -Execute $pythonwPath -Argument ('"' + $runnerPath + '" --config "' + $settingsPath + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $parsedTime
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
$scheduleText = (@(for ($i = 0; $i -lt $ProfileNames.Count; $i++) {
    $ProfileNames[$i] + ' ' + $parsedTime.AddMinutes($i * $SpacingMinutes).ToString('HH:mm')
}) -join ', ')
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Description ("Goodreads daily: $scheduleText Eastern, each delayed randomly by 0-$StartJitterMinutes minutes. Wait for each account and stop on failure.") -Force | Out-Null
Write-Output "Installed: $taskName. Windows must remain signed in and unlocked."
Write-Output "Settings: $settingsPath"
Write-Output "Results: $(Join-Path $outputPath 'daily-last-run.json')"
Write-Output 'Install the updated Giveaways.js in each Edge profile before the first run.'
