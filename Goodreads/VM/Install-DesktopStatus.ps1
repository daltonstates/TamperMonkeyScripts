param(
    [string]$ReportDirectory="$env:ProgramData\GoodreadsGiveawaysVM\reports",
    [string]$PythonPath="$env:ProgramData\GoodreadsGiveawaysVM\runtime\pythonw.exe",
    [switch]$NoStart,
    [switch]$DesktopProcess,
    [string]$SeedDirectory,
    [string]$ReceiptPath
)
$ErrorActionPreference='Stop'
if(-not(Test-Path -LiteralPath $PythonPath -PathType Leaf)){throw 'Install the host Python runtime before desktop reporting.'}
if(-not(Test-Path -LiteralPath $ReportDirectory -PathType Container)){throw 'The host report directory does not exist.'}
if((Get-TimeZone).Id -ne 'Eastern Standard Time'){throw 'The morning report deadline requires the Eastern Windows time zone.'}
if(-not ('GoodreadsStatusShortcut' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'DesktopStatusShortcut.cs')}
$dataHome=Join-Path $env:USERPROFILE '.goodreads-giveaways'
$root=Join-Path $dataHome 'desktop'
New-Item -ItemType Directory -Path $dataHome -Force|Out-Null

if(-not $DesktopProcess){
    # AppData and HKCU writes from a packaged caller can be redirected into its
    # private store. Install from a limited interactive Windows task instead.
    # Staging outside AppData also makes the source visible to that task.
    if(-not $SeedDirectory){
        $legacy=Join-Path $env:LOCALAPPDATA 'GoodreadsGiveawaysDesktopStatus'
        if(Test-Path -LiteralPath (Join-Path $legacy 'report.html')){
            $SeedDirectory=Split-Path -Parent ([GoodreadsStatusShortcut]::PhysicalPath((Join-Path $legacy 'report.html')))
        }
    }
    $id=[guid]::NewGuid().ToString('N')
    $stage=Join-Path $dataHome ('install-'+$id)
    New-Item -ItemType Directory -Path $stage -Force|Out-Null
    foreach($name in @('Install-DesktopStatus.ps1','DesktopStatusShortcut.cs','DesktopStatus.py','Show-DesktopStatus.ps1')){
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $stage $name)
    }
    $ReceiptPath=Join-Path $stage 'result.json'
    $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $stage 'Install-DesktopStatus.ps1')+'" -DesktopProcess -ReportDirectory "'+$ReportDirectory+'" -PythonPath "'+$PythonPath+'" -ReceiptPath "'+$ReceiptPath+'"'
    if($SeedDirectory){$arguments+=' -SeedDirectory "'+$SeedDirectory+'"'}
    if($NoStart){$arguments+=' -NoStart'}
    $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
    $taskName='Goodreads desktop report setup '+$id.Substring(0,8)
    try{
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2))|Out-Null
        Start-ScheduledTask -TaskName $taskName
        $deadline=[DateTime]::Now.AddSeconds(55)
        do{
            if(Test-Path -LiteralPath $ReceiptPath){break}
            if([DateTime]::Now -ge $deadline){throw 'Desktop installation timed out. Its staged sources and task were kept for inspection.'}
            Start-Sleep -Milliseconds 400
        }while($true)
        $result=Get-Content -LiteralPath $ReceiptPath -Raw|ConvertFrom-Json
        if(-not $result.installed){throw $result.error}
        $result|ConvertTo-Json -Depth 5
    }finally{
        if(Test-Path -LiteralPath $ReceiptPath){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue}
    }
    exit 0
}

try{
    # Stop the previous reader by its own configuration, preserving its reports.
    if($SeedDirectory -and [IO.Path]::GetFullPath($SeedDirectory) -ne [IO.Path]::GetFullPath($root)){
        $seedConfig=Join-Path $SeedDirectory 'settings.json'
        if(Test-Path -LiteralPath $seedConfig){
            $old=Get-Content -LiteralPath $seedConfig -Raw|ConvertFrom-Json
            $old.enabled=$false
            [IO.File]::WriteAllText($seedConfig,($old|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
            $pidFile=Join-Path $SeedDirectory 'watcher-process.json'
            if(Test-Path -LiteralPath $pidFile){
                $oldPid=(Get-Content -LiteralPath $pidFile -Raw|ConvertFrom-Json).pid
                $deadline=[DateTime]::Now.AddSeconds(35)
                while(Get-Process -Id $oldPid -ErrorAction SilentlyContinue){
                    if([DateTime]::Now -ge $deadline){throw 'The previous desktop reader did not stop after being disabled.'}
                    Start-Sleep -Milliseconds 400
                }
            }
        }
    }
    New-Item -ItemType Directory -Path $root -Force|Out-Null
    if($SeedDirectory -and [IO.Path]::GetFullPath($SeedDirectory) -ne [IO.Path]::GetFullPath($root)){
        foreach($name in @('settings.json','watcher-state.json','latest-report.json','report.html','history')){
            $from=Join-Path $SeedDirectory $name
            $to=Join-Path $root $name
            if((Test-Path -LiteralPath $from) -and -not(Test-Path -LiteralPath $to)){Copy-Item -LiteralPath $from -Destination $to -Recurse}
        }
    }
    foreach($name in @('DesktopStatus.py','Show-DesktopStatus.ps1')){
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root $name) -Force
    }
    $configPath=Join-Path $root 'settings.json'
    $config=@{enabled=$true;reportDirectory=$ReportDirectory;expectedBy='07:30';monitorFrom=(Get-Date).AddDays(1).ToString('yyyy-MM-dd')}
    if(Test-Path -LiteralPath $configPath){$config.monitorFrom=(Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json).monitorFrom}
    [IO.File]::WriteAllText($configPath,($config|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $script=Join-Path $root 'DesktopStatus.py'
    $appKey='HKCU:\Software\Classes\AppUserModelId\GoodreadsGiveaways.DesktopStatus'
    New-Item -Path $appKey -Force|Out-Null
    New-ItemProperty -LiteralPath $appKey -Name DisplayName -Value 'Goodreads run report' -PropertyType String -Force|Out-Null
    $activator='{94d7df21-d89d-45c3-b00b-c105c9190ec7}'
    New-ItemProperty -LiteralPath $appKey -Name CustomActivator -Value $activator -PropertyType String -Force|Out-Null
    $protocol='HKCU:\Software\Classes\goodreads-status'
    New-Item -Path "$protocol\shell\open\command" -Force|Out-Null
    Set-Item -LiteralPath $protocol -Value 'URL:Goodreads run report'
    New-ItemProperty -LiteralPath $protocol -Name 'URL Protocol' -Value '' -PropertyType String -Force|Out-Null
    # Only this fixed command is registered. URI arguments are never executed.
    $openCommand='"'+$PythonPath+'" "'+$script+'" --config "'+$configPath+'" --open-report'
    Set-Item -LiteralPath "$protocol\shell\open\command" -Value $openCommand
    $command='"'+$PythonPath+'" "'+$script+'" --config "'+$configPath+'" --watch'
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name GoodreadsGiveawaysStatus -Value $command -PropertyType String -Force|Out-Null
    $consolePython=Join-Path (Split-Path -Parent $PythonPath) 'python.exe'
    & $consolePython $script --config $configPath --initialize
    if($LASTEXITCODE -ne 0){throw 'Could not initialize the desktop report.'}
    $shell=New-Object -ComObject WScript.Shell
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
    $latest=Join-Path $root 'latest-report.json'
    $summary=Get-Content -LiteralPath $latest -Raw|ConvertFrom-Json
    if($summary.body){
        & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'Show-DesktopStatus.ps1') -SummaryPath $latest|Out-Null
        if($LASTEXITCODE -ne 0){throw 'Desktop installation finished, but the summary notification could not be refreshed.'}
    }
    $result=@{installed=$true;report=(Join-Path $root 'report.html');config=$configPath;startup='Current user, hidden';expectedBy='07:30 Eastern';normalDesktopContext=$true}
}catch{
    $result=@{installed=$false;error=$_.Exception.Message}
    if($ReceiptPath){[IO.File]::WriteAllText($ReceiptPath,($result|ConvertTo-Json),[Text.UTF8Encoding]::new($false))}
    throw
}
if($ReceiptPath){[IO.File]::WriteAllText($ReceiptPath,($result|ConvertTo-Json),[Text.UTF8Encoding]::new($false))}
$result|ConvertTo-Json
