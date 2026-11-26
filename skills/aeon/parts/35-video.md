## Video demos: record, then edit freely with Remotion

Aeon records; the Open Studio renders. `aeon record start [--window chrome|--screen|--tabs] [--out dir]` then `aeon record stop` write frames, `clip.mp4` and `events.json` (each action's time, position and element box). `aeon film clip.json --out dir` shoots a qualified plan into a raw take plus `contact.png` and `take.json`. `aeon video kit <dir>` copies the studio: a blank `src/Scene.tsx` you write from scratch around the real footage, `src/recording.ts` helpers (`msToFrame`, `beatTime`, `frameAt`) to snap motion to real timestamps, and `scripts/render.mjs` (`--stills` / `--still-ms` PNGs to review before the MP4).

Never show Aeon doing anything it did not do; label every speed change. See `help('video')`.
