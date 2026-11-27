#!/usr/bin/env bash
# One command: record the dedicated recording-Chrome window (1280x720 at DPR 3, a 3840x2160 master), run a Graft task
# in that browser, stop the take, and render src/Scene.tsx (1920x1080) around the real frames.
# Usage: scripts/demo-video.sh "<task>" [--out file.mp4] [--fps 30] [--max-minutes N]
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROWSER="${GRAFT_RECORDING_BROWSER:-recording}"
DISPLAY_NUM="${GRAFT_RECORDING_DISPLAY:-:120}"
MAX_MINUTES="${GRAFT_VIDEO_MAX_MINUTES:-}"
export GRAFT_RECORDING_DPR="${GRAFT_RECORDING_DPR:-3}"

usage() { sed -n '2,3p' "$0" | sed 's/^# //'; exit 1; }
TASK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; [ -n "$OUT" ] || usage; shift 2 ;;
    --fps) FPS="${2:-}"; [ -n "$FPS" ] || usage; shift 2 ;;
    --max-minutes) MAX_MINUTES="${2:-}"; [ -n "$MAX_MINUTES" ] || usage; shift 2 ;;
    -h|--help) usage ;;
    *) [ -z "$TASK" ] || usage; TASK="$1"; shift ;;
  esac
done
[ -n "$TASK" ] || usage
OUT="${OUT:-$KIT_DIR/out/demo.mp4}"
FPS="${FPS:-30}"
mkdir -p "$(dirname "$OUT")" "$KIT_DIR/out"

"$KIT_DIR/scripts/setup-recording-chrome.sh"

WORK="$(mktemp -d /tmp/graft-demo.XXXXXX)"
echo "Recording folder: $WORK/recording" >&2

export DISPLAY="$DISPLAY_NUM"
# Park the real X pointer outside the window: the only visible cursor is Graft's own cursor.
SCREEN="$(xdotool getdisplaygeometry)"
xdotool mousemove "$(( ${SCREEN%% *} - 5 ))" "$(( ${SCREEN##* } - 5 ))"

graft record start --window chrome --out "$WORK/recording" --fps "$FPS"

set +e
graft run --browser "$BROWSER"${MAX_MINUTES:+ --max-minutes $MAX_MINUTES} --json "$TASK" \
  >"$WORK/run.json" 2>"$WORK/run.err"
RUN_RC=$?
set -e
if [ "$RUN_RC" -ne 0 ]; then
  echo "Graft task returned $RUN_RC; rendering what was captured." >&2
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
graft record stop "${STOP_ARGS[@]}"

# Import every frame of the take (hardlinks when on one disk); the edit spans the whole clip.
mkdir -p "$KIT_DIR/public/frames"
rm -f "$KIT_DIR/public/frames"/*.jpg
find "$WORK/recording/frames" -maxdepth 1 -name '*.jpg' -exec cp -l -t "$KIT_DIR/public/frames/" {} + 2>/dev/null \
  || find "$WORK/recording/frames" -maxdepth 1 -name '*.jpg' -exec cp -t "$KIT_DIR/public/frames/" {} +
cp "$WORK/recording/events.json" "$KIT_DIR/src/recording.json"

cd "$KIT_DIR"
# Renders src/Scene.tsx (rewrite it per video) to H.264 and writes $OUT.json.
node scripts/render.mjs Scene --out "$OUT"

echo "$OUT"
