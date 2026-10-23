# Aeon-owned daemon launcher. The login task runs it at login and then every minute: it
# returns while the daemon is healthy, starts a supervisor when none is running, and replaces
# a supervisor that stopped making progress while holding the single-instance lock.
$ErrorActionPreference = 'SilentlyContinue'
$appRoot = $PSScriptRoot
$hostExecutable = Join-Path $appRoot 'aeon-native-host.exe'
$statusPath = Join-Path $appRoot 'daemon-supervisor-status.json'
$statePath = Join-Path $appRoot 'daemon-launcher-state.json'
if (-not (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) { return }

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
            ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $reader = New-Object IO.StreamReader($stream)
            try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
    } catch { return $null }
}

function Test-DaemonHealth {
    $connection = Read-JsonFile (Join-Path $appRoot 'data\core-connection.json')
    if (-not $connection -or -not $connection.pid) { return $false }
    $daemon = Get-Process -Id $connection.pid -ErrorAction SilentlyContinue
    if (-not $daemon -or $daemon.ProcessName -ne 'node') { return $false }
    $match = [regex]::Match([string]$connection.endpoint, '^ws://127\.0\.0\.1:(\d+)/core/v1$')
    if (-not $match.Success) { return $false }
    $client = New-Object Net.Sockets.TcpClient
    try {
        $pending = $client.ConnectAsync('127.0.0.1', [int]$match.Groups[1].Value)
        if (-not $pending.Wait(500)) { return $false }
        return $client.Connected
    } catch { return $false } finally { $client.Close() }
}

function Get-Supervisors {
    $expected = [IO.Path]::GetFullPath($hostExecutable)
    return @(Get-CimInstance Win32_Process -Filter "Name = 'aeon-native-host.exe'" | Where-Object {
        if (-not $_.CommandLine -or -not $_.CommandLine.Contains('--daemon-supervisor')) { return $false }
        if ($_.ExecutablePath) { return [IO.Path]::GetFullPath($_.ExecutablePath) -eq $expected }
        return $_.CommandLine.Contains($appRoot)
    })
}

function Save-Unhealthy([int]$Count) {
    try { [IO.File]::WriteAllText($statePath, '{"unhealthy":' + $Count + '}') } catch { }
}

$unhealthy = 0
$state = Read-JsonFile $statePath
if ($state -and $state.unhealthy) { $unhealthy = [int]$state.unhealthy }

if (Test-DaemonHealth) {
    if ($unhealthy -ne 0) { Save-Unhealthy 0 }
    return
}

$supervisors = Get-Supervisors
if ($supervisors.Count -eq 0) {
    Save-Unhealthy 0
    Start-Process -FilePath $hostExecutable -ArgumentList '--daemon-supervisor' -WindowStyle Hidden
    return
}

# A supervisor that is starting, or deliberately restarting its daemon, is left alone.
$status = Read-JsonFile $statusPath
$progressing = $false
if ($status -and $status.updatedAt -and $status.supervisorPid -eq $supervisors[0].ProcessId) {
    try {
        $updated = [DateTime]::Parse([string]$status.updatedAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        $progressing = ([DateTime]::UtcNow - $updated).TotalSeconds -lt 120
    } catch { $progressing = $false }
}
$youngest = $supervisors | Sort-Object CreationDate | Select-Object -Last 1
$recent = $youngest -and $youngest.CreationDate -and
    $youngest.CreationDate.ToUniversalTime() -gt [DateTime]::UtcNow.AddMinutes(-3)
if ($progressing -or $recent) {
    if ($unhealthy -ne 0) { Save-Unhealthy 0 }
    return
}

# No progress for two checks: the supervisor is wedged and holds the single-instance lock,
# so only stopping it can bring the daemon back.
$unhealthy++
Save-Unhealthy $unhealthy
if ($unhealthy -lt 2) { return }

& $hostExecutable --stop-supervisor | Out-Null
foreach ($supervisor in $supervisors) {
    Stop-Process -Id $supervisor.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500
Save-Unhealthy 0
Start-Process -FilePath $hostExecutable -ArgumentList '--daemon-supervisor' -WindowStyle Hidden
