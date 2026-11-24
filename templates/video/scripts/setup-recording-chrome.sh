#!/usr/bin/env bash
# One-time, idempotent setup for the SEPARATE recording Chrome. Never touches aeon-chrome or
# aeon-daemon: eval keeps running on its own CFT browser/profile/display.
# Default capture: a 1280x720 logical window at DPR 2, so frames are a 2560x1440 master that
# delivers a sharp 1920x1080 cut with up to a 1.33x optical push-in (2-3x less disk and a faster
# encode than 4K). Set AEON_RECORDING_DPR=3 for a 3840x2160 master on flagship shoots. The display and DPR are saved for
# `aeon record --browser <name>`, so events.json carries dpr and the logical size.
set -euo pipefail

DISPLAY_NUM="${AEON_RECORDING_DISPLAY:-:120}"
PROFILE="${AEON_RECORDING_PROFILE:-$HOME/.cache/aeon-recording-profile}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${AEON_EXTENSION_DIR:-$(cd "$KIT_DIR/../.." 2>/dev/null && pwd)/apps/chrome-extension/native-dist}"
# Optional, e.g. socks5://127.0.0.1:1081 to film from another network exit.
PROXY="${AEON_RECORDING_PROXY:-}"
EXT_ID="npcdopokfkpfmepknhoecppgdgmkmihh"
BROWSER="${AEON_RECORDING_BROWSER:-recording}"
DPR="${AEON_RECORDING_DPR:-2}"
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
manifest = json.load(open(os.path.join(ext_dir, "manifest.json")))
perms = {
    "api": manifest.get("permissions", []),
    "explicit_host": manifest.get("host_permissions", []),
    "scriptable_host": manifest.get("host_permissions", []),
}
if ext_id not in settings:
    settings[ext_id] = {
        "location": 4, "state": 1,
        "from_webstore": False, "was_installed_by_default": False,
        "was_installed_by_oem": False, "creation_flags": 38,
        "active_permissions": perms, "granted_permissions": perms,
        "content_settings": [], "incognito_content_settings": [],
        "incognito_preferences": {}, "preferences": {},
        "regular_only_preferences": {}, "withholding_permissions": False,
    }
# Always point at THIS build: an entry left by an older run (another worktree) otherwise loads a
# stale extension silently.
entry = settings[ext_id]
entry.update(path=ext_dir, manifest=manifest, state=1)
entry["active_permissions"] = entry["granted_permissions"] = perms
d["extensions"].setdefault("ui", {})["developer_mode"] = True
d.setdefault("browser", {})["has_seen_welcome_page"] = True
# The system frame (undecorated by the window manager below): no caption buttons in the tab strip.
d["browser"]["custom_chrome_frame"] = False
# Alt+Shift+Space summons the cursor box; seed the binding when nothing holds it yet.
commands = d["extensions"].setdefault("commands", {})
old_key = "linux:Ctrl+Shift+Space"
if commands.get(old_key, {}).get("command_name") == "summon-orb":
    del commands[old_key]
key = "linux:Alt+Shift+Space"
if key not in commands:
    commands[key] = {"command_name": "summon-orb", "extension": ext_id, "global": False}
# Chrome 157 draws a New Tab Page footer ("Aeon" + "Customize Chrome") under extension pages.
d.setdefault("ntp_footer", {}).setdefault("settings", {}).update(
    extension_attribution=False, management_notice=False)
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
# Xvfb has no window manager: focus (and so Alt+Shift+Space) is unreliable. When openbox is
# installed and nothing manages the display, start it undecorated with Chrome maximized, so the
# frame never shows caption buttons or black borders.
if command -v openbox >/dev/null 2>&1 && \
  ! DISPLAY="$DISPLAY_NUM" xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id"; then
  RC="$PROFILE/openbox-rc.xml"
  cat >"$RC" <<'XML'
<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <applications>
    <application class="*"><decor>no</decor></application>
    <application class="Google-chrome"><decor>no</decor><maximized>yes</maximized></application>
  </applications>
</openbox_config>
XML
  DISPLAY="$DISPLAY_NUM" setsid nohup openbox --config-file "$RC" \
    >/tmp/aeon-recording-openbox.log 2>&1 </dev/null &
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
  # It opens on Aeon's own new-chat canvas, not about:blank: the engine lists and drives web and Aeon
  # pages only, so a blank start leaves nothing for `aeon record ui` or the frame check to read.
  # No --enable-automation and no remote debugging: no test bar, no "controlled by software" bar.
  NET_ARGS=()
  [ -z "$PROXY" ] || NET_ARGS=(--proxy-server="$PROXY" --webrtc-ip-handling-policy=disable_non_proxied_udp)
  DISPLAY="$DISPLAY_NUM" setsid nohup "${AEON_RECORDING_CHROME:-google-chrome}" \
    --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check --disable-gpu --silent-debugger-extension-api \
    --force-device-scale-factor="$DPR" \
    --disable-features=NtpFooter \
    "${NET_ARGS[@]}" \
    --window-size="$LOGICAL_W,$LOGICAL_H" --window-position=0,0 "chrome-extension://$EXT_ID/home.html?host=panel" \
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

# Remember where this browser lives, so `aeon record ... --browser $BROWSER` finds its display and
# DPR without exported DISPLAY/AEON_RECORDING_DPR (the CLI's dataDirectory()/recordings/browsers.json).
DATA_DIR="${AEON_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/aeon/data}"
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
aeon tool --browser "$BROWSER" browser_code \
  '{"code":"await browser.settings({agentInFront:true, cursor:\"shown\"}); return true;"}' \
  >/dev/null 2>&1 || true

# Clean-frame check: a bar under the toolbar ("controlled by automated software", "Restore pages?")
# steals viewport height; the wrong DPR means a soft master. Refuse to film either. Page code cannot
# run in Aeon's own pages, so the active tab visits a plain page for the read and comes back: no tab
# opens (a new one would join the session's tab group) and none is left behind.
FRAME="$(aeon tool --browser "$BROWSER" browser_code \
  '{"code":"const tabs = await browser.tabs(); const tab = tabs.find((t) => t.active) ?? tabs[0]; if (!tab) throw new Error(\"no tab\"); const page = browser.page(tab.id); const back = tab.aeonUi ? tab.url : null; if (back) await page.navigate(\"https://example.com/\"); try { return await page.inspect(() => ({dpr: devicePixelRatio, outer: outerHeight, inner: innerHeight, w: innerWidth})); } finally { if (back) await page.cdp(\"Page.navigate\", {url: back}); }"}' 2>&1 || true)"
python3 - "$FRAME" "$DPR" "$LOGICAL_W" "$LOGICAL_H" <<'PY' || exit 1
import json, re, sys
raw, dpr, width, height = sys.argv[1], float(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
m = re.search(r'\{[^{}]*"dpr"[^{}]*\}', raw.replace('\\"', '"'))
if not m:
    print("Not a clean frame: the active tab could not be read: " + raw.strip()[:300], file=sys.stderr)
    sys.exit(1)
f = json.loads(m.group(0))
# Undecorated under openbox/Xvfb, outerHeight can be 0: the window is the logical size we set.
outer = f["outer"] if f["outer"] > f["inner"] else height
bars = outer - f["inner"]
problems = []
if abs(f["dpr"] - dpr) > 0.01:
    problems.append(f"devicePixelRatio is {f['dpr']}, expected {dpr:g}")
# Tab strip + toolbar is ~87 CSS px; any infobar adds 40 or more.
if bars > 110:
    problems.append(f"{bars} px of browser UI above the page: an infobar is showing")
if f["w"] != width:
    problems.append(f"viewport is {f['w']} px wide, expected {width}")
if problems:
    print("Not a clean frame: " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"Clean frame: DPR {f['dpr']:g}, {bars} px of browser UI, {f['w']} px wide")
PY

echo "Recording Chrome ready: browser=$BROWSER display=$DISPLAY_NUM profile=$PROFILE capture=$SCREEN (DPR $DPR)"
echo "Record with: aeon record start --window chrome --browser $BROWSER"
