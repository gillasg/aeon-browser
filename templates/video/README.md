# Aeon Director's Studio

A Remotion kit that turns a real `aeon record` take into a film: real Chrome, staged, lit, framed,
paced and scored. It never fakes a pixel or a millisecond. Everything comes from the recording's
`events.json` (see [EVENTS.md](EVENTS.md)) plus an optional `director.json` with your cues.

Get it with `aeon video kit <dir>`. It is not part of Aeon's build.

## Compositions

| id               | size      | what it is                                                       |
| ---------------- | --------- | ---------------------------------------------------------------- |
| `DirectorCut`    | 1920×1080 | The flagship cut, 30 fps: Stage, Camera, Pair, Holds, End, score |
| `DirectorSquare` | 1080×1080 | The same edit framed for a phone feed, from the same master      |
| `RecordingRaw`   | 1920×1080 | The unedited proof: real frames, full-bleed, nothing added       |

`aeon record` itself stays raw. The studio is a separate step.

## Shoot

```sh
scripts/setup-recording-chrome.sh             # 1280x720 logical at DPR 3 -> 3840x2160 master
scripts/demo-video.sh "find the price of ..."  # record, lint, score, render out/demo.mp4
```

The recording Chrome runs on its own Xvfb display, sized to exactly `1280·DPR × 720·DPR`, so
there is no black padding and no cutoff. It launches without `--enable-automation`, resets the
profile's crash state on every run, and refuses to film when an infobar shows or the DPR is wrong.
`AEON_RECORDING_DPR=2` gives a 2560×1440 master on smaller machines.

## Edit

```sh
npm install
cp <recording>/events.json src/recording.json
cp <recording>/frames/*.jpg public/frames/
npm run lint:edit     # the taste linter, both cuts
npm run audio         # public/audio/score.wav from events.json + director.json
npm run still         # out/still.png
npm run render        # lint -> score -> out/DirectorCut.mp4 (+ .json metadata)
npm run render:square
npm run render:raw
```

`node scripts/render.mjs DirectorCut --no-lint` renders anyway and stamps `"lint": "off"` in the
metadata file beside the video.

## The grammar

- **Stage** (`Stage.tsx`). The window rests on an architectural surface: `obsidian` (`#0B0C0F`,
  soft overhead light) by default, `stone` (`#ECEAE4`) for dark pages. It gets a grounded
  multi-layer shadow and a 1 px rim. `focusDim` (0 to 0.38) darkens the edges during a push-in.
  It never blurs.
- **Camera** (`camera.ts`, `Camera.tsx`). Every move uses one curve, `cubic-bezier(0.16, 1, 0.3, 1)`,
  over 480–620 ms, with no overshoot. `fromEvents()` pushes in on the real element bounds of each
  click, type and key press, arrives as the action happens, and breathes out after. Or write cues
  yourself: `{ tStart, tEnd, framing: "stage" | "inside" | "focus", focusRect?, scale?, easeMs? }`.
  **Native-pixel invariant:** a source pixel is never drawn larger than a delivery pixel. A 3×
  master allows up to 2× into 1080p.
- **Pair** (`Pair.tsx`, `pair.ts`). At `pairAtMs` the browser glides to 58% and the real terminal
  (`#141518` / `#E6E8EC`, monospace) emerges at 42%. Set `alignPageY` (source px, from the element's
  box) and `alignTerminalLine`, and the returned line sits on the same scanline as the value on the
  page. No arrows, no highlight boxes.
- **Hold** (`hold.ts`, `Hold.tsx`). After every `receipt` or `result` beat, 1.5–2.0 s of stillness.
  The camera locks, nothing cuts, and the score is silent after the chord.
- **TimeCut** (`TimeCut.tsx`). A real time compression shows the wall clock on both sides, read
  from the recording (`19:02:11 · checked 12` → `21:47:03 · checked 418`).
- **EditorialBeat** (`EditorialBeat.tsx`). At most five words, quiet, in negative space. Never a slide.
- **End** (`End.tsx`). The command an engineer copies and the repo, on `#0B0C0F`. No slogan.
- **Score** (`sound.ts`, `scripts/generate-audio.mjs`). A deterministic 48 kHz 16-bit stereo WAV,
  synthesized offline:
  - hushed 18 ms keys on typing
  - a 25 ms dry trigger on click or Enter
  - a −28 dB D2 + fifth hum during `compile`, which drops to silence on Enter
  - a D5 + A5 arrival chord (6 ms attack, 240 ms decay) on the receipt, then silence through the Hold

## director.json

```json
{
  "surface": "obsidian",
  "focusDim": 0.22,
  "compile": [{ "tStart": 1450, "tEnd": 2400 }],
  "pair": { "pairAtMs": 2450, "alignPageY": 1401, "alignTerminalLine": 3 },
  "editorial": [{ "tStart": 4900, "tEnd": 5900, "text": "Any site. An API." }],
  "segments": [{ "s0": 0, "s1": 6000, "speed": 1 }],
  "timeCuts": [],
  "end": { "command": "aeon mcp shop.example", "repo": "github.com/gillasg/aeon-browser", "durationMs": 2400 },
  "audioSrc": "audio/score.wav"
}
```

All times are ms on the clip clock. `segments` keep stretches of the clip, and the gaps between
them are cuts. A segment with `speed` other than 1 needs a visible `label` (`"4×"`). Optional
fields: `cues` (otherwise derived from events), `holds` (otherwise one after every receipt or
result beat), `beats` (`{ t, beat, box }` when the log does not tag them), and `holdMs`.

## Taste linter

`npm run lint:edit` runs before every render. It fails on:

- upscaling past native pixels, or a source smaller than the output
- a beat element under 9 px tall on a 390 px phone (push in instead)
- any camera move, cut, time cut or Pair reveal inside a Hold
- a speed change with no label
- an editorial line over five words, or hype copy
- full-screen title or stat slides
- `blur`, `tilt`, `glow`, `overshoot`
- eases outside 480–620 ms

It allows lighting, focus dimming, motivated glides, quiet editorial lines and full sound.

## Rules

Zooms, beats and sound cues come only from what Aeon did, as recorded in `events.json`. Never show
Aeon doing something it did not do, and never speed up a run without saying so on screen. The
fixture in `src/recording.json` is one synthetic 3840×2160 frame so the kit renders out of the box.
Replace it with your take.
