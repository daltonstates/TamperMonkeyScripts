# Hyper-V KVP transport. Only this adapter depends on the virtualization API.
# https://learn.microsoft.com/windows-server/virtualization/hyper-v/integration-services-data-exchange
function Test-GiveawaysOtherActiveQueue($Bundle, $RunId) {
    $guest=$Bundle.files.'vm-last-run.json'
    return ($Bundle -and $Bundle.runId -ne $RunId -and $guest.runId -eq $Bundle.runId -and
            $guest.state -in @('starting','running') -and -not $guest.endedAt)
}

function Get-GiveawaysKvpVM($Settings) {
    [void](Get-OwnedGiveawaysVM $Settings)
    Get-WmiObject -Namespace root\virtualization\v2 -Class Msvm_ComputerSystem -Filter ("Name='" + $Settings.vmId + "'") -ErrorAction Stop
}

function Set-GiveawaysRequest($Settings, $Request) {
    $vm = Get-GiveawaysKvpVM $Settings
    $service = Get-WmiObject -Namespace root\virtualization\v2 -Class Msvm_VirtualSystemManagementService
    $item = ([wmiclass]'\\.\root\virtualization\v2:Msvm_KvpExchangeDataItem').CreateInstance()
    $item.Name = 'Goodreads.Request'
    $item.Data = $Request | ConvertTo-Json -Compress
    $item.Source = 0
    $component = @($vm.GetRelated('Msvm_KvpExchangeComponent'))[0]
    $existing = @($component.GetRelated('Msvm_KvpExchangeComponentSettingData'))[0].HostExchangeItems
    $present = @($existing | Where-Object { ([xml]$_).SelectSingleNode("/INSTANCE/PROPERTY[@NAME='Name']/VALUE").InnerText -eq $item.Name }).Count -gt 0
    $result = if ($present) { $service.ModifyKvpItems($vm, @($item.PSBase.GetText(1))) } else { $service.AddKvpItems($vm, @($item.PSBase.GetText(1))) }
    if ($result.ReturnValue -eq 4096) {
        $job = [wmi]$result.Job
        $deadline = [DateTimeOffset]::Now.AddSeconds(30)
        while ($job.JobState -in @(3,4)) {
            if ([DateTimeOffset]::Now -gt $deadline) { throw 'Hyper-V could not deliver the job request within 30 seconds.' }
            Start-Sleep -Milliseconds 250
            $job.Get()
        }
        if ($job.JobState -ne 7) { throw "Hyper-V request delivery failed: $($job.ErrorDescription)" }
    } elseif ($result.ReturnValue -ne 0) { throw "Hyper-V request delivery failed: $($result.ReturnValue)" }
}

function Read-GiveawaysLiveReport($Settings) {
    $vm = Get-GiveawaysKvpVM $Settings
    if(-not $vm){return $null}
    $items = @{}
    $component=@($vm.GetRelated('Msvm_KvpExchangeComponent'))[0]
    if(-not $component){return $null}
    foreach($rawItem in $component.GuestExchangeItems){
        if([string]::IsNullOrWhiteSpace($rawItem)){continue}
        [xml]$xml = $rawItem
        $name = $xml.SelectSingleNode("/INSTANCE/PROPERTY[@NAME='Name']/VALUE").InnerText
        if ($name -like 'Goodreads.Report*') { $items[$name] = $xml.SelectSingleNode("/INSTANCE/PROPERTY[@NAME='Data']/VALUE").InnerText }
    }
    if (-not $items.ContainsKey('Goodreads.Report')) { return $null }
    $manifest = $items['Goodreads.Report'] | ConvertFrom-Json
    if ($manifest.count -lt 1 -or $manifest.count -gt 128 -or $manifest.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid guest report manifest.' }
    $encoded = ''
    for ($index=0; $index -lt $manifest.count; $index++) {
        $chunk = $items["Goodreads.Report.$index"]
        if (-not $chunk -or $chunk.Length -gt 800) { return $null }
        $encoded += $chunk
    }
    $inputStream=$stream=$outputStream=$null
    try {
        try {
            $inputStream = [IO.MemoryStream]::new([Convert]::FromBase64String($encoded))
            $stream = [IO.Compression.GZipStream]::new($inputStream, [IO.Compression.CompressionMode]::Decompress)
            $outputStream = [IO.MemoryStream]::new()
            $buffer = New-Object byte[] 8192
            while (($count = $stream.Read($buffer,0,$buffer.Length)) -gt 0) {
                $outputStream.Write($buffer,0,$count)
                if ($outputStream.Length -gt 1MB) { throw 'Oversized guest report.' }
            }
        } catch {
            # KVP propagates individual chunks before the final manifest. A
            # mixed snapshot may fail decoding before its digest can be checked.
            $cause=$_.Exception
            while($cause){
                if($cause -is [FormatException] -or $cause -is [IO.InvalidDataException]){return $null}
                $cause=$cause.InnerException
            }
            throw
        }
        $raw = $outputStream.ToArray()
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($hash.ComputeHash($raw)).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
        if ($digest -ne $manifest.sha256) { return $null } # KVP propagation in progress; retry.
        $bundle = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json
        if ($bundle.schema -ne 1 -or $bundle.runId -ne $manifest.runId) { throw 'Invalid guest report identity.' }
        return $bundle
    } finally {
        if($stream){$stream.Dispose()}
        if($inputStream){$inputStream.Dispose()}
        if($outputStream){$outputStream.Dispose()}
    }
}

function Export-GiveawaysLiveReport($Settings, $Bundle) {
    $runId=[string]$Bundle.runId
    if($runId -notmatch '^[a-f0-9]{32}$'){throw 'Invalid report request identity.'}
    $runDirectory=Join-Path $Settings.reportDirectory ('runs\'+$runId)
    New-Item -ItemType Directory -Path $runDirectory -Force|Out-Null
    foreach ($name in @('vm-last-run.json','vm-last-skip.json','daily-last-run.json','daily-verification.json','daily-incomplete.json','helper-status.json','installation.json','daily.log','vm-runner.log','helper.log')) {
        if ($Bundle.files.PSObject.Properties.Name -contains $name) {
            foreach($directory in @($runDirectory,$Settings.reportDirectory)){
                $path = Join-Path $directory $name
                if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Host report paths must not be links.' }
                if ($name.EndsWith('.json')) { Write-VMJson $path $Bundle.files.$name }
                else { [IO.File]::WriteAllText($path, [string]$Bundle.files.$name, [Text.UTF8Encoding]::new($false)) }
            }
        }
    }
    # This file is an exported snapshot, never a guest control marker. Once the
    # same guest run proves every owned window closed, archive its old snapshot
    # so a completed host report does not still appear to have unfinished work.
    $guest=$Bundle.files.'vm-last-run.json'
    if($runId -match '^[a-f0-9]{32}$' -and $guest.queueClosed -eq $true -and
       $Bundle.files.PSObject.Properties.Name -notcontains 'daily-incomplete.json'){
        $pending=Join-Path $Settings.reportDirectory 'daily-incomplete.json'
        if(Test-Path -LiteralPath $pending){
            if((Get-Item -LiteralPath $pending).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Host report paths must not be links.'}
            $previous=Get-Content -LiteralPath $pending -Raw|ConvertFrom-Json
            $recovered=@($Bundle.files.'daily-last-run.json'.recoveries|Where-Object{$_.recovered -eq $true}|ForEach-Object{$_.previousRunId})
            if($previous.runId -eq $runId -or $previous.runId -in $recovered){
                $history=Join-Path $Settings.reportDirectory 'history'
                New-Item -ItemType Directory -Path $history -Force|Out-Null
                $deadline=[DateTimeOffset]::Now.AddSeconds(5)
                do{
                    try{Move-Item -LiteralPath $pending -Destination (Join-Path $history ('completed-pending-'+$runId+'.json')) -Force -ErrorAction Stop;break}
                    catch{
                        if(($_.Exception.HResult -band 65535) -notin @(5,32,33) -or [DateTimeOffset]::Now -ge $deadline){throw}
                        Start-Sleep -Milliseconds 50
                    }
                }while($true)
            }
        }
    }
}

function Get-GiveawaysQueuedRequests($Settings) {
    if(-not $Settings.reportDirectory){return @()}
    $directory=Join-Path $Settings.reportDirectory 'queued'
    if(-not(Test-Path -LiteralPath $directory)){return @()}
    $active=@()
    foreach($file in Get-ChildItem -LiteralPath $directory -Filter '*.json' -File){
        $entry=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json
        if($entry.runId -notmatch '^[a-f0-9]{32}$' -or $entry.state -ne 'queued' -or -not $entry.worker.pid -or -not $entry.worker.startedAt){throw 'Unrecognized queued request was preserved.'}
        $worker=Get-Process -Id $entry.worker.pid -ErrorAction SilentlyContinue
        $expectedStart=if($entry.worker.startedAt -is [DateTime]){[DateTimeOffset]$entry.worker.startedAt}else{[DateTimeOffset]::Parse([string]$entry.worker.startedAt,[Globalization.CultureInfo]::InvariantCulture)}
        if($worker -and ([DateTimeOffset]$worker.StartTime.ToUniversalTime()).UtcTicks -eq $expectedStart.UtcTicks -and $worker.Path -eq $entry.worker.exe){
            $active+=,$entry
        }else{
            # A dead waiting process never owned the VM or browser. Preserve its
            # request as interrupted; the next cycle still resumes account work.
            $entry.state='interrupted'
            $entry|Add-Member -Force NoteProperty endedAt ([DateTimeOffset]::Now.ToString('o'))
            $entry|Add-Member -Force NoteProperty reason 'The waiting host process ended before admission. Account work is retained for the next scheduled cycle.'
            $target=Join-Path $Settings.reportDirectory ('runs\'+$entry.runId+'\host-last-run.json')
            Write-VMJson $target $entry
            $history=Join-Path $Settings.reportDirectory 'history'
            New-Item -ItemType Directory -Path $history -Force|Out-Null
            Write-VMJson (Join-Path $history ('queued-'+$entry.runId+'.json')) $entry
            Remove-Item -LiteralPath $file.FullName
        }
    }
    return $active
}

function Get-GiveawaysHostShutdownEligibility($Settings) {
    if ($Settings.jobInventoryVerified -ne $true -or $null -eq $Settings.otherJobTasks) { return @{eligible=$false;reason='Other host jobs using this VM have not been inventoried.'} }
    try {
        $blocked = @()
        foreach($request in @(Get-GiveawaysQueuedRequests $Settings)){$blocked+='queued request '+$request.runId}
        foreach ($name in $Settings.otherJobTasks) {
            $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
            if ([string]$task.State -notin @('Ready','Disabled','Running','Queued')) { throw 'Unknown designated task state.' }
            if ([string]$task.State -in @('Running','Queued')) { $blocked += $name }
        }
        if ($Settings.activeJobsFile) {
            $jobs = (Get-Content -LiteralPath $Settings.activeJobsFile -Raw | ConvertFrom-Json).jobs
            if ($null -eq $jobs) { throw 'Missing active job inventory.' }
            foreach ($job in $jobs) {
                if ($job.state -in @('queued','running')) { $blocked += $job.name }
                elseif ($job.state -notin @('finished','failed','cancelled','idle')) { throw 'Unknown designated job state.' }
            }
        }
        return @{eligible=($blocked.Count -eq 0); reason=$(if ($blocked.Count) { 'Other jobs need the VM: ' + ($blocked -join ', ') } else { 'All designated host jobs are idle.' })}
    } catch { return @{eligible=$false;reason=('Cannot establish host shutdown eligibility: ' + $_.Exception.Message)} }
}
