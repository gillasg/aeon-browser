// Which source frames an edit actually shows, so staging links only those (≤ a few hundred)
// instead of copying a whole take.
import { frameAt, toSource, videoLength } from "./timeline.ts";
import type { DirectorEdit } from "./types.ts";

export function referencedFrames(edit: DirectorEdit): string[] {
  const picture = videoLength(edit.segments);
  const step = 1000 / edit.output.fps;
  const names = new Set<string>();
  for (let vt = 0; vt <= picture; vt += step) {
    const f = frameAt(edit.source.frames, toSource(edit.segments, vt));
    if (f) names.add(f.f);
  }
  return [...names].sort();
}
