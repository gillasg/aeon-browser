$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$nativeOutput = Join-Path $repoRoot 'apps\native-host\dist\pippin-native-host.exe'
$daemonEntry = Join-Path $repoRoot 'apps\daemon\dist\main.js'
$extensionManifest = Join-Path $repoRoot 'apps\chrome-extension\native-dist\manifest.json'
$appRoot = Join-Path $env:LOCALAPPDATA 'Pippin\Slice3Dev'
$hostExecutable = Join-Path $appRoot 'pippin-native-host.exe'
$hostManifestPath = Join-Path $appRoot 'com.pippin.native_host_dev.json'
$hostConfigPath = Join-Path $appRoot 'host-config.json'
$registrySubKey = 'Software\Google\Chrome\NativeMessagingHosts\com.pippin.native_host_dev'
$expectedExtensionId = 'npcdopokfkpfmepknhoecppgdgmkmihh'
$expectedPublicKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA89DgbMVu50oH2AAiN0vILGKRKc2ePGR9r1W92yDIiVq9n1rxtqxQZSLsxPKuymvi3wB9hpo0h9vJ3++teaw8fqBllliSeELEAUmPNhauLcvlKe1nhkbgRf2wXilCUVI+zumNinkqw5h85rew1FI894ev8M9wWzSHm90eL9WILlWTrjhdaNTpMs2w9sF8GrsKj+sX1anF9/iUfZ9hbracUa47Z2b4KiviZp5SlF6o+0SwFHbeOVM0Aq2nHMFujmfaOcW7TkxDdPXBns2uRY1CTmRIyi3B1pONLQd8ERteRbOlj2BM9AYIrnGyJScaKAu7OUht0gI4C/NlEhdQruxTfQIDAQAB'

if (-not (Test-Path -LiteralPath $nativeOutput -PathType Leaf) -or
    -not (Test-Path -LiteralPath $daemonEntry -PathType Leaf) -or
    -not (Test-Path -LiteralPath $extensionManifest -PathType Leaf)) {
    throw 'Build Aeon first with pnpm build.'
}
$manifest = Get-Content -LiteralPath $extensionManifest -Raw | ConvertFrom-Json
if ($manifest.key -cne $expectedPublicKey) { throw 'The native extension key does not match the disposable host origin.' }
$registration = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registrySubKey, $false)
if ($null -ne $registration) {
    $registration.Dispose()
    throw 'A native host registration already exists. Uninstall it explicitly before installing this disposable host.'
}
$localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
$appRootFull = [IO.Path]::GetFullPath($appRoot)
if (-not $appRootFull.StartsWith(($localAppData + '\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The host install path is outside LocalAppData.'
}
$daemonFull = [IO.Path]::GetFullPath($daemonEntry)
$node = (Get-Command node -ErrorAction Stop).Source
$nodeFull = [IO.Path]::GetFullPath($node)
& (Join-Path $PSScriptRoot 'configure-startup.ps1') -Mode Validate
New-Item -ItemType Directory -Path $appRootFull -Force | Out-Null
Copy-Item -LiteralPath $nativeOutput -Destination $hostExecutable
$hostManifest = [ordered]@{
    name = 'com.pippin.native_host_dev'
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
$hostManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $hostManifestPath -Encoding UTF8
$hostConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $hostConfigPath -Encoding UTF8
$registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registrySubKey, $true)
try { $registryKey.SetValue('', $hostManifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
finally { $registryKey.Dispose() }
& (Join-Path $PSScriptRoot 'configure-startup.ps1') -Mode Install
Write-Output "Registered the disposable host for chrome-extension://$expectedExtensionId/."
Write-Output "Load the unpacked extension from: $([IO.Path]::GetFullPath((Join-Path $repoRoot 'apps\chrome-extension\native-dist')))"
Write-Output "Daemon data will be stored outside the repository at: $((Join-Path $appRootFull 'data'))"
