$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VM.Common.ps1')
$script:checks = 0
function Assert-Check($Condition, $Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Assert-Rejected([scriptblock]$Action, $MessagePattern) {
    $rejected = $false
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message -notmatch $MessagePattern) { throw }
        $rejected = $true
    }
    Assert-Check $rejected 'Expected this operation to be rejected.'
}

$scratch = Join-Path $env:TEMP ('goodreads-vm-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    $path = Join-Path $scratch 'settings.json'
    $settings = Read-VMSettings (Join-Path $PSScriptRoot 'vm-settings.example.json')
    $settings.vmId = [guid]::NewGuid().ToString()
    Write-VMJson $path $settings
    Assert-Check ((Read-VMSettings $path).vmId -eq $settings.vmId) 'Settings round trip failed.'
    foreach ($change in @(
        @{ field = 'diskPath'; value = 'C:\HyperV\GoodreadsGiveaways-other\Windows.vhdx'; error = 'inside its storage' },
        @{ field = 'diskPath'; value = 'C:\HyperV\GoodreadsGiveaways\..\other.vhdx'; error = 'inside its storage' },
        @{ field = 'diskPath'; value = 'C:\HyperV\GoodreadsGiveaways\Windows.vhd'; error = 'inside its storage' },
        @{ field = 'storageRoot'; value = '\\server\share'; error = 'absolute local' },
        @{ field = 'vmId'; value = 'invalid'; error = 'identity' },
        @{ field = 'processors'; value = 0; error = 'Invalid VM settings' },
        @{ field = 'processors'; value = 2.5; error = 'whole numbers' },
        @{ field = 'maximumRuntimeMinutes'; value = 10000; error = 'Invalid VM settings' }
    )) {
        $candidate = $settings | ConvertTo-Json | ConvertFrom-Json
        $candidate.($change.field) = $change.value
        Write-VMJson $path $candidate
        Assert-Rejected { Read-VMSettings $path } $change.error
    }
    $script:fakeVM = [pscustomobject]@{ Id = [guid]$settings.vmId; Name = $settings.vmName; Notes = 'Managed by Goodreads giveaway VM workflow'; State = 'Off' }
    $script:fakeDisks = @([pscustomobject]@{ Path = $settings.diskPath })
    function Get-VM { [CmdletBinding()]param($Id) return $script:fakeVM }
    function Get-VMHardDiskDrive { [CmdletBinding()]param($VM) return $script:fakeDisks }
    $script:starts = $script:resumes = 0
    function Start-VM { param($VM) $script:starts++ }
    function Resume-VM { param($VM) $script:resumes++ }
    foreach ($state in @('Running', 'Off')) {
        $script:fakeVM.State = $state
        $script:starts = $script:resumes = 0
        $wake = Start-GiveawaysMorningVM $settings
        Assert-Check ($wake.previousState -eq $state) 'VM wake report lost the original state.'
        Assert-Check ($script:starts -eq [int]($state -eq 'Off')) 'VM was started in an unexpected state.'
        Assert-Check ($script:resumes -eq 0) 'VM was resumed in an unexpected state.'
    }
    foreach ($state in @('Saved', 'Paused')) {
        $script:fakeVM.State = $state
        $script:starts = $script:resumes = 0
        Assert-Rejected { Start-GiveawaysMorningVM $settings } 'left alone'
        Assert-Check ($script:starts -eq 0 -and $script:resumes -eq 0) 'Unfinished work must never resume automatically.'
    }
    $script:fakeVM.State = 'Stopping'
    Assert-Rejected { Start-GiveawaysMorningVM $settings } 'left alone'
    $script:fakeVM.State = 'Off'
    Assert-Check ((Get-OwnedGiveawaysVM $settings).Id -eq $settings.vmId) 'Owned VM was not selected.'
    $script:fakeVM.Name = 'AnotherVM'
    Assert-Rejected { Get-OwnedGiveawaysVM $settings } 'ownership marker'
    $script:fakeVM.Name = $settings.vmName
    $script:fakeVM.Notes = 'Unrelated VM'
    Assert-Rejected { Get-OwnedGiveawaysVM $settings } 'ownership marker'
    $script:fakeVM.Notes = 'Managed by Goodreads giveaway VM workflow'
    $script:fakeDisks = @([pscustomobject]@{ Path = 'C:\HyperV\other.vhdx' })
    Assert-Rejected { Get-OwnedGiveawaysVM $settings } 'disk changed'
    $script:fakeDisks = @([pscustomobject]@{ Path = $settings.diskPath }, [pscustomobject]@{ Path = 'C:\HyperV\other.vhdx' })
    Assert-Rejected { Get-OwnedGiveawaysVM $settings } 'disk changed'
    $script:fakeDisks = @([pscustomobject]@{ Path = $settings.diskPath })
    $script:vhdReads = 0
    $script:vhdAttached = $false
    function Get-VHD { [CmdletBinding()]param($Path) $script:vhdReads++; return [pscustomobject]@{ Attached = $script:vhdAttached } }
    foreach ($state in @('Running', 'Saved', 'Paused')) {
        $script:fakeVM.State = $state
        Assert-Rejected { Export-VMGuestReports $settings } 'only after the VM shuts down'
        Assert-Check ($script:vhdReads -eq 0) 'An active or saved guest disk must not be inspected or attached.'
    }
    $script:fakeVM.State = 'Off'
    $script:vhdAttached = $true
    Assert-Rejected { Export-VMGuestReports $settings } 'already attached'
    $script:vhdAttached = $false
    $script:dismounts = 0
    function Mount-VHD {
        [CmdletBinding()]param($Path, [switch]$ReadOnly, [switch]$NoDriveLetter, [switch]$Passthru)
        Assert-Check ($ReadOnly -and $NoDriveLetter) 'Report extraction must mount read-only without drive letters.'
        return [pscustomobject]@{ DiskNumber = 65000 }
    }
    function Get-Disk { [CmdletBinding()]param([Parameter(ValueFromPipeline = $true)]$InputObject) process { return [pscustomobject]@{ Number = 65000 } } }
    function Get-Partition { [CmdletBinding()]param($DiskNumber) return @() }
    function Dismount-VHD { [CmdletBinding()]param($Path) $script:dismounts++ }
    $settings.reportDirectory = Join-Path $scratch 'reports'
    Assert-Rejected { Export-VMGuestReports $settings } 'one Windows data partition'
    Assert-Check ($script:dismounts -eq 1) 'A failed report extraction must detach the VHD.'
    Assert-Check (@(Get-ChildItem -LiteralPath $scratch -Directory).Count -eq 0) 'A failed extraction left a mount folder behind.'

    Assert-Rejected { Protect-VMStorage ([IO.Path]::GetPathRoot($scratch)) ([Security.Principal.WindowsIdentity]::GetCurrent().User) } 'drive root'
    $guestRoot = Join-Path $scratch 'guest'
    $guestDirectory = Join-Path $guestRoot 'GoodreadsVM'
    $guestOutput = Join-Path $guestDirectory 'output'
    $outside = Join-Path $scratch 'outside'
    $guestFile = Join-Path $guestOutput 'vm-last-run.json'
    $outsideFile = Join-Path $outside 'vm-last-run.json'
    try {
        New-Item -ItemType Directory -Path $guestOutput, $outside -Force | Out-Null
        [IO.File]::WriteAllText($guestFile, '{}')
        [IO.File]::WriteAllText($outsideFile, 'outside sentinel')
        Assert-Check ((Get-VMGuestReportFile $guestRoot 'vm-last-run.json').FullName -eq $guestFile) 'A regular report was not accepted.'
        Assert-Check ($null -eq (Get-VMGuestReportFile $guestRoot 'daily.log')) 'A missing report should be skipped.'
        Assert-Rejected { Get-VMGuestReportFile $guestRoot '..\outside\vm-last-run.json' } 'Unknown guest report'
        $stream = [IO.File]::OpenWrite($guestFile)
        try { $stream.SetLength(10MB + 1) } finally { $stream.Dispose() }
        Assert-Rejected { Get-VMGuestReportFile $guestRoot 'vm-last-run.json' } 'oversized'
        Remove-Item -LiteralPath $guestFile
        [IO.Directory]::Delete($guestOutput)
        New-Item -ItemType Junction -Path $guestOutput -Target $outside | Out-Null
        Assert-Rejected { Get-VMGuestReportFile $guestRoot 'vm-last-run.json' } 'reparse points'
        [IO.Directory]::Delete($guestOutput)
        [IO.Directory]::Delete($guestDirectory)
        New-Item -ItemType Junction -Path $guestDirectory -Target $outside | Out-Null
        Assert-Rejected { Get-VMGuestReportFile $guestRoot 'vm-last-run.json' } 'reparse points'
        Assert-Check (([IO.File]::ReadAllText($outsideFile)) -eq 'outside sentinel') 'The outside target must not change.'
    } finally {
        foreach ($link in @($guestOutput, $guestDirectory)) {
            if (Test-Path -LiteralPath $link) {
                $item = Get-Item -LiteralPath $link -Force
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($link) }
            }
        }
        foreach ($file in @($guestFile, $outsideFile)) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file } }
        foreach ($directory in @($guestOutput, $guestDirectory, $guestRoot, $outside)) {
            if (Test-Path -LiteralPath $directory) { [IO.Directory]::Delete($directory) }
        }
    }
} finally {
    Get-ChildItem -LiteralPath $scratch -File | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
    Remove-Item -LiteralPath $scratch
}
Write-Output "$script:checks PowerShell VM safety checks passed. No real VM or virtual disk was touched."
