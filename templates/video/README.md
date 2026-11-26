# Aeon Open Studio

A blank Remotion canvas around a real `aeon record` take. The camera is fixed: real Chrome,
real frames, real timestamps. The edit is not: every video's `src/Scene.tsx` is written from
scratch around its footage. Get the kit with `aeon video kit <dir>`; it is not part of Aeon's build.

## The loop

1. **Capture.** `aeon film clip.json --out shoot/` (or `aeon record start` / `stop`) writes
   `take/frames/*.jpg`, `take/events.json` (see [EVENTS.md](EVENTS.md)), `contact.png` and
   `take.json`. `scripts/setup-recording-chrome.sh` starts the clean recording Chrome.
2. **Stage.** `cp take/events.json src/recording.json`; frames are staged by `--frames-dir`.
3. **Edit.** Rewrite `src/Scene.tsx` freely. `take` (`src/take.ts`) snaps anything to the clip:
   `take.msToFrame(take.beatTime("receipt") ?? 0)`, `take.frameAt(ms).file`, `take.beats`.
   Keep `sceneConfig` (`width`, `height`, `fps`, `durationInFrames`) exported; Root reads it.
4. **Review stills.** Look at them before rendering the whole film:
   `node scripts/render.mjs Scene --frames-dir take/frames --still-ms 0,2000,6000`
   (or `--stills 0,120,300`) writes `out/stills/still-<frame>.png`.
5. **Render.** `node scripts/render.mjs Scene --out out/film.mp4` writes the MP4 and
   `out/film.mp4.json` (composition, size, fps, frames, elapsedMs).

`aeon film render --kit <dir> --take <take> [--stills ...] [--out file]` runs steps 2, 4 and 5.

## Compositions

- `Scene`: yours, 1920x1080 at 60 fps by default; starts as the raw take full-bleed.
- `RecordingRaw`: the unedited proof, frames edge to edge, nothing added.

Bundles are cached per kit hash in `out/.bundle-<hash>`. Honesty rule: never show Aeon doing
anything it did not do; label every speed change.
