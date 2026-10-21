param([ValidateSet('Install', 'Remove', 'Validate')][string]$Mode = 'Install')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'configure-watchdog.ps1') -Mode Validate
$appRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Aeon'))
$startupScript = Join-Path $appRoot 'start-daemon.ps1'
$hostExecutable = Join-Path $appRoot 'aeon-native-host.exe'
$runKeyPath = 'Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'AeonDaemon'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command = '"' + $powershellPath + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $startupScript + '"'
$scriptContent = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'daemon-launcher.ps1') -Raw
# Installs that only ever started the daemon once are still ours and get replaced.
$legacyScriptContent = @'
# Aeon-owned daemon login launcher.
$ErrorActionPreference = 'Stop'
$hostExecutable = Join-Path $PSScriptRoot 'aeon-native-host.exe'
if (Test-Path -LiteralPath $hostExecutable -PathType Leaf) {
    Start-Process -FilePath $hostExecutable -ArgumentList '--daemon-supervisor' -WindowStyle Hidden
}
'@
function Get-Normalized([string]$Text) { return (($Text -replace "`r`n", "`n").Trim()) }
$installed = if (Test-Path -LiteralPath $startupScript) { Get-Content -LiteralPath $startupScript -Raw } else { '' }
# A launcher that is neither the current one nor the known previous one belongs to the user.
$owned = (-not $installed) -or
    ((Get-Normalized $installed) -ceq (Get-Normalized $scriptContent)) -or
    ((Get-Normalized $installed) -ceq (Get-Normalized $legacyScriptContent))
if (-not $owned) { throw 'The login launcher has local changes; it was preserved.' }
$runKey = if ($Mode -eq 'Validate') {
    [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKeyPath, $false)
} else { [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runKeyPath, $true) }
try {
    & (Join-Path $PSScriptRoot 'configure-login-task.ps1') -Mode Validate -PowerShellPath $powershellPath -StartupScript $startupScript
    $existing = if ($null -ne $runKey) { [string]$runKey.GetValue($runName, '') } else { '' }
    if ($existing -and $existing -cne $command) {
        throw 'The Aeon login entry belongs to another installation; it was preserved.'
    }
    if ($Mode -eq 'Validate') { return }
    if ($Mode -eq 'Install') {
        if (-not (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) {
            throw 'Install the native host before configuring daemon startup.'
        }
        $scriptContent | Set-Content -LiteralPath $startupScript -Encoding UTF8
        & (Join-Path $PSScriptRoot 'configure-login-task.ps1') -Mode Install -PowerShellPath $powershellPath -StartupScript $startupScript
        if ($existing) { $runKey.DeleteValue($runName, $false) }
        & (Join-Path $PSScriptRoot 'configure-watchdog.ps1') -Mode Remove
        Write-Output 'Aeon keeps one hidden daemon running from login; routines can run without Chrome.'
    } else {
        & (Join-Path $PSScriptRoot 'configure-login-task.ps1') -Mode Remove -PowerShellPath $powershellPath -StartupScript $startupScript
        if ($existing) { $runKey.DeleteValue($runName, $false) }
        if ((Test-Path -LiteralPath $startupScript -PathType Leaf) -and
            ((Get-Normalized (Get-Content -LiteralPath $startupScript -Raw)) -ceq (Get-Normalized $scriptContent))) {
            Remove-Item -LiteralPath $startupScript -Force
        }
        & (Join-Path $PSScriptRoot 'configure-watchdog.ps1') -Mode Remove
        Write-Output 'Removed the owned Aeon daemon login entry.'
    }
} finally { if ($null -ne $runKey) { $runKey.Dispose() } }
