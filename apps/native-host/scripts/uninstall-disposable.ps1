$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Aeon'))
$hostExecutable = Join-Path $appRoot 'aeon-native-host.exe'
$hostManifestPath = Join-Path $appRoot 'com.aeon.native_host.json'
$hostConfigPath = Join-Path $appRoot 'host-config.json'
$registrySubKey = 'Software\Google\Chrome\NativeMessagingHosts\com.aeon.native_host'
$expectedExtensionId = 'npcdopokfkpfmepknhoecppgdgmkmihh'
$expectedOrigin = "chrome-extension://$expectedExtensionId/"
& (Join-Path $PSScriptRoot 'configure-startup.ps1') -Mode Validate
$appRootPrefix = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Aeon'))
if (-not $appRoot.StartsWith(($appRootPrefix.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to operate outside LocalAppData\Aeon.'
}

$registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registrySubKey, $true)
if ($null -eq $registryKey) {
    Write-Output 'The disposable native host is not registered.'
    return
}
try { $registeredManifest = [string]$registryKey.GetValue('') }
finally { $registryKey.Dispose() }
if ([string]::IsNullOrWhiteSpace($registeredManifest) -or
    -not [string]::Equals([IO.Path]::GetFullPath($registeredManifest), [IO.Path]::GetFullPath($hostManifestPath), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The registry entry does not point to this exact disposable manifest. Nothing was removed.'
}
if (-not (Test-Path -LiteralPath $hostManifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $hostConfigPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) {
    throw 'The registered host files are incomplete. Nothing was removed.'
}
$manifest = Get-Content -LiteralPath $hostManifestPath -Raw | ConvertFrom-Json
$config = Get-Content -LiteralPath $hostConfigPath -Raw | ConvertFrom-Json
if ($manifest.name -cne 'com.aeon.native_host' -or
    [IO.Path]::GetFullPath([string]$manifest.path) -ine [IO.Path]::GetFullPath($hostExecutable) -or
    @($manifest.allowed_origins).Count -ne 1 -or $manifest.allowed_origins[0] -cne $expectedOrigin -or
    $config.extensionId -cne $expectedExtensionId -or
    [IO.Path]::GetFullPath([string]$config.dataDirectory) -ine [IO.Path]::GetFullPath((Join-Path $appRoot 'data'))) {
    throw 'Host manifest or config differs from the exact disposable registration. Nothing was removed.'
}
if ($registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registrySubKey, $false)) {
    try {
        if ($registryKey.GetSubKeyNames().Count -gt 0) { throw 'The registration has unexpected child keys.' }
    } finally { $registryKey.Dispose() }
}
if (Test-Path -LiteralPath $hostExecutable -PathType Leaf) { & $hostExecutable --stop-supervisor | Out-Null }
$stopDeadline = [DateTime]::UtcNow.AddSeconds(5)
do {
    $runningHost = @(Get-CimInstance Win32_Process | Where-Object {
        [string]::Equals([string]$_.ExecutablePath, $hostExecutable, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($runningHost.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $stopDeadline)
if ($runningHost.Count -gt 0) { throw 'The disposable native host is still running. The registration and files were preserved.' }
if (Test-Path -LiteralPath $hostExecutable -PathType Leaf) {
    $removedExecutable = $false
    for ($attempt = 0; $attempt -lt 10 -and -not $removedExecutable; $attempt++) {
        try {
            Remove-Item -LiteralPath $hostExecutable -Force -ErrorAction Stop
            $removedExecutable = $true
        } catch {
            if ($attempt -eq 9) { throw }
            Start-Sleep -Milliseconds 200
        }
    }
}
if (Test-Path -LiteralPath $hostExecutable -PathType Leaf) {
    throw 'The host executable could not be removed. The registration and config files were preserved.'
}
[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($registrySubKey, $false)
& (Join-Path $PSScriptRoot 'configure-startup.ps1') -Mode Remove
Remove-Item -LiteralPath $hostConfigPath -Force
Remove-Item -LiteralPath $hostManifestPath -Force
Write-Output 'Removed the exact disposable host registration and its three host files.'
Write-Output "Preserved daemon and Pi session data at: $(Join-Path $appRoot 'data')"
