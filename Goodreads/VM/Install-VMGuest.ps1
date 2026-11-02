param(
    [string]$PackagePath = 'C:\GoodreadsVM',
    [switch]$Migrate,
    [switch]$VerifyOnly,
    [switch]$Enable,
    [switch]$ClearPending,
    [string]$RetiredRestoreSha256
)
$ErrorActionPreference='Stop'
$computer=Get-CimInstance Win32_ComputerSystem
if($computer.Manufacturer -ne 'Microsoft Corporation' -or $computer.Model -ne 'Virtual Machine'){throw 'Install only in the dedicated Hyper-V guest.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $Migrate -and -not $admin){throw 'Initial installation requires an elevated guest PowerShell. Migration can use the existing task owner.'}
if($ClearPending){throw 'Installation never clears unfinished work. Inspect and recover the owned run before clearing its marker explicitly.'}
$root='C:\GoodreadsVM'
$output=Join-Path $root 'output'
New-Item -ItemType Directory -Path $output -Force|Out-Null
$archive=Join-Path $output ('history\install-'+(Get-Date -Format 'yyyyMMdd-HHmmss-ffff'))
New-Item -ItemType Directory -Path $archive -Force|Out-Null
if([IO.Path]::GetFullPath($PackagePath).TrimEnd('\') -ne $root){
    foreach($name in @('Goodreads','runtime')){Copy-Item -LiteralPath (Join-Path $PackagePath $name) -Destination $root -Recurse -Force}
    foreach($name in @('keyfire-config.json','daily-settings.template.json')){
        if(-not (Test-Path -LiteralPath (Join-Path $root $name))){Copy-Item -LiteralPath (Join-Path $PackagePath $name) -Destination $root}
    }
}
$python=Join-Path $root 'runtime\python.exe'
$pythonw=Join-Path $root 'runtime\pythonw.exe'
if(-not (Test-Path -LiteralPath $pythonw)){throw 'Missing guest Python runtime.'}
$dailyPath=Join-Path $output 'daily-settings.json'
$settingsPath=Join-Path $root 'guest-settings.json'
foreach($path in @($dailyPath,$settingsPath)){if(Test-Path -LiteralPath $path){Copy-Item -LiteralPath $path -Destination $archive}}
# Retire obsolete controls before they can overwrite migrated settings. Active
# queues remain intact; an audited settings-only restore has an explicit plan.
foreach($name in @('Goodreads acceptance restore','Goodreads maintenance catch-up','Goodreads manual run','Goodreads Profile 3 recovery','Goodreads empty result live check','Goodreads workflow maintenance')){
    $old=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if($old){
        if(($old.Actions.Arguments -join ' ') -notmatch 'C:\\GoodreadsVM\\'){throw "Unexpected action in '$name'; left alone."}
        if([string]$old.State -eq 'Running'){
            # An explicitly audited obsolete settings writer can be retired.
            # Never stop a profile queue or an unidentified maintenance action.
            $restoreScript=Join-Path $output 'Restore-NormalAfterAcceptance.ps1'
            if($name -ne 'Goodreads acceptance restore' -or $RetiredRestoreSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
               ($old.Actions.Arguments -join ' ') -notlike ('*'+$restoreScript+'*') -or
               (Get-FileHash -LiteralPath $restoreScript).Hash -ne $RetiredRestoreSha256){throw "Wait for the active task '$name' before migrating; no matching audited retirement was provided."}
            Export-ScheduledTask -TaskName $name|Set-Content -LiteralPath (Join-Path $archive 'retired-configuration-restore.xml')
            Disable-ScheduledTask -TaskName $name|Out-Null
            Stop-ScheduledTask -TaskName $name
            $stopDeadline=[DateTimeOffset]::Now.AddSeconds(15)
            do{
                $old=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
                if(-not $old -or [string]$old.State -ne 'Running'){break}
                if([DateTimeOffset]::Now -ge $stopDeadline){throw 'The audited obsolete settings writer did not stop.'}
                Start-Sleep -Milliseconds 250
            }while($true)
        }
        if($old -and [string]$old.State -ne 'Disabled'){Disable-ScheduledTask -TaskName $name|Out-Null}
    }
}
$daily=if(Test-Path -LiteralPath $dailyPath){Get-Content -LiteralPath $dailyPath -Raw|ConvertFrom-Json}else{Get-Content -LiteralPath (Join-Path $root 'daily-settings.template.json') -Raw|ConvertFrom-Json}
if(-not $daily.edgePath){$daily|Add-Member NoteProperty edgePath (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')}
if(-not $daily.userDataDirectory){$daily|Add-Member NoteProperty userDataDirectory (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')}
if(-not $daily.keyfireConfig){$daily|Add-Member NoteProperty keyfireConfig (Join-Path $root 'keyfire-config.json')}
$localState=Get-Content -LiteralPath (Join-Path $daily.userDataDirectory 'Local State') -Raw|ConvertFrom-Json
foreach($profile in $daily.profiles){
    $matches=@($localState.profile.info_cache.PSObject.Properties|Where-Object{$_.Value.name -eq $profile.name -and $_.Name -match '^(Default|Profile \d+)$'})
    if($matches.Count -ne 1){throw "Expected exactly one existing Edge profile '$($profile.name)'."}
    if($profile.directory -and $profile.directory -ne $matches[0].Name){throw "Configured profile directory changed for '$($profile.name)'; inspect before migrating."}
    $profile.directory=$matches[0].Name
    $profile.offsetMinutes=0
}
$daily|Add-Member -Force NoteProperty profileStartPolicy 'completion'
$daily|Add-Member -Force NoteProperty closeCompletedListings $true
if($null -eq $daily.inactivityMinutes){$daily|Add-Member NoteProperty inactivityMinutes 15}
[IO.File]::WriteAllText($dailyPath,($daily|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
$dailyRunner=Join-Path $root 'Goodreads\DailyGiveaways.py'
& $python $dailyRunner --config $dailyPath --check
if($LASTEXITCODE -ne 0){throw 'Guest queue settings or selected macro failed validation.'}
$companion=Join-Path $env:LOCALAPPDATA 'GoodreadsKeyfireCompanion'
$pairing=Join-Path $companion 'pairing-key.txt'
if(-not (Test-Path -LiteralPath $pairing)){throw 'Set up the existing local Keyfire helper in this account before enabling the VM adapter.'}
$settings=if(Test-Path -LiteralPath $settingsPath){Get-Content -LiteralPath $settingsPath -Raw|ConvertFrom-Json}else{[pscustomobject]@{enabled=$false}}
foreach($entry in @{dailyRunner=$dailyRunner;dailySettings=$dailyPath;recoverFailedProfiles=$true;adapterVersion='2026.11.02.2';interactiveUserSid=$identity.User.Value}.GetEnumerator()){$settings|Add-Member -Force NoteProperty $entry.Key $entry.Value}
# The host owns shutdown and report delivery; the guest never powers off itself.
$settings|Add-Member -Force NoteProperty shutdownAfterSuccess $false
$settings|Add-Member -Force NoteProperty preflightUserScriptUpdates $false
if($Enable){
    if((Get-TimeZone).Id -ne 'Eastern Standard Time'){if($admin){Set-TimeZone -Id 'Eastern Standard Time'}else{throw 'Guest time zone must be Eastern Standard Time.'}}
    $autologon=Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    if($autologon.AutoAdminLogon -ne '1' -or $autologon.DefaultUserName -ne $env:USERNAME){throw 'The configured interactive account does not have the existing unattended console sign-in.'}
    $settings.enabled=$true
}
$kvp='HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest'
if($admin){
    $registryKey=[Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('SOFTWARE\Microsoft\Virtual Machine\Guest')
    try{
        $acl=$registryKey.GetAccessControl()
        $rule=[Security.AccessControl.RegistryAccessRule]::new($identity.User,([Security.AccessControl.RegistryRights]::SetValue -bor [Security.AccessControl.RegistryRights]::QueryValues),'Allow')
        $acl.SetAccessRule($rule)
        $registryKey.SetAccessControl($acl)
    }finally{$registryKey.Dispose()}
}
$kvpKey=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Virtual Machine\Guest',[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[Security.AccessControl.RegistryRights]::SetValue)
try{$kvpKey.SetValue('Goodreads.InstallVersion','2026.11.02.2',[Microsoft.Win32.RegistryValueKind]::String)}finally{$kvpKey.Dispose()}
$wrapper=Join-Path $root 'Goodreads\VM\GuestWorkflow.py'
# Keep Goodreads' background listing/coordinator out of Edge sleeping tabs.
# Preserve every other existing site exclusion and profile preference.
$sleepKeyPath='SOFTWARE\Policies\Microsoft\Edge\SleepingTabsBlockedForUrls'
$sleepKey=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($sleepKeyPath)
$exclusions=@()
try{if($sleepKey){$exclusions=@($sleepKey.GetValueNames()|ForEach-Object{@{name=$_;value=[string]$sleepKey.GetValue($_)}})}}finally{if($sleepKey){$sleepKey.Dispose()}}
if(-not @($exclusions|Where-Object{$_.value -eq '[*.]goodreads.com'}).Count){
    if(-not $admin){throw 'An elevated guest installation is required once to configure the Goodreads sleeping-tabs exclusion.'}
    $sleepKey=[Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($sleepKeyPath)
    try{
        $index=1
        while($sleepKey.GetValueNames() -contains [string]$index){$index++}
        $sleepKey.SetValue([string]$index,'[*.]goodreads.com',[Microsoft.Win32.RegistryValueKind]::String)
    }finally{$sleepKey.Dispose()}
}
$taskName='Goodreads VM workflow'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing){
    if(@($existing.Actions).Count -ne 1 -or $existing.Actions.Arguments -notlike ('*'+$wrapper+'*')){throw 'An unrelated task uses the guest workflow name.'}
    Export-ScheduledTask -TaskName $taskName|Set-Content -LiteralPath (Join-Path $archive 'guest-task.xml')
}
[IO.File]::WriteAllText($settingsPath,($settings|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
if($admin){
    $acl=Get-Acl -LiteralPath $settingsPath
    $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User,'Modify','Allow'))
    Set-Acl -LiteralPath $settingsPath -AclObject $acl
}
$action=New-ScheduledTaskAction -Execute $pythonw -Argument ('"'+$wrapper+'" --settings "'+$settingsPath+'" --listen') -WorkingDirectory $root
$logon=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$poll=New-ScheduledTaskTrigger -Once -At ([DateTime]::Today) -RepetitionInterval (New-TimeSpan -Minutes 1)
$poll.StartBoundary=[DateTime]::Today.ToString("yyyy-MM-dd'T'HH:mm:ss")
$principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$taskSettings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon,$poll) -Principal $principal -Settings $taskSettings -Description 'Poll for a Hyper-V host request in the signed-in interactive console. Run one completion-ordered queue; the host receives reports before deciding shutdown.' -Force|Out-Null
# The listener must remain available to publish a fresh disabled/skip result.
Enable-ScheduledTask -TaskName $taskName|Out-Null
$taskInfo=Get-ScheduledTaskInfo -TaskName $taskName
@{state='installed';version='2026.11.02.2';at=[DateTimeOffset]::Now.ToString('o');timeZone=(Get-TimeZone).Id;identity=$identity.Name;taskState=[string](Get-ScheduledTask -TaskName $taskName).State;taskXml=(Export-ScheduledTask -TaskName $taskName);lastRunTime=$taskInfo.LastRunTime.ToString('o');lastTaskResult=$taskInfo.LastTaskResult;profiles=$daily.profiles}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $output 'installation.json') -Encoding UTF8
if($VerifyOnly){& $python $wrapper --settings $settingsPath --verify-only --keep-running;if($LASTEXITCODE -ne 0){throw 'Guest setup verification failed.'}}
Write-Output "Installed guest adapter 2026.11.02.2; task enabled: $($settings.enabled). Existing browser and macro settings preserved."
