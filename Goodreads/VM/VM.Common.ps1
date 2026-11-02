function Assert-VMAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script as Administrator.'
    }
}

function Write-VMJson($Path, $Value) {
    $parent=Split-Path -Parent $Path
    if($parent){New-Item -ItemType Directory -Path $parent -Force|Out-Null}
    $temporary = $Path + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $deadline=[DateTimeOffset]::Now.AddSeconds(5)
    while($true){
        try{Move-Item -LiteralPath $temporary -Destination $Path -Force -ErrorAction Stop;break}
        catch{
            if(($_.Exception.HResult -band 65535) -notin @(5,32,33) -or [DateTimeOffset]::Now -ge $deadline){throw}
            Start-Sleep -Milliseconds 50
        }
    }
}

function Protect-VMStorage($Path, [Security.Principal.SecurityIdentifier]$OwnerSid) {
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($fullPath -eq [IO.Path]::GetPathRoot($fullPath).TrimEnd('\')) { throw 'A drive root cannot be used as the VM storage folder.' }
    New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
    $directory = Get-Item -LiteralPath $fullPath -Force
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'VM storage cannot be a link or reparse point.' }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @($OwnerSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $fullPath -AclObject $acl
}

function Get-VMGuestReportFile($MountPath, $Name) {
    if ($Name -notin @('vm-last-run.json', 'vm-last-skip.json', 'daily-incomplete.json', 'daily-last-run.json', 'daily-verification.json', 'daily.log', 'vm-runner.log')) {
        throw 'Unknown guest report file.'
    }
    $path = $MountPath
    # The host-created mount point is trusted. Every component inside the guest
    # must be an ordinary directory/file so guest links cannot reach host paths.
    foreach ($component in @('GoodreadsVM', 'output', $Name)) {
        $path = Join-Path $path $component
        try { $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop } catch [System.Management.Automation.ItemNotFoundException] { return $null }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Guest report links and reparse points are not allowed.' }
        if ($component -ne $Name -and -not $item.PSIsContainer) { throw 'Invalid guest report directory.' }
    }
    if ($item.PSIsContainer -or $item.Length -gt 10MB) { throw 'Invalid or oversized guest report file.' }
    return $item
}

function Read-VMSettings($Path) {
    $settings = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($field in @('memoryGB', 'processors', 'diskGB')) {
        if ($settings.$field -isnot [int] -and $settings.$field -isnot [long]) { throw 'VM resource limits must be whole numbers.' }
    }
    if ($settings.PSObject.Properties.Name -contains 'recoverSavedFailures' -and $settings.recoverSavedFailures -isnot [bool]) {
        throw 'Saved failure recovery must be a boolean.'
    }
    if ($settings.schema -ne 1 -or $settings.vmName -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$' -or
        $settings.memoryGB -lt 4 -or $settings.memoryGB -gt 16 -or
        $settings.processors -lt 2 -or $settings.processors -gt 8 -or
        $settings.diskGB -lt 64 -or $settings.diskGB -gt 256) {
        throw 'Invalid VM settings.'
    }
    foreach ($pathValue in @($settings.storageRoot, $settings.diskPath, $settings.reportDirectory)) {
        if ($pathValue -notmatch '^[A-Za-z]:\\[^\\]') { throw 'Use absolute local paths for VM storage and reports.' }
    }
    $root = [IO.Path]::GetFullPath($settings.storageRoot).TrimEnd('\')
    if (-not [IO.Path]::GetFullPath($settings.diskPath).StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetExtension($settings.diskPath) -ne '.vhdx') {
        throw 'The VM disk must be a VHDX inside its storage folder.'
    }
    if ($settings.vmId -and -not [guid]::TryParse($settings.vmId, [ref]([guid]::Empty))) { throw 'Invalid VM identity.' }
    [void][DateTime]::ParseExact($settings.hostStartAt, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    return $settings
}

function Get-OwnedGiveawaysVM($Settings) {
    if (-not $Settings.vmId) { throw 'Create the VM after restarting Windows before running its workflow.' }
    $vm = Get-VM -Id ([guid]$Settings.vmId) -ErrorAction Stop
    if ($vm.Name -ne $Settings.vmName -or $vm.Notes -ne 'Managed by Goodreads giveaway VM workflow') {
        throw 'The VM identity or ownership marker changed. No VM action was taken.'
    }
    $disks = @(Get-VMHardDiskDrive -VM $vm)
    if ($disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne [IO.Path]::GetFullPath($Settings.diskPath)) {
        throw 'The VM disk changed. No VM action was taken.'
    }
    return $vm
}

function Start-GiveawaysMorningVM($Settings) {
    $vm = Get-OwnedGiveawaysVM $Settings
    $previousState = [string]$vm.State
    switch ($previousState) {
        'Running' { $action = 'already-running' }
        'Off' { Start-VM -VM $vm; $action = 'started' }
        'Saved' {
            # Resume the existing state. Never discard it, or shut it down merely
            # to obtain a fresh browser. Guest queue locks/markers remain intact.
            Start-VM -VM $vm
            $action = 'resumed'
        }
        default { throw "VM is $previousState; it was left alone. Inspect saved or paused unfinished work before resuming it manually." }
    }
    return [pscustomobject]@{ previousState = $previousState; action = $action }
}





function Export-VMGuestReports($Settings) {
    $vm = Get-OwnedGiveawaysVM $Settings
    if ([string]$vm.State -ne 'Off') { throw 'Reports can be read only after the VM shuts down.' }
    if ((Get-VHD -Path $Settings.diskPath).Attached) { throw 'The VM disk is already attached; it was not changed.' }
    $readerRoot = Split-Path -Parent $Settings.reportDirectory
    $reader = Join-Path $readerRoot 'Read-GuestReports.py'
    $python = Join-Path $readerRoot 'runtime\python.exe'
    if ((Test-Path -LiteralPath $reader) -and (Test-Path -LiteralPath $python)) {
        & $python $reader --disk $Settings.diskPath --output $Settings.reportDirectory
        if ($LASTEXITCODE -ne 0) { throw 'The read-only guest report reader failed; see its diagnostic output.' }
        return Get-Content -LiteralPath (Join-Path $Settings.reportDirectory 'vm-last-run.json') -Raw | ConvertFrom-Json
    }
    $mountPath = Join-Path (Split-Path -Parent $Settings.reportDirectory) ('mount-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $mountPath -Force | Out-Null
    $partition = $null
    $mounted = $false
    try {
        $disk = Mount-VHD -Path $Settings.diskPath -ReadOnly -NoDriveLetter -Passthru | Get-Disk
        $mounted = $true
        $partitions = @(Get-Partition -DiskNumber $disk.Number | Where-Object {
            $_.GptType -eq '{EBD0A0A2-B9E5-4433-87C0-68B6B72699C7}'
        })
        if ($partitions.Count -ne 1) { throw 'Expected one Windows data partition in the VM disk.' }
        $partition = $partitions[0]
        Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath ($mountPath + '\')
        New-Item -ItemType Directory -Path $Settings.reportDirectory -Force | Out-Null
        $result = @{}
        foreach ($name in @('vm-last-run.json', 'vm-last-skip.json', 'daily-incomplete.json', 'daily-last-run.json', 'daily-verification.json', 'daily.log', 'vm-runner.log')) {
            $file = Get-VMGuestReportFile $mountPath $name
            if ($file) {
                Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $Settings.reportDirectory $name) -Force
                if ($name -eq 'vm-last-run.json') { $result = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json }
            }
        }
        return $result
    } finally {
        if ($partition) {
            Remove-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -AccessPath ($mountPath + '\') -ErrorAction SilentlyContinue
        }
        if ($mounted) { Dismount-VHD -Path $Settings.diskPath -ErrorAction Stop }
        # This is a newly created, empty mount directory, never a recursive delete.
        Remove-Item -LiteralPath $mountPath -ErrorAction SilentlyContinue
    }
}
