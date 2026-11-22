#!/usr/bin/env bash
# One-time, idempotent setup for the SEPARATE recording Chrome. Never touches aeon-chrome or
# aeon-daemon: eval keeps running on its own CFT browser/profile/display.
# Default capture: a 1280x720 logical window at DPR 3, so frames are a 3840x2160 master that
# delivers a sharp 1920x1080 cut with up to a 2x optical push-in. Set AEON_RECORDING_DPR=2 for a
# 2560x1440 master on smaller machines. Export the same AEON_RECORDING_DPR for `aeon record` so
# events.json carries dpr and the logical size.
set -euo pipefail

DISPLAY_NUM="${AEON_RECORDING_DISPLAY:-:120}"
PROFILE="${AEON_RECORDING_PROFILE:-$HOME/.cache/aeon-recording-profile}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${AEON_EXTENSION_DIR:-$(cd "$KIT_DIR/../.." 2>/dev/null && pwd)/apps/chrome-extension/native-dist}"
# Optional, e.g. socks5://127.0.0.1:1081 to film from another network exit.
PROXY="${AEON_RECORDING_PROXY:-}"
EXT_ID="npcdopokfkpfmepknhoecppgdgmkmihh"
BROWSER="${AEON_RECORDING_BROWSER:-recording}"
DPR="${AEON_RECORDING_DPR:-3}"
WINDOW="${AEON_RECORDING_SIZE:-1280x720}" # logical (CSS) px
LOGICAL_W="${WINDOW%x*}"
LOGICAL_H="${WINDOW#*x}"
PHYS_W=$((LOGICAL_W * DPR))
PHYS_H=$((LOGICAL_H * DPR))
SCREEN="${PHYS_W}x${PHYS_H}"
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
# A killed Chrome leaves exit_type "Crashed", and the next start films a "Restore pages?" bubble.
d.setdefault("profile", {}).update(exit_type="Normal", exited_cleanly=True)
with open(pref, "w") as f: json.dump(d, f, separators=(",", ":"))
PY

if [ ! -S "/tmp/.X11-unix/X${NUM}" ]; then
  rm -f "/tmp/.X11-unix/X${NUM}"
  setsid nohup Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN"x24 -nolisten tcp \
    >/tmp/aeon-recording-xvfb.log 2>&1 </dev/null &
  for _ in $(seq 1 20); do [ -S "/tmp/.X11-unix/X${NUM}" ] && break; sleep 0.25; done
fi
# The screen must be exactly the window: larger films black padding, smaller cuts the window off.
GEOMETRY="$(DISPLAY="$DISPLAY_NUM" xdotool getdisplaygeometry 2>/dev/null | tr ' ' 'x' || true)"
if [ -n "$GEOMETRY" ] && [ "$GEOMETRY" != "$SCREEN" ]; then
  echo "Display $DISPLAY_NUM is $GEOMETRY, not $SCREEN. Stop its Xvfb and the recording Chrome, then rerun." >&2
  exit 1
fi

if ! pgrep -f "user-data-dir=$PROFILE" >/dev/null 2>&1; then
  # No --enable-automation and no remote debugging: no test bar, no "controlled by software" bar.
  NET_ARGS=()
  [ -z "$PROXY" ] || NET_ARGS=(--proxy-server="$PROXY" --webrtc-ip-handling-policy=disable_non_proxied_udp)
  DISPLAY="$DISPLAY_NUM" setsid nohup "${AEON_RECORDING_CHROME:-google-chrome}" \
    --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check --disable-gpu --silent-debugger-extension-api \
    --force-device-scale-factor="$DPR" \
    "${NET_ARGS[@]}" \
    --window-size="$LOGICAL_W,$LOGICAL_H" --window-position=0,0 about:blank \
    >/tmp/aeon-recording-chrome.log 2>&1 </dev/null &
fi

# Chrome rounds --window-size at high DPR and leaves a 1 px black edge: pin the exact physical size.
WID=""
for _ in $(seq 1 40); do
  WID="$(DISPLAY="$DISPLAY_NUM" xdotool search --onlyvisible --class google-chrome 2>/dev/null | tail -1 || true)"
  [ -z "$WID" ] || break
  sleep 0.25
done
[ -z "$WID" ] || DISPLAY="$DISPLAY_NUM" xdotool windowmove "$WID" 0 0 windowsize "$WID" "$PHYS_W" "$PHYS_H"

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

# Clean-frame check: a bar under the toolbar ("controlled by automated software", "Restore pages?")
# steals viewport height; the wrong DPR means a soft master. Refuse to film either.
FRAME="$(aeon tool --browser "$BROWSER" browser_code \
  '{"code":"return {dpr: devicePixelRatio, bars: outerHeight - innerHeight, w: innerWidth};"}' 2>/dev/null || true)"
python3 - "$FRAME" "$DPR" "$LOGICAL_W" <<'PY' || exit 1
import json, re, sys
raw, dpr, width = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
m = re.search(r'\{[^{}]*"dpr"[^{}]*\}', raw.replace('\\"', '"'))
if not m:
    print("Clean-frame check skipped (the page could not be read).", file=sys.stderr)
    sys.exit(0)
f = json.loads(m.group(0))
problems = []
if abs(f["dpr"] - dpr) > 0.01:
    problems.append(f"devicePixelRatio is {f['dpr']}, expected {dpr:g}")
# Tab strip + toolbar is ~87 CSS px; any infobar adds 40 or more.
if f["bars"] > 110:
    problems.append(f"{f['bars']} px of browser UI above the page: an infobar is showing")
if f["w"] != width:
    problems.append(f"viewport is {f['w']} px wide, expected {width}")
if problems:
    print("Not a clean frame: " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)
PY

echo "Recording Chrome ready: browser=$BROWSER display=$DISPLAY_NUM profile=$PROFILE capture=$SCREEN (DPR $DPR)"
echo "Record with: AEON_RECORDING_DPR=$DPR aeon record start --window chrome"
