# Aeon video starter kit (Remotion)

Aeon records; it does not render. This kit is plain Remotion files you install and render yourself.
It reads `events.json` from `aeon record` and draws only what really happened: zooms, speed-ups and
the cursor all come from the log (see `EVENTS.md`). It has a Chrome frame (horizontal or vertical
tabs, light or dark), captions, a title card, a "sped up N×" badge, an end card, and a code-wallpaper
background option.

## Quick start

```bash
npm install
# put a recording's frames in public/frames/ and its events.json next to src/recording.json:
cp /path/to/recording/frames/*.jpg public/frames/
cp /path/to/recording/events.json src/recording.json
npm run render             # out/video.mp4 (16:9)
npm run render:vertical    # out/video-vertical.mp4 (9:16, vertical tabs)
npm run still              # one frame, to check it before rendering
```

The kit ships a tiny fixture (one solid-colour frame, two events), so `npm run still` works before
you copy anything in.

### Prove the kit renders (the exact command used to verify this kit)

```bash
npm install
# the fixture's clip declares 60 frames; make the frame files for the proof:
for i in $(seq -w 1 60); do cp public/frames/000001.jpg "public/frames/0000$i.jpg"; done
npx remotion still src/Root.tsx Video out/frame16x9.png --frame=30          # 16:9
npx remotion still src/Root.tsx VideoVertical out/frame9x16.png --frame=30  # 9:16, vertical tabs
npx remotion render src/Root.tsx Video out/short.mp4 --frames=0-59 --codec=h264  # a 2-second clip
```

This ran once in a temp dir (Remotion 4.0.x, headless shell downloaded on first render): both stills
and the clip rendered, with the Chrome frame, the drawn cursor and the caption visible.

## One full example: two clips, a caption, a title card, 16:9 and 9:16

Two clips: the page Aeon drove (`events.json` clip) and the chat beside it (a second take). The
caption and title card are in the edit; the speed badge is derived from gaps in the log.

```ts
// src/edit.ts — import this from Root.tsx instead of the default buildProps() when you want a
// hand-directed two-clip video. The API is the kit's own; nothing is compiled into Aeon.
import events from "./recording.json";
import { emptyEdit, OUTPUTS, style } from "./presets";
import { fromEvents } from "./zooms-from-events";
import { staticFile } from "remotion";
import type { RenderProps } from "./types";

export function twoClipEdit(portrait: boolean): RenderProps {
  const vp = { width: events.clip.width, height: events.clip.height };
  const derived = fromEvents(events as any, vp);                 // zooms + cursor + segments
  const frames = Array.from({ length: events.clip.frames }, (_, i) => ({
    t: (i * 1000) / events.clip.fps,
    f: `${String(i + 1).padStart(6, "0")}.jpg`,
  }));
  return {
    base: staticFile("frames/"),
    cursor: derived.cursor,                                      // only from events.json
    edit: {
      ...emptyEdit(portrait ? OUTPUTS["9x16"]! : OUTPUTS["16x9"]!, vp, events.clip.fps),
      frames,
      source: { viewport: vp, fps: events.clip.fps, duration: events.clip.durationMs, mobile: false, url: "https://example.com" },
      // horizontal tabs on 16:9, vertical tabs on 9:16; switch theme: 'light' or 'dark'
      style: style({ frame: portrait ? "vertical" : "horizontal", theme: "dark" }),
      zooms: derived.zooms,
      segments: derived.segments,
      overlays: [{ type: "caption", t0: 800, t1: 2600, text: "Find the answer" }],
      intro: { text: "One task, start to finish", subtitle: "Recorded with Aeon", duration: 1200 },
      outro: { text: "Done", duration: 1000 },
      // a second clip beside the page (chat, or a second tab):
      side: {
        frames: frames.map((f) => ({ ...f, f: `chat-${f.f}` })),
        viewport: vp,
        title: "Aeon",
      },
    },
  };
}
```

Register it as your composition in `src/Root.tsx` (`<Composition id="TwoClip" component={Video}
defaultProps={twoClipEdit(false)} … />`) and render:

```bash
npx remotion render src/Root.tsx TwoClip out/two-clip.mp4
npx remotion render src/Root.tsx TwoClip out/two-clip-vertical.mp4 --props='{"portrait":true}'
```

**Options you can render:** 16:9 (`1920×1080`), 9:16 (`1080×1920`) and square (`1080×1080`);
a Chrome frame with horizontal or vertical tabs, light or dark; captions; a title card; a
"sped up N×" badge (only where the log has a compressed gap); an end card; a code-wallpaper
background (put a code screenshot in `public/` and set `style.codeWallpaper`). Which tab shows
when is an edit decision in `side`/`frames`, not a re-recording.

**House style:** clean and readable on a phone. Keep text big, cap lines short, and let the picture
breathe; zoom to what Aeon actually clicked or typed. Real-window recordings should fill the frame
edge to edge and show the real pointer — do not draw a second cursor over them.

**Honesty rule:** zooms, speed-ups and the cursor come only from `events.json`. Never show Aeon
doing anything it did not do. A log with no events produces no zooms, no speed badge and no cursor.

## One-command demo video (recording Chrome, separate from eval)

The VPS has a second, branded Chrome on its own Xvfb display and profile, connected to the same
daemon as browser `recording`; eval and its services are never touched. The profile loads Aeon
unpacked via Developer mode Preferences (branded Chrome ignores `--load-extension`) and holds the
native host manifest plus `agentInFront`/cursor settings for filming. Setup is idempotent.
From this kit: `npm install` once, then
`scripts/demo-video.sh "<task>" [--out out/demo.mp4] [--fps 15] [--max-seconds 30]`.
Set `AEON_RECORDING_PROXY` (e.g. a socks5 URL) to film through another network exit.
It starts `aeon record start --window chrome`, runs `aeon run --browser recording "<task>"`, stops
with `--chat <id>` (real actions in `events.json`), copies frames + log in, and renders
`RecordingVertical`: 720×1280, ≤30 s, H.264, real frames edge to edge, Aeon's own cursor only — no drawn
cursor, zooms, captions, speed-ups or title cards. Prints the output path. One render at a time.

## Files

| File | What it is |
|---|---|
| `src/ChromeFrame.tsx` | drawn Chrome window, horizontal/vertical tabs, light/dark, split panes |
| `src/Scene.tsx` | real frames, camera zoom, drawn Aeon cursor and click press |
| `src/Video.tsx` | background, title card, captions, speed badge, end card |
| `src/zooms-from-events.ts` | cursor path, zooms and speed segments derived from `events.json` |
| `src/layout.ts`, `src/camera.ts`, `src/timeline.ts` | framing, spring camera, source↔video time |
| `src/Root.tsx`, `src/index.ts` | the three compositions (16:9, 9:16, square) |
| `EVENTS.md` | the `events.json` format |
