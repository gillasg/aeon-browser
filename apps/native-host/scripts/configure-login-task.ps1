param([ValidateSet('Install', 'Remove', 'Validate')][string]$Mode,
      [string]$PowerShellPath, [string]$StartupScript)
$ErrorActionPreference = 'Stop'
$taskService = New-Object -ComObject 'Schedule.Service'
$taskService.Connect()
$taskFolder = $taskService.GetFolder('\')
$taskName = 'Aeon-Core-Login'
$description = 'Aeon owned login startup: ' + $StartupScript
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $StartupScript + '"'
$existingTask = $null
try { $existingTask = $taskFolder.GetTask($taskName) } catch {
    if ($_.Exception.HResult -ne -2147024894) { throw }
}
if ($existingTask -and ($existingTask.Definition.RegistrationInfo.Description -cne $description -or
    $existingTask.Definition.Actions.Count -ne 1 -or
    $existingTask.Definition.Actions.Item(1).Path -ine $PowerShellPath -or
    $existingTask.Definition.Actions.Item(1).Arguments -cne $arguments)) {
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
$action.Path = $PowerShellPath
$action.Arguments = $arguments
$null = $taskFolder.RegisterTaskDefinition($taskName, $definition, 6, $userId, $null, 3)
