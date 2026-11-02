param(
    [string]$SettingsPath = "$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json",
    [switch]$Repeat,
    [switch]$VerifyOnly
)
$ErrorActionPreference='Stop'
$reportDirectory=Join-Path $env:ProgramData 'GoodreadsGiveawaysVM\reports'
$report=[ordered]@{runId=[guid]::NewGuid().ToString('N');startedAt=[DateTimeOffset]::Now.ToString('o');state='starting';adapterVersion='2026.11.02.3';shutdownDecision=@{state='deferred';reason='Startup has not established shutdown eligibility.'}}
$powerSet=$false
$mutex=$null
$ownsLock=$false
function Save-HostResult {
    New-Item -ItemType Directory -Path $reportDirectory -Force|Out-Null
    $report.updatedAt=[DateTimeOffset]::Now.ToString('o')
    $target=Join-Path $reportDirectory 'host-last-run.json'
    $temporary=$target+'.tmp'
    [IO.File]::WriteAllText($temporary,($report|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    $deadline=[DateTimeOffset]::Now.AddSeconds(5)
    while($true){
        try{Move-Item -LiteralPath $temporary -Destination $target -Force -ErrorAction Stop;break}
        catch{
            if(($_.Exception.HResult -band 65535) -notin @(5,32,33) -or [DateTimeOffset]::Now -ge $deadline){throw}
            Start-Sleep -Milliseconds 50
        }
    }
}
try {
    . (Join-Path $PSScriptRoot 'VM.Common.ps1')
    . (Join-Path $PSScriptRoot 'VM.Transport.ps1')
    Assert-VMAdministrator
    $settings=Read-VMSettings $SettingsPath
    $reportDirectory=$settings.reportDirectory
    $report.vmName=$settings.vmName
    $mutex=[Threading.Mutex]::new($false,'Global\GoodreadsVMWorkflow')
    try {$ownsLock=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$ownsLock=$true}
    if(-not $ownsLock){throw 'Another host request is active. No second guest queue was launched.'}
    Save-HostResult
    Import-Module Hyper-V -ErrorAction Stop
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class GoodreadsRequestPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
    if([GoodreadsRequestPower]::SetThreadExecutionState([uint32]2147483649) -eq 0){throw 'Could not keep the host awake.'}
    $powerSet=$true
    $report.vmStart=Start-GiveawaysMorningVM $settings
    $request=@{schema=1;runId=$report.runId;requestedAt=$report.startedAt;mode=$(if($VerifyOnly){'verify'}elseif($Repeat){'repeat'}else{'scheduled'})}
    if($settings.requestEntryLimit){$request.entryLimit=$settings.requestEntryLimit;$report.entryLimit=$settings.requestEntryLimit}
    if($settings.requestBatchEntryLimit){$request.batchEntryLimit=$settings.requestBatchEntryLimit;$report.batchEntryLimit=$settings.requestBatchEntryLimit}
    $readyDeadline=[DateTimeOffset]::Now.AddMinutes(3)
    do {
        try {Set-GiveawaysRequest $settings $request;break}
        catch {if([DateTimeOffset]::Now -gt $readyDeadline){throw};Start-Sleep -Seconds 3}
    } while($true)
    $report.state='running'
    Save-HostResult
    $ackDeadline=[DateTimeOffset]::Now.AddMinutes(5)
    $lastTransport=[DateTimeOffset]::Now
    $acknowledged=$false
    $waitingForQueue=$false
    do {
        if([string](Get-OwnedGiveawaysVM $settings).State -ne 'Running'){throw 'The VM stopped before delivering its current final report.'}
        $bundle=Read-GiveawaysLiveReport $settings
        if(Test-GiveawaysOtherActiveQueue $bundle $report.runId){
            # An earlier/manual healthy queue owns the interactive task. Keep
            # this request queued and monitored rather than abandoning it after
            # the startup deadline; the generic runner owns stall detection.
            $waitingForQueue=$true
            $report.waitingForRunId=$bundle.runId
            $report.guestUpdatedAt=$bundle.at
            $stamp=[DateTimeOffset]::Parse($bundle.at)
            if($stamp -gt $lastTransport){$lastTransport=$stamp}
            Export-GiveawaysLiveReport $settings $bundle
            Save-HostResult
        }elseif($waitingForQueue){
            $waitingForQueue=$false
            $ackDeadline=[DateTimeOffset]::Now.AddMinutes(5)
            $report.Remove('waitingForRunId')
        }
        if($bundle -and $bundle.runId -eq $report.runId){
            $acknowledged=$true
            $stamp=[DateTimeOffset]::Parse($bundle.at)
            if($stamp -gt $lastTransport){$lastTransport=$stamp}
            Export-GiveawaysLiveReport $settings $bundle
            $guest=$bundle.files.'vm-last-run.json'
            $report.guestState=$guest.state
            $report.guestUpdatedAt=$bundle.at
            Save-HostResult
            if($guest.endedAt){break}
        }
        if(-not $acknowledged -and -not $waitingForQueue -and [DateTimeOffset]::Now -gt $ackDeadline){throw 'Guest job did not acknowledge this request. Check the enabled interactive guest task, sign-in, and KVP access. The VM was left running.'}
        if(($acknowledged -or $waitingForQueue) -and ([DateTimeOffset]::Now-$lastTransport).TotalMinutes -gt 3){throw 'Guest report monitoring stopped. Elapsed runtime does not prove a website stall; the VM and queue were left running.'}
        if([string](Get-OwnedGiveawaysVM $settings).State -ne 'Running'){throw 'The VM stopped before delivering its current final report.'}
        Start-Sleep -Seconds 10
    } while($true)
    $report.state=switch($guest.state){'finished'{'completed'}'verified'{'completed'}'failed-cleaned'{'completed-with-failures'}'skipped'{'skipped'}default{'failed'}}
    if($guest.reason){$report.reason=$guest.reason}
    $hostEligibility=Get-GiveawaysHostShutdownEligibility $settings
    $eligible=($guest.queueClosed -eq $true -and $bundle.shutdown.eligible -eq $true -and $hostEligibility.eligible -eq $true)
    if($eligible){$report.shutdownDecision=@{state='eligible';reason='The queue is closed and all designated host and guest jobs are idle.'}}
    else{$report.shutdownDecision=@{state='deferred';reason=(@($guest.shutdown.reason,$bundle.shutdown.reason,$hostEligibility.reason)|Where-Object{$_}|Select-Object -Unique) -join ' '}}
    $report.endedAt=[DateTimeOffset]::Now.ToString('o')
    Save-HostResult # Deliver before requesting any shutdown, including a VM that stays on.
    if($eligible){
        # Give the existing signed-in desktop watcher a bounded chance to publish
        # the current HTML/notification. A missing desktop defers shutdown safely.
        $delivered=$false
        $deliveryDeadline=[DateTimeOffset]::Now.AddSeconds(45)
        if($settings.desktopStatusDirectory){
            do{
                try{
                    $desktop=Get-Content -LiteralPath (Join-Path $settings.desktopStatusDirectory 'latest-report.json') -Raw|ConvertFrom-Json
                    if($desktop.requestId -eq $report.runId -and (Test-Path -LiteralPath (Join-Path $settings.desktopStatusDirectory 'report.html'))){$delivered=$true;break}
                }catch{}
                Start-Sleep -Seconds 1
            }while([DateTimeOffset]::Now -lt $deliveryDeadline)
        }
        if(-not $delivered){$report.shutdownDecision=@{state='deferred';reason='The current host report is saved; desktop delivery could not be confirmed before shutdown.'}}
        else{
            $latest=Read-GiveawaysLiveReport $settings
            $hostEligibility=Get-GiveawaysHostShutdownEligibility $settings
            if(-not $latest -or $latest.runId -ne $report.runId -or $latest.shutdown.eligible -ne $true -or $hostEligibility.eligible -ne $true){
                $report.shutdownDecision=@{state='deferred';reason='Shutdown eligibility changed after report delivery.'}
            }else{
                $report.shutdownDecision=@{state='requested';reason='Report delivered; all designated jobs are idle.'}
                Save-HostResult
                $job=Stop-VM -VM (Get-OwnedGiveawaysVM $settings) -AsJob -Confirm:$false
                try{
                    if(-not (Wait-Job -Job $job -Timeout 90)){throw 'Guest normal shutdown did not finish within 90 seconds; no forced shutdown was attempted.'}
                    Receive-Job -Job $job -ErrorAction Stop|Out-Null
                    if([string](Get-OwnedGiveawaysVM $settings).State -ne 'Off'){throw 'The guest did not power off.'}
                    $report.shutdownDecision=@{state='powered-off';reason='Report delivered and designated jobs were idle.'}
                }finally{Remove-Job -Job $job -Force -ErrorAction SilentlyContinue}
            }
        }
    }
} catch {
    $report.state='failed'
    $report.reason=$_.Exception.Message
    $report.failureLocation=@{script=(Split-Path -Leaf $_.InvocationInfo.ScriptName);line=$_.InvocationInfo.ScriptLineNumber;stack=$_.ScriptStackTrace}
    $report.shutdownDecision=@{state='deferred';reason='The request failed; guest state was preserved for diagnosis.'}
} finally {
    if($powerSet){[void][GoodreadsRequestPower]::SetThreadExecutionState([uint32]2147483648)}
    $report.endedAt=[DateTimeOffset]::Now.ToString('o')
    if($mutex -and -not $ownsLock){
        Write-VMJson (Join-Path $reportDirectory ('host-request-'+$report.runId+'.json')) $report
    }else{Save-HostResult}
    $history=Join-Path $reportDirectory 'history'
    New-Item -ItemType Directory -Path $history -Force|Out-Null
    $temporary=Join-Path $history ($report.runId+'.json')
    [IO.File]::WriteAllText($temporary,($report|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    if($ownsLock){$mutex.ReleaseMutex()}
    if($mutex){$mutex.Dispose()}
}
if($report.state -notin @('completed','skipped')){Write-Error ($report.reason|Out-String);exit 1}
Write-Output "Goodreads request $($report.runId): $($report.state); shutdown $($report.shutdownDecision.state)."
