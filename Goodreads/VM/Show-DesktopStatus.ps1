param([Parameter(Mandatory=$true)][string]$SummaryPath,[switch]$Preview,[switch]$ContentOnly)
$ErrorActionPreference='Stop'
$summary=Get-Content -LiteralPath $SummaryPath -Raw -Encoding UTF8|ConvertFrom-Json
# Use the standard XML DOM for content and the native Windows ABI for delivery.
$xml=[xml]'<toast activationType="foreground" launch="open-report" duration="short"><visual><binding template="ToastGeneric"><text/><text/><text/></binding></visual><actions><action content="Open report" activationType="foreground" arguments="open-report"/></actions><audio silent="true"/></toast>'
if($summary.endedAt){
    # Round-trip format ("o") emits seven fractional digits. Windows can reject
    # that toast content and replace its text/actions with "New notification".
    # Keep whole seconds, as the Windows Toolkit does (issue #1073), including
    # in Preview so a manual click test exercises the real run's payload.
    # https://github.com/CommunityToolkit/WindowsCommunityToolkit/issues/1073
    $culture=[Globalization.CultureInfo]::InvariantCulture
    # PowerShell 7 may deserialize the ISO value as DateTime; avoid converting
    # that object to culture-dependent text or losing its UTC/local kind.
    $stamp=if($summary.endedAt -is [DateTime]){[DateTimeOffset]$summary.endedAt}else{[DateTimeOffset]::Parse([string]$summary.endedAt,$culture)}
    $xml.DocumentElement.SetAttribute('displayTimestamp',$stamp.ToString("yyyy-MM-dd'T'HH:mm:sszzz",$culture))
}
if($Preview){$xml.DocumentElement.SetAttribute('duration','long')}
$text=$xml.GetElementsByTagName('text')
$text.Item(0).InnerText=[string]$summary.title
$text.Item(1).InnerText=[string]$summary.body
$text.Item(2).InnerText=[string]$summary.detail
# Build the exact production payload without native registration or delivery.
# This also allows content regression checks on any PowerShell installation.
if($ContentOnly){$xml.OuterXml;return}
$activation=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'activation-settings.json') -Raw|ConvertFrom-Json
if($activation.appId -ne 'GoodreadsGiveaways.RunReport' -or -not(Test-Path -LiteralPath $activation.exe -PathType Leaf)){throw 'Install the native desktop notification handler first.'}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'notification.xml'),$xml.OuterXml,[Text.UTF8Encoding]::new($false))
$quiet=$summary.healthy -eq $true -and -not $Preview
$arguments='--show-report'
if($quiet){$arguments+=' --quiet'}
$process=Start-Process -FilePath $activation.exe -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
if($process.ExitCode -ne 0){$result=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'notification-delivery.json') -Raw;throw "Native Windows notification failed: $result"}
@{state='submitted';silent=$true;popup=(-not $quiet);appId=$activation.appId;handler='native-COM'}|ConvertTo-Json -Compress
