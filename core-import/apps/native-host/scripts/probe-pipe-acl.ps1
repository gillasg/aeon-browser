$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$hostExecutable = Join-Path $repoRoot 'apps\native-host\dist\aeon-native-host.exe'
if (-not (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) { throw 'Build the native host first with pnpm build.' }
$sddl = (& $hostExecutable --inspect-pipe-acl | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Native host pipe ACL probe failed with exit $LASTEXITCODE." }
$match = [regex]::Match($sddl, '^O:(?<owner>[^G]+)G:(?<group>[^D]+)D:P\(A;;0x[0-9a-fA-F]+;;;(?<ace>[^)]+)\)$')
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $match.Success -or $match.Groups['owner'].Value -cne $sid -or $match.Groups['ace'].Value -cne $sid) {
    throw "Pipe DACL is not protected with only the current user's allow ACE: $sddl"
}
Write-Output "Current-user-only named-pipe DACL verified for $sid"
Write-Output $sddl
