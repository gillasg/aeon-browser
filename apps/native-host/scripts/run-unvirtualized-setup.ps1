param([string]$Installer, [string]$BrowserRoot, [string]$NodeExecutable, [switch]$Update)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AeonPackageIdentity {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetCurrentPackageFullName(ref uint length, IntPtr name);
}
'@
[uint32]$taskLength = 0
# Some packaged desktop hosts redirect AppData writes from child processes that
# have no package identity of their own. Detect that with a probe instead of trusting identity.
$probeName = 'aeon-virtualization-probe-' + [Guid]::NewGuid().ToString('N')
$probe = Join-Path $env:LOCALAPPDATA $probeName
[IO.File]::WriteAllText($probe, '')
$redirected = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName ('LocalCacheLocal' + $probeName)) })
Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
if (-not $env:CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY -and $redirected.Count -eq 0 -and
    [AeonPackageIdentity]::GetCurrentPackageFullName([ref]$taskLength, [IntPtr]::Zero) -eq 15700) {
    return $false
}
# Windows launches this one-time task outside an MSIX parent's filesystem/registry virtualization.
# It is removed after setup; it is not a watchdog or a recurring task.
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$taskOutput = Join-Path $taskRoot ('artifacts/host-setup/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
function Quote-SetupLiteral([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
$taskResult = Join-Path $taskOutput 'result.json'
$taskLog = Join-Path $taskOutput 'setup.log'
$taskScript = Join-Path $taskOutput 'setup.ps1'
$taskArgs = '-Unvirtualized -NodeExecutable ' + (Quote-SetupLiteral $NodeExecutable)
if ($BrowserRoot) { $taskArgs += ' -BrowserRoot ' + (Quote-SetupLiteral $BrowserRoot) }
if ($Update) { $taskArgs += ' -Update' }
$families = @($redirected | ForEach-Object { $_.Name }) + @($env:CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY | Where-Object { $_ })
foreach ($family in $families) {
    $redirectedData = Join-Path $env:LOCALAPPDATA ('Packages/' + $family + '/LocalCache/Local/Aeon/data')
    if (Test-Path -LiteralPath (Join-Path $redirectedData 'aeon.sqlite')) {
        $taskArgs += ' -ImportDataFrom ' + (Quote-SetupLiteral $redirectedData)
    }
}
$taskBody = @"
`$ErrorActionPreference = 'Stop'
try {
    & $(Quote-SetupLiteral $Installer) $taskArgs *> $(Quote-SetupLiteral $taskLog)
    if (`$LASTEXITCODE -and `$LASTEXITCODE -ne 0) { throw 'Native setup failed.' }
    [IO.File]::WriteAllText($(Quote-SetupLiteral $taskResult), '{"ok":true}')
} catch {
    [IO.File]::WriteAllText($(Quote-SetupLiteral $taskResult), (`@{ok=`$false;message=`$_.Exception.Message} | ConvertTo-Json -Compress))
}
"@
[IO.File]::WriteAllText($taskScript, $taskBody)
$taskService = New-Object -ComObject 'Schedule.Service'
$taskService.Connect()
$taskFolder = $taskService.GetFolder('\')
$taskName = 'Aeon-Setup-' + [Guid]::NewGuid().ToString('N')
$taskDefinition = $taskService.NewTask(0)
$taskDefinition.Settings.Hidden = $true
$taskDefinition.Settings.DisallowStartIfOnBatteries = $false
$taskDefinition.Settings.StopIfGoingOnBatteries = $false
$taskDefinition.Settings.ExecutionTimeLimit = 'PT2M'
$taskDefinition.Principal.LogonType = 3
$taskAction = $taskDefinition.Actions.Create(0)
$taskAction.Path = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$taskAction.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskScript + '"'
try {
    $taskRegistered = $taskFolder.RegisterTaskDefinition($taskName, $taskDefinition, 6, $null, $null, 3)
    $null = $taskRegistered.Run($null)
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(90)
    while (-not (Test-Path -LiteralPath $taskResult)) {
        if ([DateTime]::UtcNow -ge $taskDeadline) { throw "Native setup timed out. Inspect $taskLog" }
        Start-Sleep -Milliseconds 200
    }
    $taskReply = [IO.File]::ReadAllText($taskResult) | ConvertFrom-Json
    if (-not $taskReply.ok) { throw $taskReply.message }
    Get-Content -LiteralPath $taskLog | Write-Host
} finally {
    $taskFolder.DeleteTask($taskName, 0)
}
return $true
