#!/usr/bin/env bash
# One command: record the dedicated recording-Chrome window (1280x720 at DPR 2; AEON_RECORDING_DPR=3 for 4K), run an Aeon task
# in that browser, stop the take, lint the edit, score it, and render the 1920x1080 DirectorCut.
# Usage: scripts/demo-video.sh "<task>" [--out file.mp4] [--fps 30] [--max-seconds 30] [--director director.json]
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROWSER="${AEON_RECORDING_BROWSER:-recording}"
DISPLAY_NUM="${AEON_RECORDING_DISPLAY:-:120}"
MAX_SECONDS="${AEON_VIDEO_MAX_SECONDS:-30}"
export AEON_RECORDING_DPR="${AEON_RECORDING_DPR:-2}"
DIRECTOR=""

usage() { sed -n '2,3p' "$0" | sed 's/^# //'; exit 1; }
TASK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; [ -n "$OUT" ] || usage; shift 2 ;;
    --fps) FPS="${2:-}"; [ -n "$FPS" ] || usage; shift 2 ;;
    --max-seconds) MAX_SECONDS="${2:-}"; [ -n "$MAX_SECONDS" ] || usage; shift 2 ;;
    --director) DIRECTOR="${2:-}"; [ -f "$DIRECTOR" ] || usage; shift 2 ;;
    -h|--help) usage ;;
    *) [ -z "$TASK" ] || usage; TASK="$1"; shift ;;
  esac
done
[ -n "$TASK" ] || usage
OUT="${OUT:-$KIT_DIR/out/demo.mp4}"
FPS="${FPS:-30}"
mkdir -p "$(dirname "$OUT")" "$KIT_DIR/out"

"$KIT_DIR/scripts/setup-recording-chrome.sh"

WORK="$(mktemp -d /tmp/aeon-demo.XXXXXX)"
echo "Recording folder: $WORK/recording" >&2

export DISPLAY="$DISPLAY_NUM"
# Park the real X pointer outside the window: the only visible cursor is Aeon's own cursor.
SCREEN="$(xdotool getdisplaygeometry)"
xdotool mousemove "$(( ${SCREEN%% *} - 5 ))" "$(( ${SCREEN##* } - 5 ))"

aeon record start --window chrome --out "$WORK/recording" --fps "$FPS"

set +e
aeon run --browser "$BROWSER" --max-minutes 2 --json "$TASK" \
  >"$WORK/run.json" 2>"$WORK/run.err"
RUN_RC=$?
set -e
if [ "$RUN_RC" -ne 0 ]; then
  echo "Aeon task returned $RUN_RC; rendering what was captured." >&2
  tail -5 "$WORK/run.err" >&2
fi

# Attach the chat trace at stop so events.json carries the real actions when a chat id exists.
CHAT_ID="$(python3 - "$WORK/run.json" <<'PY'
import json, sys
try:
    rows = json.load(open(sys.argv[1]))
    if isinstance(rows, dict): rows = [rows]
    print(next((r.get("chatId", "") for r in rows if r.get("chatId")), ""))
except Exception:
    print("")
PY
)"
STOP_ARGS=(--out "$WORK/recording")
[ -n "$CHAT_ID" ] && STOP_ARGS+=(--chat "$CHAT_ID")
aeon record stop "${STOP_ARGS[@]}"

# Import only the frames the render uses (≤ MAX_SECONDS); the log comes from aeon record.
mkdir -p "$KIT_DIR/public/frames"
rm -f "$KIT_DIR/public/frames"/*.jpg
LIMIT=$(( MAX_SECONDS * FPS ))
mapfile -t FRAMES < <(find "$WORK/recording/frames" -maxdepth 1 -name '*.jpg' -print | sort)
for frame in "${FRAMES[@]:0:$LIMIT}"; do cp "$frame" "$KIT_DIR/public/frames/"; done
cp "$WORK/recording/events.json" "$KIT_DIR/src/recording.json"
# The camera comes from events.json alone unless a director script is given.
if [ -n "$DIRECTOR" ]; then
  cp "$DIRECTOR" "$KIT_DIR/src/director.json"
else
  printf '{ "surface": "obsidian", "audioSrc": "audio/score.wav" }\n' >"$KIT_DIR/src/director.json"
fi

cd "$KIT_DIR"
# Lints (refuses slop), synthesizes the score, renders H.264, and writes $OUT.json.
node scripts/render.mjs DirectorCut --out "$OUT"

echo "$OUT"
