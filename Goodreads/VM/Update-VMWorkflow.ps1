param(
    [Parameter(Mandatory=$true)][string]$GuestUserName,
    [Parameter(Mandatory=$true)][string]$PythonRuntimePath,
    [Parameter(Mandatory=$true)][string]$ReportPackagesPath,
    [Parameter(Mandatory=$true)][string]$StateDirectory,
    [string]$SettingsPath = "$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json"
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
Assert-VMAdministrator
$source = Split-Path -Parent $PSScriptRoot
$settings = Read-VMSettings $SettingsPath
$statusPath = Join-Path $StateDirectory 'update-status.json'
$commandPath = Join-Path $StateDirectory 'update-command.json'
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
$status = [ordered]@{startedAt=[DateTimeOffset]::Now.ToString('o');state='waiting-for-guest-password'}
$session = $credential = $null
$verified = $false
function Save-UpdateStatus { Write-VMJson $statusPath $status }
function Connect-UpdateGuest {
    $deadline = [DateTimeOffset]::Now.AddMinutes(3)
    do {
        try { return New-PSSession -VMId ([guid]$settings.vmId) -Credential $credential -ErrorAction Stop }
        catch { if ([DateTimeOffset]::Now -gt $deadline) { throw }; Start-Sleep -Seconds 3 }
    } while ($true)
}
function Copy-UpdateSources {
    foreach ($name in @('DailyGiveaways.py','KeyfireGiveaways.py','Giveaways.js')) {
        Copy-Item -ToSession $session -LiteralPath (Join-Path $source $name) -Destination (Join-Path 'C:\GoodreadsVM\Goodreads' $name) -Force
    }
    Copy-Item -ToSession $session -LiteralPath (Join-Path $PSScriptRoot 'GuestWorkflow.py') -Destination 'C:\GoodreadsVM\Goodreads\VM\GuestWorkflow.py' -Force
}
function Invoke-UpdateInteractive([string]$Mode) {
    Invoke-Command -Session $session -ArgumentList $Mode -ScriptBlock {
        param($Mode)
        $ErrorActionPreference='Stop'
        $root='C:\GoodreadsVM'
        $output=Join-Path $root 'output'
        if ((Get-CimInstance Win32_ComputerSystem).Model -ne 'Virtual Machine') { throw 'Guest only.' }
        if (@(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -match '(DailyGiveaways\.py|GuestWorkflow\.py)'}).Count) { throw 'Wait for the active queue to finish.' }
        $body = @'
param($Mode)
$ErrorActionPreference='Stop'
$root='C:\GoodreadsVM'
$output=Join-Path $root 'output'
try {
    $daily=Get-Content -LiteralPath (Join-Path $output 'daily-settings.json') -Raw|ConvertFrom-Json
    $expected=[IO.Path]::GetFullPath($daily.edgePath)
    $browsers=@(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $expected -and $_.MainWindowHandle -ne 0})
    foreach($browser in $browsers){if(-not $browser.CloseMainWindow()){throw 'The VM browser refused to close.'}}
    $deadline=[DateTimeOffset]::Now.AddSeconds(25)
    do {
        $open=@(Get-Process msedge -ErrorAction SilentlyContinue|Where-Object{$_.Path -eq $expected -and $_.MainWindowHandle -ne 0})
        if(-not $open.Count){break}
        if([DateTimeOffset]::Now -gt $deadline){throw 'Close the remaining VM browser prompt before continuing.'}
        Start-Sleep -Milliseconds 250
    }while($true)
    $archive=Join-Path $output ('history\maintenance-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $archive -Force|Out-Null
    foreach($name in @('daily-incomplete.json','daily-last-run.json','vm-last-run.json')){
        $path=Join-Path $output $name
        if(Test-Path -LiteralPath $path){Copy-Item -LiteralPath $path -Destination (Join-Path $archive $name)}
    }
    & (Join-Path $root 'runtime\python.exe') (Join-Path $root 'Goodreads\DailyGiveaways.py') --config (Join-Path $output 'daily-settings.json') --clear-pending
    if($LASTEXITCODE -ne 0){throw 'The daily runner is busy.'}
    if($Mode -eq 'verify'){
        & (Join-Path $root 'runtime\python.exe') (Join-Path $root 'Goodreads\VM\GuestWorkflow.py') --settings (Join-Path $root 'guest-settings.json') --verify-only --keep-running
        if($LASTEXITCODE -ne 0){throw 'Update Giveaways.js in every profile, then repeat verification.'}
    }else{
        foreach($profile in $daily.profiles){
            $extensionRoot=Join-Path (Join-Path $daily.userDataDirectory $profile.directory) 'Extensions'
            $ids=@('iikmkjmpaadaobahmlepeloendndfphd','dhdgffkkebhmkfjojejmpbldmpobfkfo'|Where-Object{Test-Path -LiteralPath (Join-Path $extensionRoot $_)})
            if($ids.Count -ne 1){throw 'Expected one Tampermonkey installation per profile.'}
            Start-Process -FilePath $daily.edgePath -ArgumentList @('--profile-directory="'+$profile.directory+'"','--new-window',('chrome-extension://'+$ids[0]+'/options.html#nav=dashboard'))
        }
    }
    @{state='complete';mode=$Mode;at=[DateTimeOffset]::Now.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $output 'update-interactive.json') -Encoding UTF8
}catch{
    @{state='failed';mode=$Mode;error=$_.Exception.Message}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $output 'update-interactive.json') -Encoding UTF8
    exit 1
}
'@
        $scriptPath=Join-Path $output 'Update-Interactive.ps1'
        [IO.File]::WriteAllText($scriptPath,$body,[Text.UTF8Encoding]::new($false))
        $resultPath=Join-Path $output 'update-interactive.json'
        if(Test-Path -LiteralPath $resultPath){Remove-Item -LiteralPath $resultPath}
        $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
        $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$scriptPath+'" -Mode '+$Mode)
        Register-ScheduledTask -TaskName 'Goodreads workflow maintenance' -Action $action -Principal $principal -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 6)) -Force|Out-Null
        Start-ScheduledTask -TaskName 'Goodreads workflow maintenance'
        $deadline=[DateTimeOffset]::Now.AddMinutes(5)
        do {
            Start-Sleep -Seconds 2
            if(Test-Path -LiteralPath $resultPath){break}
            if([DateTimeOffset]::Now -gt $deadline){throw 'Guest maintenance timed out.'}
        }while($true)
        $result=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json
        if($result.state -ne 'complete'){throw $result.error}
        if($Mode -eq 'verify'){return Get-Content -LiteralPath (Join-Path $output 'daily-verification.json') -Raw|ConvertFrom-Json}
        return $result
    }
}
try {
    Save-UpdateStatus
    Write-Host 'Enter the dedicated VM Windows password. It stays in memory only.'
    $secret = Read-Host "Password for $GuestUserName" -AsSecureString
    $credential = [pscredential]::new($GuestUserName,$secret)
    $secret=$null
    $vm=Get-OwnedGiveawaysVM $settings
    if([string]$vm.State -in @('Saved','Off')){Start-VM -VM $vm}
    elseif([string]$vm.State -ne 'Running'){throw 'The VM must be Off, Saved, or Running.'}
    $session=Connect-UpdateGuest
    $status.state='installing-guest';Save-UpdateStatus
    Invoke-Command -Session $session -ScriptBlock {
        $ErrorActionPreference='Stop'
        Disable-ScheduledTask -TaskName 'Goodreads VM workflow'|Out-Null
        foreach($process in @(Get-CimInstance Win32_Process|Where-Object{$_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -like '*C:\GoodreadsVM\Goodreads\KeyfireGiveaways.py*'})){
            Stop-Process -Id $process.ProcessId -ErrorAction Stop
        }
        $path='C:\GoodreadsVM\guest-settings.json'
        $config=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
        $config|Add-Member -Force NoteProperty recoverFailedProfiles $true
        [IO.File]::WriteAllText($path,($config|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    }
    Copy-UpdateSources
    $status.preparation=Invoke-UpdateInteractive 'prepare'
    $status.state='awaiting-userscript-update';Save-UpdateStatus
    Write-Host 'Guest prepared. Update the userscript in its three Tampermonkey dashboards.'
    $lastCommand=''
    if(Test-Path -LiteralPath $commandPath){$lastCommand=(Get-Content -LiteralPath $commandPath -Raw|ConvertFrom-Json).id}
    $deadline=[DateTimeOffset]::Now.AddHours(1)
    while([DateTimeOffset]::Now -lt $deadline){
        Start-Sleep -Seconds 2
        if(-not (Test-Path -LiteralPath $commandPath)){continue}
        $command=Get-Content -LiteralPath $commandPath -Raw|ConvertFrom-Json
        if(-not $command.id -or $command.id -eq $lastCommand){continue}
        $lastCommand=$command.id
        $status.commandId=$lastCommand
        try {
            if($command.action -eq 'copy'){Copy-UpdateSources;$status.state='awaiting-userscript-update'}
            elseif($command.action -eq 'verify'){
                $status.state='verifying-guest';Save-UpdateStatus
                $status.verification=Invoke-UpdateInteractive 'verify'
                $profiles=@($status.verification.profiles)
                if($profiles.Count -ne 3 -or @($profiles|Where-Object{$_.state -ne 'verified' -or $_.listingClosed -ne $true -or $_.capabilities.addressSubmitRetrySupported -ne $true -or $_.capabilities.failureCleanupSupported -ne $true}).Count){throw 'Every profile must verify the 4.31 protocol.'}
                $verified=$true;$status.state='guest-verified'
            }
            elseif($command.action -eq 'smoke'){
                if(-not $verified){throw 'Verify all guest profiles before the cold boot smoke.'}
                $status.state='staging-cold-boot';Save-UpdateStatus
                $status.normalDailyHash=Invoke-Command -Session $session -ScriptBlock {
                    $ErrorActionPreference='Stop'
                    $output='C:\GoodreadsVM\output'
                    $daily=Get-Content -LiteralPath (Join-Path $output 'daily-settings.json') -Raw|ConvertFrom-Json
                    $hash=(Get-FileHash -LiteralPath (Join-Path $output 'daily-settings.json')).Hash
                    $daily.profiles=@($daily.profiles[0]);$daily.profiles[0].offsetMinutes=0
                    $daily.startAt=Get-Date -Format 'HH:mm';$daily.startJitterMinutes=0
                    [IO.File]::WriteAllText((Join-Path $output 'smoke-daily.json'),($daily|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
                    $driver=@'
import sys
sys.path.insert(0, r'C:\GoodreadsVM\Goodreads')
import DailyGiveaways as daily
class InjectedFailure(daily.Session):
    def event(self, value):
        result = super().event(value)
        if value.get('state') == 'ready' and self.state == 'ready':
            self.state, self.reason = 'failed', 'Injected pre-entry failure for VM recovery validation'
            return {'protocol': 1, 'cancel': True, 'closeRunTabs': True}
        return result
daily.Session = InjectedFailure
raise SystemExit(daily.main())
'@
                    [IO.File]::WriteAllText((Join-Path $output 'Injected-Failure.py'),$driver,[Text.UTF8Encoding]::new($false))
                    $smoke=@{enabled=$true;dailySettings=(Join-Path $output 'smoke-daily.json');dailyRunner=(Join-Path $output 'Injected-Failure.py');shutdownAfterSuccess=$true;recoverFailedProfiles=$true}
                    [IO.File]::WriteAllText((Join-Path $output 'smoke-guest.json'),($smoke|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
                    $once=@'
$ErrorActionPreference='Stop'
Unregister-ScheduledTask -TaskName 'Goodreads recovery smoke' -Confirm:$false
Enable-ScheduledTask -TaskName 'Goodreads VM workflow'|Out-Null
& 'C:\GoodreadsVM\runtime\python.exe' 'C:\GoodreadsVM\Goodreads\VM\GuestWorkflow.py' --settings 'C:\GoodreadsVM\output\smoke-guest.json'
exit $LASTEXITCODE
'@
                    [IO.File]::WriteAllText((Join-Path $output 'Run-RecoverySmoke.ps1'),$once,[Text.UTF8Encoding]::new($false))
                    $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
                    $principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
                    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity;$trigger.Delay='PT45S'
                    $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\GoodreadsVM\output\Run-RecoverySmoke.ps1"'
                    Register-ScheduledTask -TaskName 'Goodreads recovery smoke' -Action $action -Trigger $trigger -Principal $principal -Force|Out-Null
                    return $hash
                }
                Stop-VM -VM (Get-OwnedGiveawaysVM $settings) -Confirm:$false
                Remove-PSSession $session;$session=$null
                $runtime=Split-Path -Parent $SettingsPath
                foreach($directory in @('runtime','packages')){New-Item -ItemType Directory -Path (Join-Path $runtime $directory) -Force|Out-Null}
                Copy-Item -Path (Join-Path $PythonRuntimePath '*') -Destination (Join-Path $runtime 'runtime') -Recurse -Force
                Copy-Item -Path (Join-Path $ReportPackagesPath '*') -Destination (Join-Path $runtime 'packages') -Recurse -Force
                $settings|Add-Member -Force NoteProperty recoverSavedFailures $true
                Write-VMJson $SettingsPath $settings
                & (Join-Path $PSScriptRoot 'Install-VMHost.ps1') -SettingsPath $SettingsPath -Enable
                $smokeSettings=$settings|ConvertTo-Json|ConvertFrom-Json
                $smokeSettings.maximumRuntimeMinutes=10
                $smokePath=Join-Path $runtime 'recovery-smoke-settings.json'
                Write-VMJson $smokePath $smokeSettings
                $status.state='running-cold-boot-smoke';Save-UpdateStatus
                try { & (Join-Path $runtime 'Invoke-VMWorkflow.ps1') -SettingsPath $smokePath }
                catch { $status.smokeTaskError=$_.Exception.Message }
                $status.smoke=Get-Content -LiteralPath (Join-Path $settings.reportDirectory 'host-last-run.json') -Raw|ConvertFrom-Json
                if($status.smoke.state -ne 'completed-with-failures' -or $status.smoke.guestState -ne 'failed-cleaned'){throw 'The injected failure did not cleanly shut down and export reports.'}
                $status.state='checking-normal-schedule';Save-UpdateStatus
                Start-VM -VM (Get-OwnedGiveawaysVM $settings)
                $session=Connect-UpdateGuest
                $status.normal=Invoke-Command -Session $session -ScriptBlock {
                    $config=Get-Content -LiteralPath 'C:\GoodreadsVM\guest-settings.json' -Raw|ConvertFrom-Json
                    [pscustomobject]@{dailyHash=(Get-FileHash -LiteralPath 'C:\GoodreadsVM\output\daily-settings.json').Hash;guestTask=[string](Get-ScheduledTask -TaskName 'Goodreads VM workflow').State;recoveryEnabled=$config.recoverFailedProfiles;pending=(Test-Path -LiteralPath 'C:\GoodreadsVM\output\daily-incomplete.json');smokeTask=(Get-ScheduledTask -TaskName 'Goodreads recovery smoke' -ErrorAction SilentlyContinue).TaskName}
                }
                if($status.normal.dailyHash -ne $status.normalDailyHash -or $status.normal.pending -or $status.normal.smokeTask -or $status.normal.guestTask -eq 'Disabled' -or $status.normal.recoveryEnabled -ne $true){throw 'The normal guest schedule was not restored.'}
                Stop-VM -VM (Get-OwnedGiveawaysVM $settings) -Confirm:$false
                Remove-PSSession $session;$session=$null
                $task=Get-ScheduledTask -TaskName 'Goodreads giveaway VM'
                $info=Get-ScheduledTaskInfo -TaskName $task.TaskName
                $status.hostTask=@{state=[string]$task.State;nextRun=$info.NextRunTime.ToString('o')}
                if([string](Get-OwnedGiveawaysVM $settings).State -ne 'Off' -or [string]$task.State -ne 'Ready'){throw 'The VM and host schedule are not ready.'}
                $status.state='complete';$status.endedAt=[DateTimeOffset]::Now.ToString('o');Save-UpdateStatus
                break
            }elseif($command.action -eq 'abort'){break}
            else{throw 'Unknown update action.'}
            $status.Remove('error')
        }catch{$status.state='command-failed';$status.error=$_.Exception.Message}
        Save-UpdateStatus
    }
}catch{$status.state='failed';$status.error=$_.Exception.Message;Save-UpdateStatus}
finally{
    if($session){Remove-PSSession $session -ErrorAction SilentlyContinue}
    $credential=$null
    $status.closedAt=[DateTimeOffset]::Now.ToString('o');Save-UpdateStatus
}
