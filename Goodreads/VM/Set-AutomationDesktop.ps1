param(
    [Parameter(Mandatory=$true)][string]$WindowsDirectory,
    [Parameter(Mandatory=$true)][string]$UserProfileDirectory,
    [Parameter(Mandatory=$true)][string]$UserSid,
    [Parameter(Mandatory=$true)][string]$ReportPath,
    [ValidateSet('Keep','DownloadOnly')][string]$UpdateMode='Keep',
    [switch]$Apply
)
$ErrorActionPreference='Stop'
# Run against the mounted disk of an OFF automation VM. Never configure the
# operator's desktop. The caller owns Hyper-V readiness and mounting.
$windows=[IO.Path]::GetFullPath($WindowsDirectory).TrimEnd('\')
$targetProfilePath=[IO.Path]::GetFullPath($UserProfileDirectory).TrimEnd('\')
if($windows -eq [IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\') -or
   [IO.Path]::GetPathRoot($windows) -ne [IO.Path]::GetPathRoot($targetProfilePath) -or
   $UserSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$'){
    throw 'Expected an offline Windows disk and its explicitly identified automation account.'
}
$softwareFile=Join-Path $windows 'System32\config\SOFTWARE'
$userFile=Join-Path $targetProfilePath 'NTUSER.DAT'
if(-not(Test-Path -LiteralPath $softwareFile -PathType Leaf) -or -not(Test-Path -LiteralPath $userFile -PathType Leaf)){
    throw 'The offline registry hives are missing; no policy was changed.'
}
if(Test-Path -LiteralPath $ReportPath){throw 'Preserve the existing policy report and choose a new report path.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'Offline registry maintenance requires an elevated host process.'
}
$suffix=[guid]::NewGuid().ToString('N')
$machineName='GAD_'+$suffix.Substring(0,8);$userName='GAU_'+$suffix.Substring(0,8)
$loadedMachine=$loadedUser=$false;$machine=$user=$null;$changed=@()
function Read-PolicyValue($Root,[string]$Path,[string]$Name){
    $key=$Root.OpenSubKey($Path)
    try{
        if(-not $key -or $key.GetValueNames() -notcontains $Name){return @{exists=$false;value=$null;kind=$null}}
        return @{exists=$true;value=$key.GetValue($Name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=[string]$key.GetValueKind($Name)}
    }finally{if($key){$key.Dispose()}}
}
function Set-PolicyValue($Root,$Change,$Value){
    $key=$Root.CreateSubKey($Change.path)
    try{
        if($Value.exists){$key.SetValue($Change.name,$Value.value,[Microsoft.Win32.RegistryValueKind]$Value.kind)}
        else{$key.DeleteValue($Change.name,$false)}
    }finally{$key.Dispose()}
}
try{
    $loadOutput=& "$env:SystemRoot\System32\reg.exe" load ('HKLM\'+$machineName) $softwareFile 2>&1
    if($LASTEXITCODE -ne 0){throw ('Could not load the offline machine hive: '+($loadOutput -join ' '))};$loadedMachine=$true
    $loadOutput=& "$env:SystemRoot\System32\reg.exe" load ('HKU\'+$userName) $userFile 2>&1
    if($LASTEXITCODE -ne 0){throw ('Could not load the offline user hive: '+($loadOutput -join ' '))};$loadedUser=$true
    $machine=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($machineName,$true)
    $user=[Microsoft.Win32.Registry]::Users.OpenSubKey($userName,$true)
    $mapped=(Read-PolicyValue $machine ('Microsoft\Windows NT\CurrentVersion\ProfileList\'+$UserSid) 'ProfileImagePath').value
    if(-not $mapped -or $mapped.Substring(2) -ne $targetProfilePath.Substring(2)){throw 'The account SID does not identify this offline profile.'}
    $edition=(Read-PolicyValue $machine 'Microsoft\Windows NT\CurrentVersion' 'EditionID').value
    $build=(Read-PolicyValue $machine 'Microsoft\Windows NT\CurrentVersion' 'CurrentBuild').value
    if($edition -notmatch '^(Professional|Enterprise|Education|IoTEnterprise)'){throw 'Verify policy support for this Windows edition before applying automation settings.'}
    $plan=@(
        @{hive='machine';path='Policies\Microsoft\Windows\CurrentVersion\PushNotifications';name='NoToastApplicationNotification';value=1},
        @{hive='user';path='Software\Policies\Microsoft\Windows\CurrentVersion\PushNotifications';name='NoToastApplicationNotification';value=1},
        @{hive='machine';path='Policies\Microsoft\OneDrive';name='KFMBlockOptIn';value=1},
        @{hive='machine';path='Policies\Microsoft\OneDrive';name='DisableNewAccountDetection';value=1},
        @{hive='machine';path='Policies\Microsoft\OneDrive';name='PreventNetworkTrafficPreUserSignIn';value=1}
    )
    if([int]$build -ge 26100){$plan+=@{hive='user';path='Software\Policies\Microsoft\Windows\CurrentVersion\AccountNotifications';name='DisableAccountNotifications';value=1}}
    foreach($name in @('KFMOptInWithWizard','KFMSilentOptIn')){
        $existing=Read-PolicyValue $machine 'Policies\Microsoft\OneDrive' $name
        if($existing.exists -and $existing.value){throw 'An existing OneDrive folder-redirection policy conflicts; preserve it for review.'}
    }
    $updateRoot='Policies\Microsoft\Windows\WindowsUpdate'
    if($UpdateMode -eq 'DownloadOnly'){
        # A deadline can override download/install/reboot choices. Do not
        # silently promise protection when another management policy owns it.
        foreach($path in @($updateRoot,'Microsoft\PolicyManager\current\device\Update')){
            $key=$machine.OpenSubKey($path)
            try{if($key -and @($key.GetValueNames()|Where-Object{$_ -match '^ConfigureDeadline' -and $key.GetValue($_)}).Count){throw 'An existing update deadline policy requires review before planned-maintenance mode.'}}finally{if($key){$key.Dispose()}}
        }
        $plan+=@(
            @{hive='machine';path=($updateRoot+'\AU');name='NoAutoUpdate';value=0},
            @{hive='machine';path=($updateRoot+'\AU');name='AUOptions';value=3},
            @{hive='machine';path=$updateRoot;name='SetActiveHours';value=1},
            @{hive='machine';path=$updateRoot;name='ActiveHoursStart';value=3},
            @{hive='machine';path=$updateRoot;name='ActiveHoursEnd';value=21}
        )
    }
    $rebootPending=@()
    foreach($path in @('Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending','Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')){
        $key=$machine.OpenSubKey($path);if($key){$rebootPending+=$path;$key.Dispose()}
    }
    foreach($change in $plan){
        $root=if($change.hive -eq 'machine'){$machine}else{$user}
        $change.before=Read-PolicyValue $root $change.path $change.name
    }
    $report=@{version='2026.11.02.1';state='planned';at=[DateTimeOffset]::Now.ToString('o');edition=$edition;build=$build;userSid=$UserSid;windowsDirectory=$windows;userProfileDirectory=$targetProfilePath;updateMode=$UpdateMode;pendingReboot=$rebootPending;changes=$plan;note='These settings suppress guest toasts and OneDrive setup prompts. DownloadOnly requires deliberate update installation/restart during idle maintenance; it does not disable Windows Update or Defender. Active hours alone do not protect an arbitrarily long run.'}
    $parent=Split-Path -Parent ([IO.Path]::GetFullPath($ReportPath));New-Item -ItemType Directory -Path $parent -Force|Out-Null
    $report|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $ReportPath -Encoding UTF8
    if($Apply){
        try{
            foreach($change in $plan){
                $root=if($change.hive -eq 'machine'){$machine}else{$user}
                $changed+=,$change
                Set-PolicyValue $root $change @{exists=$true;value=$change.value;kind='DWord'}
                $after=Read-PolicyValue $root $change.path $change.name
                if(-not $after.exists -or $after.kind -ne 'DWord' -or $after.value -ne $change.value){throw ('Policy readback failed: '+$change.name)}
                $change.after=$after
            }
            $report.state='applied';$report.appliedAt=[DateTimeOffset]::Now.ToString('o')
        }catch{
            for($i=$changed.Count-1;$i -ge 0;$i--){$change=$changed[$i];$root=if($change.hive -eq 'machine'){$machine}else{$user};Set-PolicyValue $root $change $change.before}
            $report.state='rolled-back';$report.reason=$_.Exception.Message;throw
        }finally{$report|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $ReportPath -Encoding UTF8}
    }
    $report
}finally{
    if($user){$user.Dispose()};if($machine){$machine.Dispose()}
    if($loadedUser){& "$env:SystemRoot\System32\reg.exe" unload ('HKU\'+$userName)|Out-Null;if($LASTEXITCODE -ne 0){Write-Error 'The offline user hive did not unload; preserve the disk mount.'}}
    if($loadedMachine){& "$env:SystemRoot\System32\reg.exe" unload ('HKLM\'+$machineName)|Out-Null;if($LASTEXITCODE -ne 0){Write-Error 'The offline machine hive did not unload; preserve the disk mount.'}}
}
