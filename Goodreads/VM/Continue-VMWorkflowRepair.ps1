param(
    [string]$GuestUserName='Auto_Station\dstates',
    [Parameter(Mandatory=$true)][string]$StateDirectory,
    [Parameter(Mandatory=$true)][string]$ToolsArchive,
    [Parameter(Mandatory=$true)][string]$PythonRuntimePath,
    [Parameter(Mandatory=$true)][string]$ReportPackagesPath,
    [string]$SettingsPath="$env:ProgramData\GoodreadsGiveawaysVM\vm-settings.json",
    [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
if(-not $CheckOnly){Assert-VMAdministrator}
$maintenanceSourceRoot=$PSScriptRoot
$source=Split-Path -Parent $PSScriptRoot
$settings=Read-VMSettings $SettingsPath
$statusPath=Join-Path $StateDirectory 'update-status.json'
$commandPath=Join-Path $StateDirectory 'update-command.json'
New-Item -ItemType Directory -Path $StateDirectory -Force|Out-Null
$status=[ordered]@{startedAt=[DateTimeOffset]::Now.ToString('o');state='waiting-for-guest-password'}
$session=$credential=$null
$verified=$false
# Reuse the reviewed interactive verification and cold-boot test implementation.
$tokens=$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Update-VMWorkflow.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'The maintenance source did not parse.'}
foreach($name in @('Save-UpdateStatus','Connect-UpdateGuest','Copy-UpdateSources','Invoke-UpdateInteractive')){
    $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    if(-not $definition){throw 'Missing maintenance function.'}
    . ([scriptblock]::Create($definition.Extent.Text.Replace('$PSScriptRoot','$maintenanceSourceRoot')))
}
$smoke=$ast.Find({param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and @($node.Clauses|Where-Object{$_.Item1.Extent.Text -eq "`$command.action -eq 'smoke'"}).Count -gt 0},$true)
$smokeBody=($smoke.Clauses|Where-Object{$_.Item1.Extent.Text -eq "`$command.action -eq 'smoke'"}).Item2.Extent.Text
if(-not $smokeBody){throw 'Missing cold-boot smoke implementation.'}
$smokeAction=[scriptblock]::Create($smokeBody.Substring(1,$smokeBody.Length-2).Replace('$PSScriptRoot','$maintenanceSourceRoot'))
if($CheckOnly){
    $script:sourceChecks=0
    function Copy-Item {
        param($ToSession,$LiteralPath,$Destination,[switch]$Force)
        if(-not(Test-Path -LiteralPath $LiteralPath -PathType Leaf)){throw "Missing maintenance source: $LiteralPath"}
        if(-not $Destination.StartsWith('C:\GoodreadsVM\')){throw 'Unexpected guest destination.'}
        $script:sourceChecks++
    }
    Copy-UpdateSources
    foreach($name in @('Install-VMHost.ps1','Invoke-VMWorkflow.ps1')){
        if(-not(Test-Path -LiteralPath (Join-Path $maintenanceSourceRoot $name))){throw 'Missing lifecycle source.'}
    }
    if($script:sourceChecks -ne 4){throw 'Not every source was validated.'}
    Write-Output 'Maintenance function source paths and cold-boot source resolve correctly.'
    exit 0
}
try{
    Save-UpdateStatus
    Write-Host 'Enter the VM password once. This repair uses guest-side APIs and keeps it only in memory.'
    $secret=Read-Host "Password for $GuestUserName" -AsSecureString
    $credential=[pscredential]::new($GuestUserName,$secret);$secret=$null
    $vm=Get-OwnedGiveawaysVM $settings
    if([string]$vm.State -in @('Off','Saved')){Start-VM -VM $vm}
    $session=Connect-UpdateGuest
    Invoke-Command -Session $session -ScriptBlock{Disable-ScheduledTask -TaskName 'Goodreads VM workflow'|Out-Null}
    Copy-UpdateSources
    $status.state='connected';Save-UpdateStatus
    $lastId=''
    if(Test-Path -LiteralPath $commandPath){$lastId=(Get-Content -LiteralPath $commandPath -Raw|ConvertFrom-Json).id}
    $deadline=[DateTimeOffset]::Now.AddHours(3)
    while([DateTimeOffset]::Now -lt $deadline){
        Start-Sleep -Seconds 2
        if(-not(Test-Path -LiteralPath $commandPath)){continue}
        $command=Get-Content -LiteralPath $commandPath -Raw|ConvertFrom-Json
        if(-not $command.id -or $command.id -eq $lastId){continue}
        $lastId=$command.id;$status.commandId=$lastId
        try{
            if($command.action -eq 'inspect'){
                $status.guest=Invoke-Command -Session $session -ScriptBlock{
                    [pscustomobject]@{
                        verification=(Get-Content -LiteralPath 'C:\GoodreadsVM\output\daily-verification.json' -Raw|ConvertFrom-Json)
                        vm=(Get-Content -LiteralPath 'C:\GoodreadsVM\output\vm-last-run.json' -Raw|ConvertFrom-Json)
                        processes=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -in @('msedge.exe','python.exe','pythonw.exe')}|Select-Object Name,ProcessId,SessionId)
                        mainTask=[string](Get-ScheduledTask -TaskName 'Goodreads VM workflow').State
                    }
                };$status.state='inspected'
            }elseif($command.action -eq 'configure-updates'){
                $status.state='configuring-updates';Save-UpdateStatus
                Copy-UpdateSources
                Copy-Item -ToSession $session -LiteralPath $ToolsArchive -Destination 'C:\GoodreadsVM\output\update-tools.zip' -Force
                $status.autoUpdates=Invoke-Command -Session $session -ScriptBlock{
                    $ErrorActionPreference='Stop'
                    $computer=Get-CimInstance Win32_ComputerSystem
                    if($computer.Manufacturer -ne 'Microsoft Corporation' -or $computer.Model -ne 'Virtual Machine'){throw 'Dedicated VM only.'}
                    if(@(Get-CimInstance Win32_Process|Where-Object{$_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -match '(DailyGiveaways\.py|GuestWorkflow\.py)'}).Count){throw 'A queue is still active.'}
                    $daily=Get-Content -LiteralPath 'C:\GoodreadsVM\output\daily-settings.json' -Raw|ConvertFrom-Json
                    foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"|Where-Object{$_.ExecutablePath -eq $daily.edgePath})){
                        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
                    }
                    Start-Sleep -Seconds 2
                    if(@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"|Where-Object{$_.ExecutablePath -eq $daily.edgePath}).Count){throw 'Edge must be fully closed before changing its extension settings.'}
                    $tools='C:\GoodreadsVM\output\maintenance'
                    Expand-Archive -LiteralPath 'C:\GoodreadsVM\output\update-tools.zip' -DestinationPath $tools -Force
                    $result=& (Join-Path $tools 'node.exe') (Join-Path $tools 'Configure-TampermonkeyUpdates.cjs') 'C:\GoodreadsVM\output\daily-settings.json' (Join-Path $tools 'node_modules')
                    if($LASTEXITCODE -ne 0){throw ($result|Out-String)}
                    $configPath='C:\GoodreadsVM\guest-settings.json'
                    $config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
                    $config|Add-Member -Force NoteProperty recoverFailedProfiles $true
                    $config|Add-Member -Force NoteProperty preflightUserScriptUpdates $true
                    [IO.File]::WriteAllText($configPath,($config|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
                    return $result|ConvertFrom-Json
                }
                if(@($status.autoUpdates).Count -ne 3){throw 'Expected all three profiles to be configured.'}
                $status.state='updates-configured'
            }elseif($command.action -eq 'verify'){
                $status.state='verifying-guest';Save-UpdateStatus
                try{$status.verification=Invoke-UpdateInteractive 'verify'}catch{
                    $status.verification=Invoke-Command -Session $session -ScriptBlock{Get-Content -LiteralPath 'C:\GoodreadsVM\output\daily-verification.json' -Raw|ConvertFrom-Json}
                    throw
                }
                $profiles=@($status.verification.profiles)
                if($profiles.Count -ne 3 -or @($profiles|Where-Object{$_.state -ne 'verified' -or $_.listingClosed -ne $true -or $_.capabilities.addressSubmitRetrySupported -ne $true -or $_.capabilities.failureCleanupSupported -ne $true}).Count){throw 'All three profiles must verify.'}
                $verified=$true;$status.state='guest-verified'
            }elseif($command.action -eq 'copy'){Copy-UpdateSources;$status.state='connected'}
            elseif($command.action -eq 'smoke'){. $smokeAction}
            elseif($command.action -eq 'abort'){break}
            else{throw 'Unknown maintenance action.'}
            $status.Remove('error')
        }catch{$status.state='command-failed';$status.error=$_.Exception.Message}
        Save-UpdateStatus
        if($status.state -eq 'complete'){break}
    }
}catch{$status.state='failed';$status.error=$_.Exception.Message;Save-UpdateStatus}
finally{
    if($session){Remove-PSSession $session -ErrorAction SilentlyContinue}
    $credential=$null;$status.closedAt=[DateTimeOffset]::Now.ToString('o');Save-UpdateStatus
}
