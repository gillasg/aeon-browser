# Aeon-owned daemon launcher. The login task runs it at login and then every minute: it
# returns while the daemon is healthy, starts a supervisor when none is running, and replaces
# a supervisor that stopped making progress while holding the single-instance lock.
$ErrorActionPreference = 'SilentlyContinue'
$appRoot = $PSScriptRoot
$hostExecutable = Join-Path $appRoot 'aeon-native-host.exe'
$statusPath = Join-Path $appRoot 'daemon-supervisor-status.json'
$statePath = Join-Path $appRoot 'daemon-launcher-state.json'

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
    return Test-CorePing ([int]$match.Groups[1].Value)
}

function Test-CorePing([int]$Port) {
    # One 2s budget for connect, handshake, and the ping. Each step uses only the time left.
    $client = New-Object Net.Sockets.TcpClient
    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    try {
        $left = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($left -le 0 -or -not $client.ConnectAsync('127.0.0.1', $Port).Wait($left)) { return $false }
        $stream = $client.GetStream()
        $key = [Convert]::ToBase64String([guid]::NewGuid().ToByteArray())
        $head = "GET /core/v1 HTTP/1.1`r`nHost: 127.0.0.1:${Port}`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Key: ${key}`r`nSec-WebSocket-Version: 13`r`n`r`n"
        $bytes = [Text.Encoding]::ASCII.GetBytes($head)
        if (-not (Set-PingBudget $client $deadline)) { return $false }
        $stream.Write($bytes, 0, $bytes.Length)
        $buffer = New-Object byte[] 2048
        if (-not (Set-PingBudget $client $deadline)) { return $false }
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ([Text.Encoding]::ASCII.GetString($buffer, 0, $read) -notmatch ' 101 ') { return $false }
        $id = [guid]::NewGuid().ToString()
        $payload = [Text.Encoding]::UTF8.GetBytes("{""kind"":""core.ping"",""requestId"":""$id""}")
        $mask = New-Object byte[] 4
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($mask) } finally { $rng.Dispose() }
        $frame = New-Object byte[] (6 + $payload.Length)
        $frame[0] = 129
        $frame[1] = 128 -bor $payload.Length
        [Array]::Copy($mask, 0, $frame, 2, 4)
        for ($i = 0; $i -lt $payload.Length; $i++) { $frame[6 + $i] = $payload[$i] -bxor $mask[$i % 4] }
        if (-not (Set-PingBudget $client $deadline)) { return $false }
        $stream.Write($frame, 0, $frame.Length)
        if (-not (Set-PingBudget $client $deadline)) { return $false }
        $read = $stream.Read($buffer, 0, $buffer.Length)
        return [Text.Encoding]::UTF8.GetString($buffer, 0, $read).Contains('core.ping.result')
    } catch { return $false } finally { $client.Close() }
}

function Set-PingBudget([Net.Sockets.TcpClient]$Client, [DateTime]$Deadline) {
    $left = [int]($Deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($left -le 0) { return $false }
    $Client.ReceiveTimeout = $left
    $Client.SendTimeout = $left
    return $true
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

# Dot-sourcing defines Test-CorePing for tests and does not start or stop a supervisor.
if ($MyInvocation.InvocationName -eq '.') { return }

if (-not (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) { return }

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
