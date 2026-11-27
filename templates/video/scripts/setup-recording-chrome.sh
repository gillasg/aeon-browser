#!/usr/bin/env bash
# One-time, idempotent setup for the SEPARATE recording Chrome. Never touches graft-chrome or
# graft-daemon: eval keeps running on its own CFT browser/profile/display.
# Default capture: a 1280x720 logical window at DPR 3, so frames are a 3840x2160 master that
# delivers a sharp 1920x1080 cut with up to a 2x optical push-in (the phone floor needs it).
# Set GRAFT_RECORDING_DPR=2 only for quick, non-house takes. The display and DPR are saved for
# `graft record --browser <name>`, so events.json carries dpr and the logical size.
set -euo pipefail

DISPLAY_NUM="${GRAFT_RECORDING_DISPLAY:-:120}"
PROFILE="${GRAFT_RECORDING_PROFILE:-$HOME/.cache/graft-recording-profile}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${GRAFT_EXTENSION_DIR:-$(cd "$KIT_DIR/../.." 2>/dev/null && pwd)/apps/chrome-extension/native-dist}"
# Optional, e.g. socks5://127.0.0.1:1081 to film from another network exit.
PROXY="${GRAFT_RECORDING_PROXY:-}"
EXT_ID="npcdopokfkpfmepknhoecppgdgmkmihh"
BROWSER="${GRAFT_RECORDING_BROWSER:-recording}"
DPR="${GRAFT_RECORDING_DPR:-3}"
WINDOW="${GRAFT_RECORDING_SIZE:-1280x720}" # logical (CSS) px
LOGICAL_W="${WINDOW%x*}"
LOGICAL_H="${WINDOW#*x}"
PHYS_W=$((LOGICAL_W * DPR))
PHYS_H=$((LOGICAL_H * DPR))
SCREEN="${PHYS_W}x${PHYS_H}"
NUM="${DISPLAY_NUM#:}"
# Chrome takes its UI and New Tab Page language from the locale: film English on any host.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LANGUAGE=en_US:en

mkdir -p "$PROFILE/Default" "$PROFILE/NativeMessagingHosts"

# Native messaging is looked up inside the custom --user-data-dir, not in ~/.config/google-chrome.
HOST="$PROFILE/NativeMessagingHosts/com.graft.native_host.json"
if [ ! -f "$HOST" ]; then
  for candidate in \
    "$HOME/.config/google-chrome/NativeMessagingHosts/com.graft.native_host.json" \
    "$HOME/.config/chromium/NativeMessagingHosts/com.graft.native_host.json"; do
    if [ -f "$candidate" ]; then cp "$candidate" "$HOST"; break; fi
  done
fi
[ -f "$HOST" ] || { echo "Graft native host manifest not found" >&2; exit 1; }

# Branded Chrome ignores --load-extension. Seed the unpacked extension into Preferences instead:
# Developer mode is on and the profile loads Graft from its own directory on every start.
if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "Built extension not found: $EXT_DIR (set GRAFT_EXTENSION_DIR)" >&2
  exit 1
fi
python3 "$KIT_DIR/scripts/seed-recording-prefs.py" "$PROFILE/Default/Preferences" "$EXT_DIR" "$EXT_ID"

if [ ! -S "/tmp/.X11-unix/X${NUM}" ]; then
  rm -f "/tmp/.X11-unix/X${NUM}"
  setsid nohup Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN"x24 -nolisten tcp \
    >/tmp/graft-recording-xvfb.log 2>&1 </dev/null &
  for _ in $(seq 1 20); do [ -S "/tmp/.X11-unix/X${NUM}" ] && break; sleep 0.25; done
fi
# Xvfb has no window manager: focus (and so Alt+Shift+Space) is unreliable. When openbox is
# installed and nothing manages the display, start it undecorated with Chrome maximized, so the
# frame never shows caption buttons or black borders.
if command -v openbox >/dev/null 2>&1 && \
  ! DISPLAY="$DISPLAY_NUM" xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id"; then
  RC="$PROFILE/openbox-rc.xml"
  cat >"$RC" <<'XML'
<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>no</focusNew><followMouse>no</followMouse></focus>
  <applications>
    <application class="*"><decor>no</decor></application>
    <application class="Google-chrome"><decor>no</decor><maximized>yes</maximized></application>
  </applications>
</openbox_config>
XML
  DISPLAY="$DISPLAY_NUM" setsid nohup openbox --config-file "$RC" \
    >/tmp/graft-recording-openbox.log 2>&1 </dev/null &
  for _ in $(seq 1 20); do
    DISPLAY="$DISPLAY_NUM" xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" && break
    sleep 0.25
  done
fi
# The screen must be exactly the window: larger films black padding, smaller cuts the window off.
GEOMETRY="$(DISPLAY="$DISPLAY_NUM" xdotool getdisplaygeometry 2>/dev/null | tr ' ' 'x' || true)"
if [ -n "$GEOMETRY" ] && [ "$GEOMETRY" != "$SCREEN" ]; then
  echo "Display $DISPLAY_NUM is $GEOMETRY, not $SCREEN. Stop its Xvfb and the recording Chrome, then rerun." >&2
  exit 1
fi

if ! pgrep -f "user-data-dir=$PROFILE" >/dev/null 2>&1; then
  # Saved tab groups (every session's group, kept by Chrome) live in the profile's sync store and
  # come back as bookmarks-bar chips. The recording profile is never signed in: drop them while
  # Chrome is down, on every setup or restart.
  rm -rf "$PROFILE/Default/Sync Data"
  # It opens on Graft's own new-chat canvas, not about:blank: the engine lists and drives web and Graft
  # pages only, so a blank start leaves nothing for `graft record ui` or the frame check to read.
  # No --enable-automation and no remote debugging: no test bar, no "controlled by software" bar.
  NET_ARGS=()
  [ -z "$PROXY" ] || NET_ARGS=(--proxy-server="$PROXY" --webrtc-ip-handling-policy=disable_non_proxied_udp)
  DISPLAY="$DISPLAY_NUM" setsid nohup "${GRAFT_RECORDING_CHROME:-google-chrome}" \
    --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check --disable-gpu --silent-debugger-extension-api \
    --force-device-scale-factor="$DPR" \
    --lang=en-US \
    --disable-features=NtpFooter,TabGroupsSaveV2,TabGroupsSaveUIUpdate,TabGroupSyncServiceDesktopMigration \
    "${NET_ARGS[@]}" \
    --window-size="$LOGICAL_W,$LOGICAL_H" --window-position=0,0 "chrome-extension://$EXT_ID/home.html?host=panel" \
    >/tmp/graft-recording-chrome.log 2>&1 </dev/null &
fi

# Chrome rounds --window-size at high DPR and leaves a 1 px black edge: pin the exact physical size.
WID=""
for _ in $(seq 1 40); do
  WID="$(DISPLAY="$DISPLAY_NUM" xdotool search --onlyvisible --class google-chrome 2>/dev/null | tail -1 || true)"
  [ -z "$WID" ] || break
  sleep 0.25
done
[ -z "$WID" ] || DISPLAY="$DISPLAY_NUM" xdotool windowmove "$WID" 0 0 windowsize "$WID" "$PHYS_W" "$PHYS_H"

# Wait for this profile to register with the daemon; name it so `graft run --browser` is explicit.
for _ in $(seq 1 40); do
  ID="$(python3 - "$BROWSER" <<'PY'
import json, subprocess, sys
try:
    out = subprocess.check_output(["graft", "browsers", "--json"], text=True, stderr=subprocess.DEVNULL)
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
    rows = json.loads(subprocess.check_output(["graft", "browsers", "--json"], text=True,
                                              stderr=subprocess.DEVNULL)).get("browsers", [])
except Exception:
    rows = []
print(any(r.get("name") == sys.argv[1] for r in rows))
PY
)"
if [ -n "$ID" ] && [ "$NAMED" != "True" ]; then
  graft browsers name "$ID" "$BROWSER" >/dev/null
fi

# Remember where this browser lives, so `graft record ... --browser $BROWSER` finds its display and
# DPR without exported DISPLAY/GRAFT_RECORDING_DPR (the CLI's dataDirectory()/recordings/browsers.json).
DATA_DIR="${GRAFT_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/graft/data}"
mkdir -p "$DATA_DIR/recordings"
python3 - "$DATA_DIR/recordings/browsers.json" "$BROWSER" "$DISPLAY_NUM" "$DPR" <<'PY'
import json, os, sys
path, name, display, dpr = sys.argv[1:5]
try:
    saved = json.load(open(path)) if os.path.exists(path) else {}
except Exception:
    saved = {}
saved[name] = {"display": display, "dpr": float(dpr)}
with open(path, "w") as f: json.dump(saved, f, indent=2)
PY

# Per-profile settings through the daemon, targeted at this browser only (eval is untouched).
graft tool --browser "$BROWSER" browser_code \
  '{"code":"await browser.settings({agentInFront:true, agentTabPlacement:\"group\", cursor:\"shown\"}); return true;"}' \
  >/dev/null 2>&1 || true

# Clean-frame check: a bar under the toolbar (bookmarks, "controlled by automated software",
# "Restore pages?") steals viewport height; the wrong DPR means a soft master. Refuse to film either.
# Page code cannot run in Graft's own pages or chrome:// pages (a fresh start can sit on the New Tab
# Page, which browser.tabs() does not list), so the probe opens its own tab on a tiny local page,
# reads it and closes it. Local, not a public site: instant and deterministic even over a proxy
# (Chrome never proxies loopback).
PROBE_DIR="$(mktemp -d)"
printf '<!doctype html><title>frame</title><body style="margin:0;background:#fff">' >"$PROBE_DIR/index.html"
PROBE_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
python3 -m http.server "$PROBE_PORT" --bind 127.0.0.1 --directory "$PROBE_DIR" >/dev/null 2>&1 &
PROBE_PID=$!
stop_probe() { kill "$PROBE_PID" 2>/dev/null || true; rm -rf "$PROBE_DIR"; }
trap stop_probe EXIT
for _ in $(seq 1 20); do
  python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$PROBE_PORT/', timeout=1)" 2>/dev/null && break
  sleep 0.1
done
FRAME="$(graft tool --browser "$BROWSER" browser_code \
  "{\"code\":\"const page = await browser.openTab('http://127.0.0.1:$PROBE_PORT/', {newTab: true}); try { return await page.inspect(() => ({dpr: devicePixelRatio, outer: outerHeight, inner: innerHeight, w: innerWidth})); } finally { await page.close(); }\"}" 2>&1 || true)"
stop_probe
trap - EXIT
python3 "$KIT_DIR/scripts/check-recording-frame.py" "$FRAME" "$DPR" "$LOGICAL_W" "$LOGICAL_H" || exit 1

echo "Recording Chrome ready: browser=$BROWSER display=$DISPLAY_NUM profile=$PROFILE capture=$SCREEN (DPR $DPR)"
echo "Record with: graft record start --window chrome --browser $BROWSER"
