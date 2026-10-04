param([Parameter(Mandatory=$true)][string]$CoreRoot, [switch]$Update)
$ErrorActionPreference = 'Stop'
$core = (Resolve-Path -LiteralPath $CoreRoot).Path
$script = Join-Path $core 'apps\native-host\scripts\install-disposable.ps1'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'Core build/setup script not found.' }
$browser = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& $script -BrowserRoot $browser -Update:$Update
