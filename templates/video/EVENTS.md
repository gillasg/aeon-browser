# `events.json` — the recording log

Every folder `graft record start` creates gets an `events.json`. It is the contract between Graft's
recording and any editor: it says what Graft did, when, and what clip it happened in. Times are
milliseconds. `t` is on the **clip clock**: `t = 0` is the clip's first frame, so an editor can draw
a zoom or a cursor at `t` and it lands on the right frame. `at` is the wall-clock (epoch ms) from
Graft's trace, for auditing. Points are page CSS px unless named `window` (pixels in the captured
window image, when the window was calibrated).

```json
{
  "version": 1,
  "recorder": "graft",
  "clock": "clip",
  "clip": {
    "file": "clip.mp4",
    "source": "window",
    "width": 3840,
    "height": 2160,
    "fps": 30,
    "startedAt": 1731000000000,
    "durationMs": 12400,
    "frames": 372,
    "dpr": 3,
    "logicalWidth": 1280,
    "logicalHeight": 720
  },
  "clips": [{ "...": "one entry per tab with --tabs; the first is also `clip`" }],
  "events": [
    {
      "id": "e1",
      "kind": "click",
      "t": 820,
      "at": 1731000000820,
      "tabId": 4,
      "page": { "x": 412, "y": 308 },
      "window": { "x": 1236, "y": 1185 },
      "box": { "x": 352, "y": 290, "width": 120, "height": 36 },
      "windowBox": { "x": 1056, "y": 1131, "width": 360, "height": 108 },
      "text": "Get started"
    },
    {
      "id": "e2",
      "kind": "type",
      "t": 1310,
      "at": 1731000001310,
      "tabId": 4,
      "page": { "x": 640, "y": 460 },
      "text": "hello",
      "beat": "prompt"
    }
  ],
  "soundCues": [
    { "t": 820, "kind": "trigger" },
    { "t": 1310, "kind": "key" },
    { "t": 1365, "kind": "key" }
  ],
  "terminal": {
    "version": 1,
    "command": "graft tool browser_code ...",
    "startedAt": 1731000002000,
    "events": [
      { "t": 2000, "kind": "in", "text": "graft tool browser_code ..." },
      { "t": 2400, "kind": "out", "text": "done\\n" }
    ]
  },
  "note": "optional: why the action list is incomplete"
}
```

## Fields

- `clip`: size (`width`×`height` in captured px), `fps`, `startedAt` (epoch ms of frame t=0), `durationMs`,
  `frames`, and `file` (`clip.mp4`, or `takes/` with `--tabs`). `source` is `window`, `screen` or
  `tabs`. With `--tabs`, `clips[]` lists one entry per recorded tab (`tabId` on each). When the
  capture DPR is known (`GRAFT_RECORDING_DPR`, set by `setup-recording-chrome.sh`), `dpr`,
  `logicalWidth` and `logicalHeight` are present: `width = logicalWidth × dpr`.
- `events[]`: each thing Graft did:
  - `kind`: `click`, `type`, `press`, `scroll`, `navigate`, `tab-switch`.
  - `t`: ms from clip t=0; `at`: epoch ms of the same moment.
  - `tabId`: the tab it happened in.
  - `page`: where it happened in page CSS px (viewport coordinates at that moment).
  - `window`: the same point in captured-window px, when window-space calibration was available.
  - `text`: what was typed, the key pressed, the destination URL or the tab title. Secrets are not
    included.
  - `scroll`: scroll delta when it is known.
  - `box`: the acted element's bounds in page CSS px (`{x, y, width, height}`), when the trace had
    them; `windowBox`: the same bounds in captured-window px, when the window was calibrated. The
    studio's camera pushes in on these.
  - `beat` (optional): what the event carries in the story, one of `prompt`, `teach`, `compile`,
    `receipt`, `result`, `terminal`, `watch`, `boost`. A `receipt` or `result` opens a Hold.
- `soundCues` (optional): `{t, kind}` with `kind` `key`, `trigger`, `start`, `needs-you`, `done`,
  `arrive` or `shutter`, derived from real events: one `key` per typed character, a `trigger` on
  each click and on Enter, plus the `--cue` of each mark.
- `marks` (optional): beats a script named with `graft record mark <name>`, as
  `{name, t, label?, box?, windowBox?, cue?}`. `t` is on the clip clock. `--selector` records the
  element's `box` (page CSS px) and `windowBox` (clip px: toolbar offset added, scaled by DPR);
  `--box x,y,w,h` gives a `windowBox` directly. `graft record wait --for selector|url|idle|chat`
  blocks on the real condition between marks, and `graft record run "<prompt>"` records one prompt
  start to finish in one command.
- `note`: present when the action list is incomplete (e.g. no trace was attached at start). The clip
  metadata and frames are still valid.
- `terminal`: optional asciinema-style cast from `graft record terminal --out dir --run "<command>"`.
  `command` is what ran, `startedAt` is its wall clock, and `events[]` are `{t, kind, text}` with
  `kind` `in` (the command), `out` or `err`. `t` is on the same clip clock. The kit draws this as a
  pane beside the tab. It shows only what the command printed.

## Rules for an editor

- Zooms, speed-ups and the drawn cursor are derived **only** from `events[]`. Do not invent an
  action, a location or a speed-up that is not in the log.
- A speed-up must carry a visible label (`4×`). Never compress an action Graft actually took
  time over without saying so.
- On a real-window recording the real pointer is already in the frames: draw no second cursor.
- Which tab shows when is an edit decision (a timeline over `clips[]`), never a re-recording.
