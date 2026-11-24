#!/usr/bin/env python3
# Clean-frame verdict: usage check-recording-frame.py <browser_code output> <dpr> <width> <height>.
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
# Tab strip + toolbar is ~87 CSS px; the bookmarks bar adds ~32, any infobar 40 or more.
if bars > 110:
    problems.append(f"{bars} px of browser UI above the page: a bookmarks bar or an infobar is showing")
if f["w"] != width:
    problems.append(f"viewport is {f['w']} px wide, expected {width}")
if problems:
    print("Not a clean frame: " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"Clean frame: DPR {f['dpr']:g}, {bars} px of browser UI, {f['w']} px wide")
