param([Parameter(Mandatory=$true)][string]$SummaryPath)
$ErrorActionPreference='Stop'
$summary=Get-Content -LiteralPath $SummaryPath -Raw -Encoding UTF8|ConvertFrom-Json
$appId='GoodreadsGiveaways.DesktopStatus'
[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.NotificationSetting,Windows.UI.Notifications,ContentType=WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]
$notifier=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$xml=[Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml('<toast activationType="protocol" launch="goodreads-status:report" duration="short"><visual><binding template="ToastGeneric"><text/><text/><text/></binding></visual><audio silent="true"/></toast>')
if($summary.endedAt){$xml.DocumentElement.SetAttribute('displayTimestamp',([DateTimeOffset]::Parse($summary.endedAt).ToString('o')))}
$text=$xml.GetElementsByTagName('text')
$text.Item(0).InnerText=[string]$summary.title
$text.Item(1).InnerText=[string]$summary.body
$text.Item(2).InnerText=[string]$summary.detail
$toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag='latest'
$toast.Group='daily'
$toast.SuppressPopup=($summary.healthy -eq $true)
$toast.ExpirationTime=[DateTimeOffset]::Now.AddDays(7)
$notifier.Show($toast)
# Windows creates the publisher's notification settings on its first Show.
$setting=$notifier.get_Setting()
if([string]$setting -ne 'Enabled'){throw "Windows notifications for Goodreads are $setting. The report is still saved locally."}
@{state='submitted';silent=$true;popup=(-not $toast.SuppressPopup);appId=$appId}|ConvertTo-Json -Compress
