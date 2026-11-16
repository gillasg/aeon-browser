#!/bin/sh
# Installs Aeon on macOS and Linux with one line:
#
#   curl -fsSL https://raw.githubusercontent.com/gillasg/aeon-browser/main/install.sh | sh
#
# Installs Git, Node.js and pnpm when they are missing, fetches Aeon (or updates it), builds it,
# installs the native host, the Chrome manifests and the login service, then presents the
# extension. Windows uses install.ps1.
set -eu

REPO="${AEON_REPO:-https://github.com/gillasg/aeon-browser.git}"
if [ -n "${AEON_DIR:-}" ]; then
  DIR="$AEON_DIR"
elif [ "$(uname -s)" = "Darwin" ]; then
  DIR="$HOME/Library/Application Support/Aeon/aeon-browser"
else
  DIR="${XDG_DATA_HOME:-$HOME/.local/share}/aeon/aeon-browser"
fi

say() { printf '%s\n' "$*"; }
die() { printf 'Aeon: %s\n' "$*" >&2; exit 1; }

refresh_path() {
  PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  export PATH
}

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  say "Installing $2..."
  if [ "$(uname -s)" = "Darwin" ]; then
    command -v brew >/dev/null 2>&1 || die "$2 is missing and Homebrew is not installed. Install $2, then run this again."
    brew install "$3"
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y "$3"
  else
    die "$2 is missing. Install it, then run this again."
  fi
  refresh_path
  command -v "$1" >/dev/null 2>&1 || die "$2 did not install. Install it, then run this again."
}

refresh_path
need git Git git
if ! command -v node >/dev/null 2>&1; then
  say "Installing Node.js 22..."
  if [ "$(uname -s)" = "Darwin" ]; then
    need node Node.js node
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    die "Node.js 22 or newer is missing. Install it, then run this again."
  fi
fi
major=$(node --version | sed 's/^v//' | cut -d. -f1)
[ "$major" -ge 22 ] || die "Aeon needs Node.js 22 or newer (found $(node --version))."
if ! command -v pnpm >/dev/null 2>&1; then
  say "Installing pnpm into $HOME/.local..."
  # npm's global prefix is root-owned when Node came from NodeSource, so install where the user
  # can write and the PATH refresh above finds it. Keep npm's output: it is the only diagnosis.
  if ! npm install --global --prefix "$HOME/.local" pnpm@11.4.0; then
    die "pnpm could not be installed (see npm above). Install pnpm 11 yourself, then run this again."
  fi
  refresh_path
  command -v pnpm >/dev/null 2>&1 || die "pnpm was installed but is not on PATH. Add $HOME/.local/bin to PATH, then run this again."
fi

if [ -d "$DIR/.git" ]; then
  say "Updating Aeon in $DIR..."
  git -C "$DIR" pull --ff-only --quiet
else
  say "Fetching Aeon into $DIR..."
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi

cd "$DIR"
exec node scripts/setup.mjs "$@"
