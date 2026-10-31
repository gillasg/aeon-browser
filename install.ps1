# Installs Aeon on Windows with one line in PowerShell:
#
#   irm https://raw.githubusercontent.com/gillasg/aeon-browser/main/install.ps1 | iex
#
# Installs Git and Node.js with winget when they are missing, then pnpm, fetches Aeon (or updates
# it), builds it and sets it up. What is left is loading the extension: Chrome opens on
# chrome://extensions with the folder path on the clipboard.
$ErrorActionPreference = 'Stop'
$dir = if ($env:AEON_DIR) { $env:AEON_DIR } else { Join-Path $env:LOCALAPPDATA 'Aeon\aeon-browser' }
$repo = 'https://github.com/gillasg/aeon-browser.git'

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Need($command, $package) {
  if (Get-Command $command -ErrorAction SilentlyContinue) { return }
  Write-Host "Installing $package..."
  winget install --id $package --exact --silent --accept-source-agreements --accept-package-agreements | Out-Null
  Refresh-Path
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$package did not install. Install it, then run this again." }
}

Need git 'Git.Git'
Need node 'OpenJS.NodeJS.LTS'
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "Aeon needs Node.js 22 or newer (found $(node --version))." }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing pnpm...'
  npm install --global pnpm@11.4.0 --silent | Out-Null
  Refresh-Path
}

if (Test-Path (Join-Path $dir '.git')) {
  Write-Host "Updating Aeon in $dir..."
  git -C $dir pull --ff-only --quiet
} else {
  Write-Host "Fetching Aeon into $dir..."
  New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
  git clone --depth 1 --quiet $repo $dir
}
node (Join-Path $dir 'scripts\setup.mjs')
