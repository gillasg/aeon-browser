param([ValidateSet('Remove', 'Validate')][string]$Mode = 'Remove')
$ErrorActionPreference = 'Stop'
$taskName = 'AeonDaemonWatchdog'
$description = 'Aeon-owned daemon supervisor: start at login and recover after exit.'
$hostPath = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Pippin\Slice3Dev\pippin-native-host.exe'))
$launcherPath = Join-Path ([IO.Path]::GetDirectoryName($hostPath)) 'watchdog-hidden.vbs'
$scriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcherArgument = '//B //NoLogo "' + $launcherPath + '"'
$launcherContent = 'CreateObject("WScript.Shell").Run Chr(34) & "' + $hostPath.Replace('"', '""') + '" & Chr(34) & " --daemon-supervisor", 0, False'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$legacyAction = $existing -and $existing.Actions[0].Execute -ceq $hostPath -and $existing.Actions[0].Arguments -ceq '--daemon-supervisor'
$silentAction = $existing -and $existing.Actions[0].Execute -ceq $scriptHost -and $existing.Actions[0].Arguments -ceq $launcherArgument
if ($existing -and ($existing.Description -cne $description -or (-not $legacyAction -and -not $silentAction))) {
    throw 'The watchdog task belongs to another installation; it was preserved.'
}
if ((Test-Path -LiteralPath $launcherPath) -and (Get-Content -LiteralPath $launcherPath -Raw).Trim() -cne $launcherContent) {
    throw 'The silent watchdog launcher has local changes; it was preserved.'
}
if ($Mode -eq 'Validate') { return }
if ($Mode -eq 'Remove') {
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    if (Test-Path -LiteralPath $launcherPath -PathType Leaf) { Remove-Item -LiteralPath $launcherPath }
    return
}

