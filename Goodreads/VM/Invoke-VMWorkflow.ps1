param([string]$SettingsPath = "$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json")
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
Assert-VMAdministrator
$settings=Read-VMSettings $SettingsPath
New-Item -ItemType Directory -Path $settings.reportDirectory -Force|Out-Null
$reportPath=Join-Path $settings.reportDirectory 'host-last-run.json'
$report=[ordered]@{startedAt=[DateTimeOffset]::Now.ToString('o');state='starting';vmName=$settings.vmName}
$powerSet=$false
$startedVM=$false
try{
    Import-Module Hyper-V -ErrorAction Stop
    $vm=Get-OwnedGiveawaysVM $settings
    if([string]$vm.State -eq 'Running'){
        $report.state='already-running'
        $report.note='An existing VM session was left alone.'
    }else{
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GoodreadsMorningPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
        if([GoodreadsMorningPower]::SetThreadExecutionState([uint32]2147483649) -eq 0){throw 'Could not keep the host awake during the morning run.'}
        $powerSet=$true
        [void](Start-GiveawaysMorningVM $settings)
        $startedVM=$true
        $report.state='running'
        Write-VMJson $reportPath $report
        $timer=[Diagnostics.Stopwatch]::StartNew()
        do{
            Start-Sleep -Seconds 10
            $vm=Get-OwnedGiveawaysVM $settings
            if([string]$vm.State -eq 'Off'){break}
            if($timer.Elapsed.TotalMinutes -ge $settings.maximumRuntimeMinutes){
                if([string]$vm.State -eq 'Running'){Save-GiveawaysFailure $settings}
                $report.state='timed-out-saved'
                throw 'The morning run exceeded its limit. The VM was saved to release RAM; inspect it before resuming the schedule.'
            }
        }while($true)
        $guestReport=Export-VMGuestReports $settings
        if($guestReport.state -notin @('finished','verified','failed-cleaned') -or -not $guestReport.endedAt -or
           [DateTimeOffset]::Parse($guestReport.startedAt) -lt [DateTimeOffset]::Parse($report.startedAt).AddSeconds(-5)){
            throw 'The VM powered off without a fresh successful workflow report. Its reports were copied for inspection.'
        }
        $report.state='completed'
        $report.guestState=$guestReport.state
        if($guestReport.state -eq 'failed-cleaned'){$report.state='completed-with-failures';$report.reason='An account failed, but its windows were closed and the VM powered off for the next schedule.'}
        $report.note='The guest completed its queue, powered off, and released assigned memory. Finished queue state does not independently prove Goodreads accepted every entry.'
    }
}catch{
    if($report.state -ne 'timed-out-saved'){$report.state='failed'}
    $report.reason=$_.Exception.Message
    if($startedVM -and $report.state -ne 'timed-out-saved'){
        try{$vm=Get-OwnedGiveawaysVM $settings;if([string]$vm.State -eq 'Running'){Save-GiveawaysFailure $settings}}catch{$report.preservationError=$_.Exception.Message}
    }
}finally{
    if($powerSet){[void][GoodreadsMorningPower]::SetThreadExecutionState([uint32]2147483648)}
    $report.endedAt=[DateTimeOffset]::Now.ToString('o')
    Write-VMJson $reportPath $report
    $history=Join-Path $settings.reportDirectory 'history'
    New-Item -ItemType Directory -Path $history -Force|Out-Null
    Write-VMJson (Join-Path $history (([DateTimeOffset]::Parse($report.startedAt).ToString('yyyyMMdd-HHmmss-fffffff'))+'.json')) $report
}
if($report.state -notin @('completed','already-running')){Write-Error $report.reason;exit 1}
Write-Output "Morning VM lifecycle: $($report.state)."
