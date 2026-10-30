# No Pester module, Windows registration, or notification delivery is required.
# Run with Windows PowerShell 5.1 or PowerShell 7:
# powershell -NoProfile -File .\Goodreads\VM\Show-DesktopStatus.test.ps1
$ErrorActionPreference='Stop'
$script=Join-Path $PSScriptRoot 'Show-DesktopStatus.ps1'
$directory=Join-Path ([IO.Path]::GetTempPath()) ('goodreads-toast-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory|Out-Null
$summaryPath=Join-Path $directory 'summary.json'
$originalCulture=[Threading.Thread]::CurrentThread.CurrentCulture
$checks=0
function Assert-Equal($Actual,$Expected,[string]$Message){
    if($Actual -cne $Expected){throw "$Message Expected [$Expected], got [$Actual]."}
}
try{
    # A non-Gregorian current culture must not change the toast's ISO date.
    [Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo('ar-SA')
    $summary=@{
        title='Goodreads: 3/3 accounts completed'
        body='Profile 1: A&B <example> "quoted"'
        detail='90 processed; no runner errors.'
        healthy=$true
    }
    $cases=@(
        @{input='2026-10-30T05:06:12.8956314-04:00';expected='2026-10-30T05:06:12-04:00'},
        @{input='2026-10-30T05:06:12.0000000-04:00';expected='2026-10-30T05:06:12-04:00'},
        @{input='2026-10-30T09:06:12.123456Z';expected='2026-10-30T09:06:12+00:00'},
        @{input='2026-10-30T14:36:12+05:30';expected='2026-10-30T14:36:12+05:30'}
    )
    foreach($case in $cases){
        $summary.endedAt=$case.input
        [IO.File]::WriteAllText($summaryPath,($summary|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        foreach($preview in @($false,$true)){
            [xml]$payload=& $script -SummaryPath $summaryPath -ContentOnly -Preview:$preview
            $toast=$payload.DocumentElement
            $stamp=$toast.GetAttribute('displayTimestamp')
            if($stamp -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$'){
                throw "Unsupported toast timestamp precision or format: $stamp"
            }
            # PowerShell 7's JSON reader can normalize explicit offsets into
            # the local zone. Require the same instant, to whole seconds.
            $culture=[Globalization.CultureInfo]::InvariantCulture
            $actual=[DateTimeOffset]::Parse($stamp,$culture).UtcDateTime.Ticks
            $expected=[DateTimeOffset]::Parse($case.expected,$culture).UtcDateTime.Ticks
            Assert-Equal $actual $expected 'Timestamp lost its offset or completion time.'
            Assert-Equal $toast.GetAttribute('launch') 'open-report' 'Body click lost its report action.'
            Assert-Equal $toast.GetAttribute('activationType') 'foreground' 'Body activation changed.'
            $buttons=$payload.SelectNodes('/toast/actions/action')
            Assert-Equal $buttons.Count 1 'Exactly one report button must remain in the payload.'
            Assert-Equal $buttons.Item(0).GetAttribute('content') 'Open report' 'Report button label changed.'
            Assert-Equal $buttons.Item(0).GetAttribute('arguments') 'open-report' 'Button click lost its report action.'
            Assert-Equal $buttons.Item(0).GetAttribute('activationType') 'foreground' 'Button activation changed.'
            $text=$payload.SelectNodes('/toast/visual/binding/text')
            Assert-Equal $text.Count 3 'Report text was lost.'
            Assert-Equal $text.Item(0).InnerText $summary.title 'Report title changed.'
            Assert-Equal $text.Item(1).InnerText $summary.body 'Report text was not safely escaped and preserved.'
            Assert-Equal $text.Item(2).InnerText $summary.detail 'Report details changed.'
            Assert-Equal $payload.SelectSingleNode('/toast/audio').GetAttribute('silent') 'true' 'Notification must stay silent.'
            $expectedDuration=if($preview){'long'}else{'short'}
            Assert-Equal $toast.GetAttribute('duration') $expectedDuration 'Preview duration changed.'
            $checks++
        }
    }
    $summary.Remove('endedAt')
    [IO.File]::WriteAllText($summaryPath,($summary|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    [xml]$payload=& $script -SummaryPath $summaryPath -ContentOnly
    Assert-Equal $payload.DocumentElement.HasAttribute('displayTimestamp') $false 'An absent completion time must not be invented.'
    $checks++
    Write-Output "$checks notification payload cases passed. No notification was sent."
}finally{
    [Threading.Thread]::CurrentThread.CurrentCulture=$originalCulture
    Remove-Item -LiteralPath $directory -Recurse -Force
}
