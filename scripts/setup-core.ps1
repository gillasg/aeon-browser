param([switch]$Update)
$ErrorActionPreference = 'Stop'
# The agent and the extension are one repo now: set up the native host and login task from here.
$script = Join-Path $PSScriptRoot '..\apps\native-host\scripts\install-disposable.ps1'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'Native host setup script not found.' }
$browser = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
& $script -BrowserRoot $browser -Update:$Update
