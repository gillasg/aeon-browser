## Video demos: record, then direct with Remotion

Aeon records; the Director's Studio renders. `aeon record start [--window chrome|--screen|--tabs] [--out dir]` then `aeon record stop` write frames, `clip.mp4` and `events.json` (each action's time, position and element box). `aeon video kit <dir>` copies the studio: `DirectorCut` (1920x1080) and `DirectorSquare` from Stage, Camera (push-ins on real bounds, never past native pixels), Pair (browser beside terminal), Hold, TimeCut and End, a synthesized score, and a taste linter run before every render.

Cinema, never slides; still after the result lands; readable on a phone. Zooms, beats and sound come only from `events.json`; label every speed change. See `help('video')`.
