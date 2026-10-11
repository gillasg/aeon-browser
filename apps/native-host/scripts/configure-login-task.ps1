param([ValidateSet('Install', 'Remove', 'Validate')][string]$Mode,
      [string]$PowerShellPath, [string]$StartupScript)
$ErrorActionPreference = 'Stop'
$taskService = New-Object -ComObject 'Schedule.Service'
$taskService.Connect()
$taskFolder = $taskService.GetFolder('\')
$taskName = 'Aeon-Core-Login'
$description = 'Aeon owned login startup: ' + $StartupScript
$powerShellArguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $StartupScript + '"'
# conhost --headless gives PowerShell no console at all. -WindowStyle Hidden alone still flashes a
# window, which the per-minute repetition below would show every minute.
$hostPath = Join-Path $env:WINDIR 'System32\conhost.exe'
$arguments = '--headless "' + $PowerShellPath + '" ' + $powerShellArguments
$existingTask = $null
try { $existingTask = $taskFolder.GetTask($taskName) } catch {
    if ($_.Exception.HResult -ne -2147024894) { throw }
}
$existingAction = if ($existingTask) { $existingTask.Definition.Actions.Item(1) }
# Older installs launched PowerShell directly; they are still ours and get replaced.
$ownAction = $existingAction -and
    (($existingAction.Path -ieq $hostPath -and $existingAction.Arguments -ceq $arguments) -or
     ($existingAction.Path -ieq $PowerShellPath -and $existingAction.Arguments -ceq $powerShellArguments))
if ($existingTask -and ($existingTask.Definition.RegistrationInfo.Description -cne $description -or
    $existingTask.Definition.Actions.Count -ne 1 -or -not $ownAction)) {
    throw 'The login task belongs to another installation or has local changes; preserved.'
}
if ($Mode -eq 'Validate') { return }
if ($Mode -eq 'Remove') {
    if ($existingTask) { $taskFolder.DeleteTask($taskName, 0) }
    return
}
$definition = $taskService.NewTask(0)
$definition.RegistrationInfo.Description = $description
$definition.Settings.Hidden = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.StartWhenAvailable = $true
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$definition.Settings.MultipleInstances = 2
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.UserId = $userId
$definition.Principal.LogonType = 3
$trigger = $definition.Triggers.Create(9)
$trigger.UserId = $userId
# Re-run every minute for the whole session. The supervisor is single-instance, so a healthy
# daemon makes this a no-op; a daemon that exited for any reason is back within a minute.
$trigger.Repetition.Interval = 'PT1M'
$trigger.Repetition.Duration = ''
$action = $definition.Actions.Create(0)
$action.Path = $hostPath
$action.Arguments = $arguments
$null = $taskFolder.RegisterTaskDefinition($taskName, $definition, 6, $userId, $null, 3)
