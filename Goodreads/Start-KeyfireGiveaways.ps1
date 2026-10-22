param(
    [switch]$CheckOnly,
    [switch]$InstallStartup,
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$helperPath = Join-Path $PSScriptRoot 'KeyfireGiveaways.py'
$pythonPath = (& python -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonPath)) {
    throw 'Python 3 is required to run the Goodreads Keyfire helper.'
}
& $pythonPath $helperPath --check
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
$pairedScriptPath = Join-Path $companionPath 'Giveaways.user.js'
$source = Get-Content -Raw -Encoding UTF8 -LiteralPath $scriptPath
$placeholder = 'const KEYFIRE_PAIRING_KEY = "";'
if (-not $source.Contains($placeholder)) { throw 'The userscript pairing placeholder was not found.' }
$pairedSource = $source.Replace($placeholder, ('const KEYFIRE_PAIRING_KEY = "' + $pairingKey + '";'))
[IO.File]::WriteAllText($pairedScriptPath, $pairedSource, (New-Object Text.UTF8Encoding $false))
Write-Output "Install this paired file in Tampermonkey: $pairedScriptPath"
if ($PrepareOnly) { return }

$pythonwPath = Join-Path (Split-Path -Parent $pythonPath) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonwPath)) {
    throw 'pythonw.exe was not found beside python.exe.'
}
if ($InstallStartup) {
    $startupPath = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startupPath 'Goodreads Keyfire helper.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $pythonwPath
    $shortcut.Arguments = '"' + $helperPath + '"'
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Follow the saved Goodreads Keyfire workflow in ready giveaway tabs.'
    $shortcut.Save()
    Write-Output "Start with Windows: $shortcutPath"
}
Start-Process -FilePath $pythonwPath -ArgumentList ('"' + $helperPath + '"') -WindowStyle Hidden
Write-Output 'Goodreads Keyfire helper started. It waits until Use Keyfire workflow is enabled on the giveaway page.'
