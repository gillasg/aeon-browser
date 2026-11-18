#!/usr/bin/env bash
# One-time, idempotent setup for the SEPARATE recording Chrome. Never touches aeon-chrome or
# aeon-daemon: eval keeps running on its own CFT browser/profile/display.
set -euo pipefail

DISPLAY_NUM="${AEON_RECORDING_DISPLAY:-:120}"
PROFILE="${AEON_RECORDING_PROFILE:-$HOME/.cache/aeon-recording-profile}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${AEON_EXTENSION_DIR:-$(cd "$KIT_DIR/../.." 2>/dev/null && pwd)/apps/chrome-extension/native-dist}"
# Optional, e.g. socks5://127.0.0.1:1081 to film from another network exit.
PROXY="${AEON_RECORDING_PROXY:-}"
EXT_ID="npcdopokfkpfmepknhoecppgdgmkmihh"
BROWSER="${AEON_RECORDING_BROWSER:-recording}"
SCREEN="${AEON_RECORDING_SCREEN:-1000x1500}"
WINDOW="${AEON_RECORDING_SIZE:-760x1350}"
NUM="${DISPLAY_NUM#:}"

mkdir -p "$PROFILE/Default" "$PROFILE/NativeMessagingHosts"

# Native messaging is looked up inside the custom --user-data-dir, not in ~/.config/google-chrome.
HOST="$PROFILE/NativeMessagingHosts/com.aeon.native_host.json"
if [ ! -f "$HOST" ]; then
  for candidate in \
    "$HOME/.config/google-chrome/NativeMessagingHosts/com.aeon.native_host.json" \
    "$HOME/.config/chromium/NativeMessagingHosts/com.aeon.native_host.json"; do
    if [ -f "$candidate" ]; then cp "$candidate" "$HOST"; break; fi
  done
fi
[ -f "$HOST" ] || { echo "Aeon native host manifest not found" >&2; exit 1; }

# Branded Chrome ignores --load-extension. Seed the unpacked extension into Preferences instead:
# Developer mode is on and the profile loads Aeon from its own directory on every start.
if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "Built extension not found: $EXT_DIR (set AEON_EXTENSION_DIR)" >&2
  exit 1
fi
python3 - "$PROFILE/Default/Preferences" "$EXT_DIR" "$EXT_ID" <<'PY'
import json, os, sys
pref, ext_dir, ext_id = sys.argv[1:4]
d = json.load(open(pref)) if os.path.exists(pref) else {}
settings = d.setdefault("extensions", {}).setdefault("settings", {})
if ext_id not in settings:
    manifest = json.load(open(os.path.join(ext_dir, "manifest.json")))
    perms = {
        "api": manifest.get("permissions", []),
        "explicit_host": manifest.get("host_permissions", []),
        "scriptable_host": manifest.get("host_permissions", []),
    }
    settings[ext_id] = {
        "location": 4, "state": 1, "path": ext_dir, "manifest": manifest,
        "from_webstore": False, "was_installed_by_default": False,
        "was_installed_by_oem": False, "creation_flags": 38,
        "active_permissions": perms, "granted_permissions": perms,
        "content_settings": [], "incognito_content_settings": [],
        "incognito_preferences": {}, "preferences": {},
        "regular_only_preferences": {}, "withholding_permissions": False,
    }
    d["extensions"].setdefault("ui", {})["developer_mode"] = True
    d.setdefault("browser", {})["has_seen_welcome_page"] = True
    d.setdefault("profile", {}).update(exit_type="Normal", exited_cleanly=True)
    with open(pref, "w") as f: json.dump(d, f, separators=(",", ":"))
PY

if [ ! -S "/tmp/.X11-unix/X${NUM}" ]; then
  rm -f "/tmp/.X11-unix/X${NUM}"
  setsid nohup Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN"x24 -nolisten tcp \
    >/tmp/aeon-recording-xvfb.log 2>&1 </dev/null &
fi

if ! pgrep -f "user-data-dir=$PROFILE" >/dev/null 2>&1; then
  # No --enable-automation and no remote debugging: no test bar, no "controlled by software" bar.
  NET_ARGS=()
  [ -z "$PROXY" ] || NET_ARGS=(--proxy-server="$PROXY" --webrtc-ip-handling-policy=disable_non_proxied_udp)
  DISPLAY="$DISPLAY_NUM" setsid nohup "${AEON_RECORDING_CHROME:-google-chrome}" \
    --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check --disable-gpu --silent-debugger-extension-api \
    "${NET_ARGS[@]}" \
    --window-size="${WINDOW/x/,}" --window-position=0,0 about:blank \
    >/tmp/aeon-recording-chrome.log 2>&1 </dev/null &
fi

# Wait for this profile to register with the daemon; name it so `aeon run --browser` is explicit.
for _ in $(seq 1 40); do
  ID="$(python3 - "$BROWSER" <<'PY'
import json, subprocess, sys
try:
    out = subprocess.check_output(["aeon", "browsers", "--json"], text=True, stderr=subprocess.DEVNULL)
    rows = json.loads(out).get("browsers", [])
except Exception:
    rows = []
name = sys.argv[1]
match = [r for r in rows if r.get("name") == name]
if match:
    print(match[0]["clientInstanceId"])
else:
    unnamed = [r for r in rows if not r.get("name")]
    print(unnamed[0]["clientInstanceId"] if len(unnamed) == 1 else "")
PY
)"
  [ -z "$ID" ] || break
  sleep 1
done
NAMED="$(python3 - "$BROWSER" <<'PY'
import json, subprocess, sys
try:
    rows = json.loads(subprocess.check_output(["aeon", "browsers", "--json"], text=True,
                                              stderr=subprocess.DEVNULL)).get("browsers", [])
except Exception:
    rows = []
print(any(r.get("name") == sys.argv[1] for r in rows))
PY
)"
if [ -n "$ID" ] && [ "$NAMED" != "True" ]; then
  aeon browsers name "$ID" "$BROWSER" >/dev/null
fi

# Per-profile settings through the daemon, targeted at this browser only (eval is untouched).
aeon tool --browser "$BROWSER" browser_code \
  '{"code":"await browser.settings({agentInFront:true, cursor:\"shown\"}); return true;"}' \
  >/dev/null 2>&1 || true

echo "Recording Chrome ready: browser=$BROWSER display=$DISPLAY_NUM profile=$PROFILE"
