param([ValidateSet('Install', 'Remove', 'Validate')][string]$Mode = 'Install')
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Pippin\Slice3Dev'))
$startupScript = Join-Path $appRoot 'start-daemon.ps1'
$hostExecutable = Join-Path $appRoot 'pippin-native-host.exe'
$runKeyPath = 'Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'PippinDaemon'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command = '"' + $powershellPath + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $startupScript + '"'
$scriptContent = @'
# Pippin-owned daemon login launcher.
$ErrorActionPreference = 'Stop'
$hostExecutable = Join-Path $PSScriptRoot 'pippin-native-host.exe'
if (Test-Path -LiteralPath $hostExecutable -PathType Leaf) {
    Start-Process -FilePath $hostExecutable -ArgumentList '--daemon-supervisor' -WindowStyle Hidden
}
'@
$runKey = if ($Mode -eq 'Validate') {
    [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKeyPath, $false)
} else { [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runKeyPath, $true) }
try {
    $existing = if ($null -ne $runKey) { [string]$runKey.GetValue($runName, '') } else { '' }
    if ($existing -and $existing -cne $command) {
        throw 'The Aeon login entry belongs to another installation; it was preserved.'
    }
    if ($Mode -eq 'Validate') {
        if ((Test-Path -LiteralPath $startupScript) -and
            (Get-Content -LiteralPath $startupScript -Raw).Trim() -cne $scriptContent.Trim()) {
            throw 'The login launcher has local changes; it was preserved.'
        }
        return
    }
    if ($Mode -eq 'Install') {
        if (-not (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) {
            throw 'Install the native host before configuring daemon startup.'
        }
        if ((Test-Path -LiteralPath $startupScript) -and
            (Get-Content -LiteralPath $startupScript -Raw).Trim() -cne $scriptContent.Trim()) {
            throw 'The login launcher has local changes; it was preserved.'
        }
        $scriptContent | Set-Content -LiteralPath $startupScript -Encoding UTF8
        $runKey.SetValue($runName, $command, [Microsoft.Win32.RegistryValueKind]::String)
        Write-Output 'Aeon will start one hidden daemon at user login; routines can run without Chrome.'
    } else {
        if ($existing) { $runKey.DeleteValue($runName, $false) }
        if ((Test-Path -LiteralPath $startupScript -PathType Leaf) -and
            (Get-Content -LiteralPath $startupScript -Raw).Trim() -ceq $scriptContent.Trim()) {
            Remove-Item -LiteralPath $startupScript -Force
        }
        Write-Output 'Removed the owned Aeon daemon login entry.'
    }
} finally { if ($null -ne $runKey) { $runKey.Dispose() } }
