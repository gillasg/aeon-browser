param([string]$BrowserRoot, [switch]$Update, [switch]$Unvirtualized, [string]$NodeExecutable, [string]$ImportDataFrom)
$ErrorActionPreference = 'Stop'
if (-not $Unvirtualized) {
    $setupNode = & node -p 'require("node:fs").realpathSync(process.execPath)'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the setup Node executable.' }
    $delegated = & (Join-Path $PSScriptRoot 'run-unvirtualized-setup.ps1') -Installer $PSCommandPath -BrowserRoot $BrowserRoot -NodeExecutable $setupNode.Trim() -Update:$Update
    if ($delegated) { return }
}
function Write-AtomicJson([string]$Path, $Value) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $backup = $temporary + '.previous'
    try {
        $json = $Value | ConvertTo-Json -Depth 5
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, $backup) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup }
    }
}
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
# Persist the actual installation, never an fnm shell junction that disappears on logout.
$node = if ($NodeExecutable) { $NodeExecutable } else { & node -p 'require("node:fs").realpathSync(process.execPath)' }
if ((-not $NodeExecutable -and $LASTEXITCODE -ne 0) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
    throw 'A permanent Node executable could not be resolved.'
}
$nodeFull = [IO.Path]::GetFullPath($node.Trim())
$nativeOutput = Join-Path $repoRoot 'apps\native-host\dist\aeon-native-host.exe'
$daemonEntry = Join-Path $repoRoot 'apps\daemon\dist\main.js'
$extensionManifest = if ($BrowserRoot) { Join-Path ([IO.Path]::GetFullPath($BrowserRoot)) 'apps\chrome-extension\native-dist\manifest.json' } else { $null }
$appRoot = Join-Path $env:LOCALAPPDATA 'Aeon'
$hostExecutable = Join-Path $appRoot 'aeon-native-host.exe'
$hostManifestPath = Join-Path $appRoot 'com.aeon.native_host.json'
$hostConfigPath = Join-Path $appRoot 'host-config.json'
$registrySubKey = 'Software\Google\Chrome\NativeMessagingHosts\com.aeon.native_host'
$expectedExtensionId = 'npcdopokfkpfmepknhoecppgdgmkmihh'
$expectedPublicKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA89DgbMVu50oH2AAiN0vILGKRKc2ePGR9r1W92yDIiVq9n1rxtqxQZSLsxPKuymvi3wB9hpo0h9vJ3++teaw8fqBllliSeELEAUmPNhauLcvlKe1nhkbgRf2wXilCUVI+zumNinkqw5h85rew1FI894ev8M9wWzSHm90eL9WILlWTrjhdaNTpMs2w9sF8GrsKj+sX1anF9/iUfZ9hbracUa47Z2b4KiviZp5SlF6o+0SwFHbeOVM0Aq2nHMFujmfaOcW7TkxDdPXBns2uRY1CTmRIyi3B1pONLQd8ERteRbOlj2BM9AYIrnGyJScaKAu7OUht0gI4C/NlEhdQruxTfQIDAQAB'

if (-not (Test-Path -LiteralPath $nativeOutput -PathType Leaf) -or
    -not (Test-Path -LiteralPath $daemonEntry -PathType Leaf) -or
    ($extensionManifest -and -not (Test-Path -LiteralPath $extensionManifest -PathType Leaf))) {
    throw 'Build Aeon first with pnpm build.'
}
if ($extensionManifest) {
    $manifest = Get-Content -LiteralPath $extensionManifest -Raw | ConvertFrom-Json
    if ($manifest.key -cne $expectedPublicKey) { throw 'The native extension key does not match the installed host origin.' }
}
$registrationPaused = $false
try {
$registration = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registrySubKey, $false)
if ($null -ne $registration) {
    $registeredManifest = [string]$registration.GetValue('')
    $registration.Dispose()
    if (-not $Update) { throw 'Already installed; use -Update to preserve the current data and registration.' }
    if ([IO.Path]::GetFullPath($registeredManifest) -ine [IO.Path]::GetFullPath($hostManifestPath)) {
        throw 'The registered host belongs to a different installation; preserved.'
    }
    $old = Get-Content -LiteralPath $hostConfigPath -Raw | ConvertFrom-Json
    if ($old.extensionId -cne $expectedExtensionId -or
        [IO.Path]::GetFullPath($old.dataDirectory) -ine [IO.Path]::GetFullPath((Join-Path $appRoot 'data'))) {
        throw 'Unexpected installed configuration; preserved.'
    }
    # Repair the renamed checkout path before querying the already-running runtime.
    $old.daemonEntrypoint = [IO.Path]::GetFullPath($daemonEntry)
    $old.nodeExecutable = $nodeFull
    Write-AtomicJson $hostConfigPath $old
    $activityJson = & $nodeFull (Join-Path $repoRoot 'scripts\inspect-daemon-activity.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify runtime inactivity; no restart was attempted.' }
    $activity = $activityJson | ConvertFrom-Json
    if (-not $activity.safeToRestart) { throw 'Core has active or uncertain chats; retry the update when idle.' }
    # Keep Chrome's reconnect loop from restarting the host while its executable is replaced.
    $pauseKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registrySubKey, $true)
    try { $pauseKey.SetValue('', $hostManifestPath + '.updating'); $registrationPaused = $true }
    finally { $pauseKey.Dispose() }
    & $hostExecutable --stop-supervisor | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $running = @(Get-CimInstance Win32_Process | Where-Object {
            [string]::Equals([string]$_.ExecutablePath, $hostExecutable, [StringComparison]::OrdinalIgnoreCase)
        })
        if (-not $running.Count) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
if ($running.Count) { throw 'Supervisor did not stop; files were preserved.' }
}
if ($ImportDataFrom -and ((Test-Path -LiteralPath (Join-Path $ImportDataFrom 'aeon.sqlite')) -or (Test-Path -LiteralPath (Join-Path $ImportDataFrom 'pippin.sqlite')))) {
    & $nodeFull (Join-Path $repoRoot 'scripts/import-virtualized-data.mjs') $ImportDataFrom (Join-Path $appRoot 'data')
    if ($LASTEXITCODE -ne 0) { throw 'Could not recover the redirected data; originals preserved.' }
}

$localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
$appRootFull = [IO.Path]::GetFullPath($appRoot)
if (-not $appRootFull.StartsWith(($localAppData + '\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The host install path is outside LocalAppData.'
}
$daemonFull = [IO.Path]::GetFullPath($daemonEntry)
& (Join-Path $PSScriptRoot 'configure-startup.ps1') -Mode Validate
New-Item -ItemType Directory -Path $appRootFull -Force | Out-Null
Copy-Item -LiteralPath $nativeOutput -Destination $hostExecutable
$hostManifest = [ordered]@{
    name = 'com.aeon.native_host'
    description = 'Disposable Aeon Slice 3 native messaging host'
    path = $hostExecutable
    type = 'stdio'
    allowed_origins = @("chrome-extension://$expectedExtensionId/")
}
$hostConfig = [ordered]@{
    extensionId = $expectedExtensionId
    nodeExecutable = $nodeFull
    daemonEntrypoint = $daemonFull
    dataDirectory = (Join-Path $appRootFull 'data')
}
Write-AtomicJson $hostManifestPath $hostManifest
Write-AtomicJson $hostConfigPath $hostConfig
$registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registrySubKey, $true)
try { $registryKey.SetValue('', $hostManifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
finally { $registryKey.Dispose() }
& (Join-Path $PSScriptRoot 'configure-startup.ps1') -Mode Install
Write-Output "Registered the disposable host for chrome-extension://$expectedExtensionId/."
if ($extensionManifest) { Write-Output "Browser extension: $(Split-Path $extensionManifest)" }
Write-Output "Daemon data will be stored outside the repository at: $((Join-Path $appRootFull 'data'))"

Start-Process -FilePath $hostExecutable -ArgumentList '--daemon-supervisor' -WindowStyle Hidden
} finally {
    if ($registrationPaused) {
        $restoreKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registrySubKey, $true)
        try { $restoreKey.SetValue('', $hostManifestPath) } finally { $restoreKey.Dispose() }
    }
}
