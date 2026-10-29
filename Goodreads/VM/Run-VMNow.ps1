param(
    [Parameter(Mandatory=$true)][string]$StateDirectory,
    [string]$GuestUserName='Auto_Station\dstates',
    [string]$SettingsPath="$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json",
    [ValidateRange(10,60)][int]$MaximumMinutes=20,
    [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
$settings=Read-VMSettings $SettingsPath
$guestSource=Join-Path $PSScriptRoot 'GuestWorkflow.py'
if(-not(Test-Path -LiteralPath $guestSource -PathType Leaf)){throw 'The manual guest workflow source is missing.'}
if((Get-Content -LiteralPath $guestSource -Raw) -notlike '*--run-now*'){throw 'The guest workflow does not support explicit manual runs.'}
if($CheckOnly){'Manual runner source, installed settings, and guest entry point resolve correctly.';exit 0}
Assert-VMAdministrator
Import-Module Hyper-V -ErrorAction Stop
New-Item -ItemType Directory -Path $StateDirectory -Force|Out-Null
$statusPath=Join-Path $StateDirectory 'run-status.json'
$status=[ordered]@{state='waiting-for-guest-password';startedAt=[DateTimeOffset]::Now.ToString('o')}
$report=[ordered]@{startedAt=$status.startedAt;state='starting';vmName=$settings.vmName;manualRun=$true}
$reportPath=Join-Path $settings.reportDirectory 'host-last-run.json'
$credential=$session=$null
$startedVM=$powerSet=$false
function Save-ManualStatus{Write-VMJson $statusPath $status}
try{
    $vm=Get-OwnedGiveawaysVM $settings
    if([string]$vm.State -ne 'Off'){throw 'The VM must be powered off before this explicit manual run. Existing work was left alone.'}
    $task=Get-ScheduledTask -TaskName 'Goodreads giveaway VM'
    if([string]$task.State -ne 'Ready'){throw 'The normal host task is not ready. It was not changed.'}
    $status.normalNextRun=(Get-ScheduledTaskInfo -TaskName $task.TaskName).NextRunTime.ToString('o')
    Save-ManualStatus
    Write-Host 'Enter the VM Windows password. It stays in memory and is cleared when this run ends.'
    $secret=Read-Host "Password for $GuestUserName" -AsSecureString
    $credential=[pscredential]::new($GuestUserName,$secret);$secret=$null
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GoodreadsManualPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
    if([GoodreadsManualPower]::SetThreadExecutionState([uint32]2147483649) -eq 0){throw 'Could not keep the host awake during the run.'}
    $powerSet=$true
    $report.startedAt=[DateTimeOffset]::Now.ToString('o')
    Write-VMJson $reportPath $report
    $status.state='starting-vm';Save-ManualStatus
    Start-VM -VM $vm|Out-Null
    $startedVM=$true
    $deadline=[DateTimeOffset]::Now.AddMinutes(3)
    do{
        try{$session=New-PSSession -VMId ([guid]$settings.vmId) -Credential $credential -ErrorAction Stop;break}
        catch{if([DateTimeOffset]::Now -gt $deadline){throw};Start-Sleep -Seconds 3}
    }while($true)
    $status.state='checking-guest';Save-ManualStatus
    $status.guest=Invoke-Command -Session $session -ScriptBlock{
        $ErrorActionPreference='Stop'
        $computer=Get-CimInstance Win32_ComputerSystem
        if($computer.Manufacturer -ne 'Microsoft Corporation' -or $computer.Model -ne 'Virtual Machine'){throw 'Dedicated Hyper-V guest only.'}
        $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
        $deadline=[DateTimeOffset]::Now.AddMinutes(2)
        do{
            $active=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -match '(DailyGiveaways\.py|GuestWorkflow\.py)'})
            $signedIn=(Get-CimInstance Win32_ComputerSystem).UserName -eq $identity
            if($signedIn -and -not $active.Count){break}
            if([DateTimeOffset]::Now -gt $deadline){throw 'The guest has not reached an idle signed-in desktop.'}
            Start-Sleep -Seconds 2
        }while($true)
        if(Test-Path -LiteralPath 'C:\GoodreadsVM\output\daily-incomplete.json'){throw 'Unfinished guest work must be inspected before repeating it.'}
        $guest=Get-Content -LiteralPath 'C:\GoodreadsVM\guest-settings.json' -Raw|ConvertFrom-Json
        if($guest.enabled -ne $true -or $guest.shutdownAfterSuccess -ne $true -or $guest.recoverFailedProfiles -ne $true){throw 'Guest completion and shutdown settings are not ready.'}
        [pscustomobject]@{computer=$env:COMPUTERNAME;dailyHash=(Get-FileHash -LiteralPath $guest.dailySettings).Hash;settingsHash=(Get-FileHash -LiteralPath 'C:\GoodreadsVM\guest-settings.json').Hash;normalTask=[string](Get-ScheduledTask -TaskName 'Goodreads VM workflow').State}
    }
    if($status.guest.normalTask -ne 'Ready'){throw 'The normal guest schedule is not ready.'}
    Copy-Item -ToSession $session -LiteralPath $guestSource -Destination 'C:\GoodreadsVM\Goodreads\VM\GuestWorkflow.py' -Force
    Invoke-Command -Session $session -ScriptBlock{
        $ErrorActionPreference='Stop'
        $taskName='Goodreads manual run'
        $existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if($existing -and (@($existing.Actions).Count -ne 1 -or $existing.Actions.Arguments -notlike '*C:\GoodreadsVM\Goodreads\VM\GuestWorkflow.py*--run-now*')){throw 'An unrelated task already uses the manual-run name.'}
        $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        $action=New-ScheduledTaskAction -Execute 'C:\GoodreadsVM\runtime\pythonw.exe' -Argument '"C:\GoodreadsVM\Goodreads\VM\GuestWorkflow.py" --settings "C:\GoodreadsVM\guest-settings.json" --run-now' -WorkingDirectory 'C:\GoodreadsVM'
        Register-ScheduledTask -TaskName $taskName -Principal $principal -Action $action -Settings (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 65)) -Description 'Explicit one-time giveaway run. No automatic triggers.' -Force|Out-Null
        Start-ScheduledTask -TaskName $taskName
    }
    $status.state='running';$report.state='running';Write-VMJson $reportPath $report;Save-ManualStatus
    $deadline=[DateTimeOffset]::Now.AddMinutes($MaximumMinutes)
    do{
        Start-Sleep -Seconds 10
        $vm=Get-OwnedGiveawaysVM $settings
        if([string]$vm.State -eq 'Off'){break}
        if([DateTimeOffset]::Now -ge $deadline){
            if([string]$vm.State -eq 'Running'){Save-GiveawaysFailure $settings}
            $report.state='timed-out-saved'
            throw 'The manual run exceeded its limit. Its VM state and failure reports were preserved.'
        }
        try{
            $progress=Invoke-Command -Session $session -ScriptBlock{
                $file='C:\GoodreadsVM\output\daily-last-run.json'
                if(Test-Path -LiteralPath $file){Get-Content -LiteralPath $file -Raw|ConvertFrom-Json}
            }
            if($progress.startedAt -and [DateTimeOffset]::Parse($progress.startedAt) -ge [DateTimeOffset]::Parse($report.startedAt).AddSeconds(-5)){
                $status.profiles=@($progress.profiles|Select-Object name,state,progress,reason,listingClosed)
                Save-ManualStatus
            }
        }catch{
            # PowerShell Direct disconnects during the expected guest shutdown.
            if([string](Get-OwnedGiveawaysVM $settings).State -eq 'Running'){throw}
        }
    }while($true)
    $guestReport=Export-VMGuestReports $settings
    if($guestReport.manualRun -ne $true -or $guestReport.state -notin @('finished','failed-cleaned') -or -not $guestReport.endedAt -or [DateTimeOffset]::Parse($guestReport.startedAt) -lt [DateTimeOffset]::Parse($report.startedAt).AddSeconds(-5)){throw 'A fresh manual completion report was not exported.'}
    $report.guestState=$guestReport.state
    $report.state=if($guestReport.state -eq 'finished'){'completed'}else{'completed-with-failures'}
    if($guestReport.state -eq 'failed-cleaned'){$report.reason='Some accounts failed; their windows closed and the VM shut down. See the account report.'}
    $report.note='Explicit manual run. Processed queue counts do not independently confirm individual Goodreads entry acceptance.'
    $status.profiles=@((Get-Content -LiteralPath (Join-Path $settings.reportDirectory 'daily-last-run.json') -Raw|ConvertFrom-Json).profiles|Select-Object name,state,progress,reason,listingClosed)
    $status.hostTask=[string](Get-ScheduledTask -TaskName 'Goodreads giveaway VM').State
    $status.nextRun=(Get-ScheduledTaskInfo -TaskName 'Goodreads giveaway VM').NextRunTime.ToString('o')
    if($status.hostTask -ne 'Ready' -or $status.nextRun -ne $status.normalNextRun){throw 'The normal host schedule is not ready or its next run changed.'}
    $status.vmState=[string](Get-OwnedGiveawaysVM $settings).State
    $status.state=$report.state
}catch{
    $status.state='failed';$status.error=$_.Exception.Message
    if($report.state -ne 'timed-out-saved'){$report.state='failed'}
    $report.reason=$_.Exception.Message
    if($startedVM -and $report.state -ne 'timed-out-saved'){
        try{if([string](Get-OwnedGiveawaysVM $settings).State -eq 'Running'){Save-GiveawaysFailure $settings}}catch{$report.preservationError=$_.Exception.Message}
    }
}finally{
    if($session){Remove-PSSession $session -ErrorAction SilentlyContinue}
    $credential=$null
    if($powerSet){[void][GoodreadsManualPower]::SetThreadExecutionState([uint32]2147483648)}
    $report.endedAt=[DateTimeOffset]::Now.ToString('o')
    if($startedVM){
        Write-VMJson $reportPath $report
        $history=Join-Path $settings.reportDirectory 'history'
        New-Item -ItemType Directory -Path $history -Force|Out-Null
        Write-VMJson (Join-Path $history (([DateTimeOffset]::Parse($report.startedAt).ToString('yyyyMMdd-HHmmss-fffffff'))+'.json')) $report
    }
    $status.closedAt=$report.endedAt
    Save-ManualStatus
}
if($report.state -ne 'completed'){exit 1}
