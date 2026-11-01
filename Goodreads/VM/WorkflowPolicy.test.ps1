$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
. (Join-Path $PSScriptRoot 'VM.Transport.ps1')
function Check($value,$reason){if(-not $value){throw $reason};$script:checks++}
$script:checks=0
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('goodreads-policy-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch|Out-Null
try{
    $active=[pscustomobject]@{runId=('b'*32);files=[pscustomobject]@{'vm-last-run.json'=[pscustomobject]@{runId=('b'*32);state='running'}}}
    Check (Test-GiveawaysOtherActiveQueue $active ('a'*32)) 'A progressing earlier queue must keep the new request queued without a total wait cutoff.'
    Check (-not (Test-GiveawaysOtherActiveQueue $active ('b'*32))) 'The requested queue must be handled as its own acknowledgement.'
    $active.files.'vm-last-run.json'|Add-Member NoteProperty endedAt '2026-11-01T17:00:00Z'
    Check (-not (Test-GiveawaysOtherActiveQueue $active ('a'*32))) 'A completed old report must not indefinitely postpone startup failure reporting.'
    Check (-not (Test-GiveawaysOtherActiveQueue $null ('a'*32))) 'Missing transport must not be mistaken for active work.'
    $settings=[pscustomobject]@{jobInventoryVerified=$true;otherJobTasks=@('Other automation')}
    function Get-ScheduledTask {param($TaskName) [pscustomobject]@{TaskName=$TaskName;State=$script:otherState}}
    $script:otherState='Running'
    Check (-not (Get-GiveawaysHostShutdownEligibility $settings).eligible) 'An active designated job must prevent shutdown.'
    $script:otherState='Queued'
    Check (-not (Get-GiveawaysHostShutdownEligibility $settings).eligible) 'A queued designated job must prevent shutdown.'
    $script:otherState='Unknown'
    Check (-not (Get-GiveawaysHostShutdownEligibility $settings).eligible) 'Unknown job state must preserve the VM.'
    $script:otherState='Ready'
    Check (Get-GiveawaysHostShutdownEligibility $settings).eligible 'An idle designated job should permit shutdown.'
    $settings.jobInventoryVerified=$false
    Check (-not (Get-GiveawaysHostShutdownEligibility $settings).eligible) 'Missing job inventory must preserve the VM.'
    $settings.jobInventoryVerified=$true
    $settings|Add-Member NoteProperty activeJobsFile (Join-Path $scratch 'jobs.json')
    Write-VMJson $settings.activeJobsFile @{jobs=@(@{name='export';state='running'})}
    Check (-not (Get-GiveawaysHostShutdownEligibility $settings).eligible) 'Shared active-job state must prevent shutdown.'

    $bundle=@{schema=1;runId=('a'*32);at=[DateTimeOffset]::Now.ToString('o');files=@{'vm-last-skip.json'=@{state='skipped';reason='disabled'}}}
    $raw=[Text.Encoding]::UTF8.GetBytes(($bundle|ConvertTo-Json -Depth 8 -Compress))
    $out=[IO.MemoryStream]::new()
    $zip=[IO.Compression.GZipStream]::new($out,[IO.Compression.CompressionLevel]::Optimal,$true)
    $zip.Write($raw,0,$raw.Length);$zip.Dispose()
    $encoded=[Convert]::ToBase64String($out.ToArray());$out.Dispose()
    $hash=[Security.Cryptography.SHA256]::Create()
    try{$digest=[BitConverter]::ToString($hash.ComputeHash($raw)).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
    $manifest=@{count=1;sha256=$digest;runId=$bundle.runId;at=$bundle.at}|ConvertTo-Json -Compress
    function KvpXml($name,$data){'<INSTANCE><PROPERTY NAME="Name"><VALUE>'+[Security.SecurityElement]::Escape($name)+'</VALUE></PROPERTY><PROPERTY NAME="Data"><VALUE>'+[Security.SecurityElement]::Escape($data)+'</VALUE></PROPERTY></INSTANCE>'}
    $script:exchange=[pscustomobject]@{GuestExchangeItems=@((KvpXml 'Goodreads.Report' $manifest),(KvpXml 'Goodreads.Report.0' $encoded))}
    $script:kvpVM=[pscustomobject]@{}
    $script:kvpVM|Add-Member ScriptMethod GetRelated {param($class) $script:exchange}
    function Get-GiveawaysKvpVM($Settings){$script:kvpVM}
    $decoded=Read-GiveawaysLiveReport $settings
    Check ($decoded.files.'vm-last-skip.json'.reason -eq 'disabled') 'Live report transport lost the skip reason.'
    $bad=@{count=1;sha256=('0'*64);runId=$bundle.runId}|ConvertTo-Json -Compress
    $script:exchange.GuestExchangeItems=@((KvpXml 'Goodreads.Report' $bad),(KvpXml 'Goodreads.Report.0' $encoded))
    Check ($null -eq (Read-GiveawaysLiveReport $settings)) 'A partial or corrupt report must not be accepted.'

    $reports=Join-Path $scratch 'reports'
    New-Item -ItemType Directory -Path $reports|Out-Null
    $settings|Add-Member NoteProperty reportDirectory $reports
    $completed=[pscustomobject]@{runId=('a'*32);files=[pscustomobject]@{'vm-last-run.json'=[pscustomobject]@{runId=('a'*32);queueClosed=$true}}}
    Write-VMJson (Join-Path $reports 'daily-incomplete.json') @{runId=('a'*32);profile='A'}
    Export-GiveawaysLiveReport $settings $completed
    Check (-not(Test-Path (Join-Path $reports 'daily-incomplete.json')) -and (Test-Path (Join-Path $reports ('history\completed-pending-'+('a'*32)+'.json')))) 'Confirmed completion must archive its stale exported marker.'
    Write-VMJson (Join-Path $reports 'daily-incomplete.json') @{runId=('b'*32);profile='B'}
    Export-GiveawaysLiveReport $settings $completed
    Check (Test-Path (Join-Path $reports 'daily-incomplete.json')) "Completion must preserve another run's exported marker."
    Write-VMJson (Join-Path $reports 'daily-incomplete.json') @{runId=('a'*32);profile='A'}
    $completed.files.'vm-last-run.json'.queueClosed=$false
    Export-GiveawaysLiveReport $settings $completed
    Check (Test-Path (Join-Path $reports 'daily-incomplete.json')) 'An active queue must preserve its exported unfinished-work evidence.'

    $previousProgramData=$env:ProgramData
    try{
        $env:ProgramData=$scratch
        $ErrorActionPreference='Continue'
        & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Invoke-VMWorkflow.ps1') -SettingsPath (Join-Path $scratch 'missing-settings.json') *> (Join-Path $scratch 'startup.log')
        $ErrorActionPreference='Stop'
        $report=Get-Content -LiteralPath (Join-Path $scratch 'GoodreadsGiveawaysVM\reports\host-last-run.json') -Raw|ConvertFrom-Json
        Check ($report.state -eq 'failed' -and $report.endedAt -and $report.reason) 'Early startup failure must have a current report.'
        Check ($report.shutdownDecision.state -eq 'deferred') 'Startup failure must preserve guest state.'
    }finally{$env:ProgramData=$previousProgramData}
}finally{
    $resolved=[IO.Path]::GetFullPath($scratch)
    if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'goodreads-policy-*'){throw 'Unexpected test cleanup path.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
"$script:checks workflow policy checks passed without a VM."
