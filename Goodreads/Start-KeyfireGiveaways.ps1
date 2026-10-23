param(
    [switch]$CheckOnly,
    [switch]$InstallStartup,
    [switch]$PrepareOnly,
    [switch]$Restart,
    [string]$ConfigPath,
    [string]$MacroName,
    [string]$Profile
)

$ErrorActionPreference = 'Stop'
$helperPath = Join-Path $PSScriptRoot 'KeyfireGiveaways.py'
$pythonPath = (& python -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonPath)) {
    throw 'Python 3 is required to run the Goodreads Keyfire helper.'
}
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $env:APPDATA 'com.nodescaffold.trigr\keyforge-config.json'
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$checkArguments = @($helperPath, '--config', $ConfigPath, '--check')
if ($MacroName) { $checkArguments += @('--macro-name', $MacroName) }
if ($Profile) { $checkArguments += @('--profile', $Profile) }
& $pythonPath @checkArguments
if ($LASTEXITCODE -ne 0) {
    throw 'The saved Goodreads Keyfire workflow could not be loaded. No helper was started.'
}
if ($CheckOnly) { return }

$companionPath = Join-Path $env:LOCALAPPDATA 'GoodreadsKeyfireCompanion'
New-Item -ItemType Directory -Path $companionPath -Force | Out-Null
$pairingPath = Join-Path $companionPath 'pairing-key.txt'
if (Test-Path -LiteralPath $pairingPath) {
    $pairingKey = (Get-Content -Raw -LiteralPath $pairingPath).Trim()
    if ($pairingKey -notmatch '^[a-f0-9]{64}$') { throw 'The local pairing key is invalid.' }
} else {
    $randomBytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
    $pairingKey = [BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
    [IO.File]::WriteAllText($pairingPath, $pairingKey, (New-Object Text.UTF8Encoding $false))
}
$scriptPath = Join-Path $PSScriptRoot 'Giveaways.js'
$preparedScriptPath = Join-Path $companionPath 'Giveaways.user.js'
$source = Get-Content -Raw -Encoding UTF8 -LiteralPath $scriptPath
[IO.File]::WriteAllText($preparedScriptPath, $source, (New-Object Text.UTF8Encoding $false))
Write-Output "Install this userscript in Tampermonkey: $preparedScriptPath"
if ($PrepareOnly) { return }

$pythonwPath = Join-Path (Split-Path -Parent $pythonPath) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonwPath)) {
    throw 'pythonw.exe was not found beside python.exe.'
}
$runtimeArguments = '"' + $helperPath + '" --config "' + $ConfigPath + '"'
if ($InstallStartup) {
    $startupPath = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startupPath 'Goodreads Keyfire helper.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $pythonwPath
    $shortcut.Arguments = $runtimeArguments
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Follow the saved Goodreads Keyfire workflow in ready giveaway tabs.'
    $shortcut.Save()
    Write-Output "Start with Windows: $shortcutPath"
}
if ($Restart) {
    $helperPattern = '(?i)(?:^|[\s"])' + [regex]::Escape($helperPath) + '(?:[\s"]|$)'
    $running = @(Get-CimInstance Win32_Process -Filter "name='pythonw.exe'" | Where-Object {
        $_.CommandLine -match $helperPattern
    })
    foreach ($process in $running) {
        Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        Wait-Process -Id $process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
}
Start-Process -FilePath $pythonwPath -ArgumentList $runtimeArguments -WindowStyle Hidden
Write-Output 'Goodreads Keyfire helper started. It waits until Use Keyfire workflow is enabled on the giveaway page.'
