param(
    [string]$ReportDirectory="$env:ProgramData\GoodreadsGiveawaysVM\reports",
    [string]$PythonPath="$env:ProgramData\GoodreadsGiveawaysVM\runtime\pythonw.exe",
    [switch]$NoStart
)
$ErrorActionPreference='Stop'
if(-not(Test-Path -LiteralPath $PythonPath -PathType Leaf)){throw 'Install the host Python runtime before desktop reporting.'}
if(-not(Test-Path -LiteralPath $ReportDirectory -PathType Container)){throw 'The host report directory does not exist.'}
if((Get-TimeZone).Id -ne 'Eastern Standard Time'){throw 'The morning report deadline requires the Eastern Windows time zone.'}
$root=Join-Path $env:LOCALAPPDATA 'GoodreadsGiveawaysDesktopStatus'
New-Item -ItemType Directory -Path $root -Force|Out-Null
foreach($name in @('DesktopStatus.py','Show-DesktopStatus.ps1')){
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root $name) -Force
}
$configPath=Join-Path $root 'settings.json'
$config=@{enabled=$true;reportDirectory=$ReportDirectory;expectedBy='07:30';monitorFrom=(Get-Date).AddDays(1).ToString('yyyy-MM-dd')}
if(Test-Path -LiteralPath $configPath){$config.monitorFrom=(Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json).monitorFrom}
[IO.File]::WriteAllText($configPath,($config|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$script=Join-Path $root 'DesktopStatus.py'
# Register this user's app identity and a fixed report-opening protocol.
# URI content is never passed to the script, interpreted, or executed.
$appKey='HKCU:\Software\Classes\AppUserModelId\GoodreadsGiveaways.DesktopStatus'
New-Item -Path $appKey -Force|Out-Null
New-ItemProperty -LiteralPath $appKey -Name DisplayName -Value 'Goodreads run report' -PropertyType String -Force|Out-Null
$activator='{94d7df21-d89d-45c3-b00b-c105c9190ec7}'
# The toast uses protocol activation. This stable shortcut identity allows it
# to remain in Notification Center after the sending process has exited.
New-ItemProperty -LiteralPath $appKey -Name CustomActivator -Value $activator -PropertyType String -Force|Out-Null
$protocol='HKCU:\Software\Classes\goodreads-status'
New-Item -Path "$protocol\shell\open\command" -Force|Out-Null
Set-Item -LiteralPath $protocol -Value 'URL:Goodreads run report'
New-ItemProperty -LiteralPath $protocol -Name 'URL Protocol' -Value '' -PropertyType String -Force|Out-Null
$openCommand='"'+$PythonPath+'" "'+$script+'" --config "'+$configPath+'" --open-report'
Set-Item -LiteralPath "$protocol\shell\open\command" -Value $openCommand
$command='"'+$PythonPath+'" "'+$script+'" --config "'+$configPath+'" --watch'
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name GoodreadsGiveawaysStatus -Value $command -PropertyType String -Force|Out-Null
$consolePython=Join-Path (Split-Path -Parent $PythonPath) 'python.exe'
& $consolePython $script --config $configPath --initialize
if($LASTEXITCODE -ne 0){throw 'Could not initialize the desktop report.'}
$shell=New-Object -ComObject WScript.Shell
if(-not ('GoodreadsStatusShortcut' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'DesktopStatusShortcut.cs')}
foreach($directory in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))){
    $linkPath=Join-Path $directory 'Goodreads run report.lnk'
    $link=$shell.CreateShortcut($linkPath)
    $link.TargetPath=$PythonPath
    $link.Arguments='"'+$script+'" --config "'+$configPath+'" --open-report'
    $link.Description='Latest account results, processed counts, and errors from the scheduled VM run.'
    $link.Save()
    [GoodreadsStatusShortcut]::Register($linkPath,'GoodreadsGiveaways.DesktopStatus',$activator)
}
if(-not $NoStart){Start-Process -FilePath $PythonPath -ArgumentList ('"'+$script+'" --config "'+$configPath+'" --watch') -WindowStyle Hidden}
@{installed=$true;report=(Join-Path $root 'report.html');config=$configPath;startup='Current user, hidden';expectedBy='07:30 Eastern'}|ConvertTo-Json
