import type { Point, RecordingEvents, Segment, VideoEvent, Zoom } from "./types";

/**
 * The honesty rule, in code: zooms, speed-ups and the drawn cursor come ONLY from events.json.
 * Nothing here invents an action or a place Aeon did not act. A clip with no events gets no zooms,
 * no cursor and no speed badge.
 */
export type FromEvents = {
  zooms: Zoom[];
  cursor: { t: number; x: number; y: number }[];
  segments: Segment[];
  captions: { t0: number; t1: number; text: string }[];
};

const duration = (events: RecordingEvents) =>
  events.clip.durationMs || (events.clip.frames / Math.max(1, events.clip.fps)) * 1000;

const actionable = (e: VideoEvent) =>
  e.kind === "click" || e.kind === "type" || e.kind === "scroll";
const at = (e: VideoEvent): Point | undefined => e.window ?? e.page;

/** A box around the real action, clamped to the viewport. */
function boxAround(p: Point, viewport: { width: number; height: number }, w: number, h: number) {
  const bw = Math.min(viewport.width, w);
  const bh = Math.min(viewport.height, h);
  return {
    x: Math.max(0, Math.min(viewport.width - bw, p.x - bw / 2)),
    y: Math.max(0, Math.min(viewport.height - bh, p.y - bh / 2)),
    w: bw,
    h: bh,
  };
}

/**
 * Derive the edit. `viewport` is the clip's CSS viewport (or the calibrated window size when the
 * events carry window-space positions); the caller decides which by how it recorded.
 */
export function fromEvents(
  events: RecordingEvents,
  viewport: { width: number; height: number } = {
    width: events.clip.width || 1280,
    height: events.clip.height || 800,
  },
): FromEvents {
  const points = events.events
    .filter(actionable)
    .map((e) => ({ e, p: at(e) }))
    .filter((x): x is { e: VideoEvent; p: Point } => !!x.p);
  const zooms: Zoom[] = points.map(({ e, p }) => ({
    t0: Math.max(0, e.t - 200),
    t1: e.t + 900,
    box: boxAround(p, viewport, viewport.width * 0.42, viewport.height * 0.42),
    scale: 1.85,
  }));

  // Cursor: rest in the middle, glide to each real position, arrive just before the action.
  const cursor: { t: number; x: number; y: number }[] = [
    { t: 0, x: viewport.width * 0.62, y: viewport.height * 0.66 },
  ];
  for (const { e, p } of points) {
    const prev = cursor[cursor.length - 1]!;
    const arrive = Math.max(prev.t + 120, e.t - 70);
    const leave = Math.max(prev.t, arrive - 600);
    if (leave > prev.t) cursor.push({ t: leave, x: prev.x, y: prev.y });
    for (let j = 1; j <= 12; j++) {
      const u = j / 12;
      const k = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
      cursor.push({
        t: leave + (arrive - leave) * u,
        x: prev.x + (p.x - prev.x) * k,
        y: prev.y + (p.y - prev.y) * k,
      });
    }
  }

  // Segments: real action plays at 1×; a long silence between actions is compressed, and the
  // "sped up N×" badge is shown for exactly those stretches.
  const segments: Segment[] = [];
  let cursorT = 0;
  const marks = points.map(({ e }) => e.t).sort((a, b) => a - b);
  for (const m of marks) {
    if (m - cursorT > 1500) segments.push({ s0: cursorT, s1: m, speed: 4, kind: "slack" });
    segments.push({ s0: m, s1: Math.min(duration(events), m + 1200), speed: 1, kind: "action" });
    cursorT = Math.min(duration(events), m + 1200);
  }
  if (cursorT < duration(events))
    segments.push({
      s0: cursorT,
      s1: duration(events),
      speed: cursorT === 0 ? 1 : 4,
      kind: "slack",
    });
  if (!segments.length)
    segments.push({ s0: 0, s1: Math.max(1, duration(events)), speed: 1, kind: "action" });

  // Only captions the author wrote in the log (text on a real action), never generated prose.
  const captions = events.events
    .filter((e) => e.kind === "type" && e.text)
    .slice(0, 6)
    .map((e) => ({ t0: e.t, t1: e.t + 1500, text: `Typed: ${e.text!.slice(0, 80)}` }));

  return { zooms, cursor, segments, captions };
}
