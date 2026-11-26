// The recording log. Every folder Aeon records gets an events.json: the clip's metadata, and the
// things Aeon did while it recorded, on the same clock as the clip. An editor reads this to zoom
// and place the cursor honestly: it never invents an action that is not in this file.
// Times are milliseconds from the clip's t=0 (the first captured frame), `at` is the wall clock
// (epoch ms) for correlating with a run trace, and points are page CSS px unless named `window`.

export type VideoEventKind =
  "click" | "type" | "press" | "scroll" | "navigate" | "tab-switch" | "beat";

export type Point = { x: number; y: number };

/** An element's bounds. Page CSS px on `box`, captured-window px on `windowBox`. */
export type Box = { x: number; y: number; width: number; height: number };

/**
 * The one beat vocabulary (mirrored in templates/video/src/types.ts). The first ten are emitted by
 * Aeon itself while a recording is armed (the beat bus); the rest are director tags.
 */
export const STORY_BEATS = [
  "summon",
  "key",
  "send",
  "teach",
  "learned",
  "receipt",
  "handoff",
  "resume",
  "sound",
  "provenance",
] as const;
export const DIRECTOR_BEATS = [
  "prompt",
  "compile",
  "result",
  "terminal",
  "watch",
  "boost",
] as const;
export type StoryBeat = (typeof STORY_BEATS)[number];
/** A beat tag on an event: what part of the story it carries. */
export type Beat = StoryBeat | (typeof DIRECTOR_BEATS)[number];
const BEAT_SET: ReadonlySet<string> = new Set<string>([...STORY_BEATS, ...DIRECTOR_BEATS]);
export const isBeat = (value: unknown): value is Beat =>
  typeof value === "string" && BEAT_SET.has(value);

export type SoundCueKind =
  "start" | "needs-you" | "done" | "key" | "trigger" | "arrive" | "shutter";
/** A sound the edit may score at clip time `t` (ms). Derived from real events only. */
export type SoundCue = { t: number; kind: SoundCueKind };

/** One thing Aeon did. `page` is viewport CSS px; `window` is px in the captured window image. */
export type VideoEvent = {
  id: string;
  kind: VideoEventKind;
  /** ms from clip t=0. Drives playback; the editor may only zoom at these times. */
  t: number;
  /** epoch ms at which the action happened (trace clock), for auditing t. */
  at: number;
  tabId?: number;
  page?: Point;
  window?: Point;
  /** Typed text, key pressed, destination URL or tab title. Never a secret (callers scrub). */
  text?: string;
  scroll?: Point;
  /** The acted element's bounds in page CSS px, when the trace had them. */
  box?: Box;
  /** The same bounds in captured-window px, when the window was calibrated. */
  windowBox?: Box;
  beat?: Beat;
  /** `sound` beats: which of Aeon's sounds fired (even when muted). */
  cue?: string;
  /** `teach` beats: the TeachPill count. */
  count?: number;
  /** `provenance` beats: the JSON path the page value came from (page.why). */
  jsonPath?: string;
  /** Who acted: unset is Aeon; "director" is a scripted stand-in for a person. */
  actor?: "director";
};

export type ClipMeta = {
  file: string;
  source: "window" | "screen" | "tabs";
  width: number;
  height: number;
  fps: number;
  /** epoch ms of the clip's first frame (its t=0). */
  startedAt: number;
  durationMs: number;
  frames: number;
  tabId?: number;
  /** Device pixel ratio of the capture, when known. `width` = `logicalWidth` × `dpr`. */
  dpr?: number;
  logicalWidth?: number;
  logicalHeight?: number;
  /** Frames ffmpeg dropped / duplicated to hold the constant rate (from -progress). */
  dropped?: number;
  dup?: number;
  /** false when an infobar or bubble stole viewport height during the take. */
  clean?: boolean;
  /** Settings the take ran under (recorded so no demo-only tuning goes unseen). */
  settings?: Record<string, string | number | boolean>;
};

/** Largest dup+drop share of frames an honest take may carry. */
export const MAX_DUP_DROP = 0.005;
export const dupDropShare = (clip: Pick<ClipMeta, "frames" | "dropped" | "dup">): number =>
  ((clip.dropped ?? 0) + (clip.dup ?? 0)) / Math.max(1, clip.frames);

/** A beat the script named (`aeon record mark`): `box` is page CSS px, `windowBox` clip px. */
export type Mark = {
  name: string;
  t: number;
  label?: string;
  box?: Box;
  windowBox?: Box;
  cue?: Extract<SoundCueKind, "key" | "trigger" | "arrive" | "shutter">;
};

/** One chunk of a terminal cast. `t` is ms on the clip clock. `in` is the command. */
export type TerminalEvent = { t: number; kind: "in" | "out" | "err"; text: string };

/** Asciinema-style capture of one command, written as events.json `terminal`. */
export type TerminalCast = {
  version: 1;
  command: string;
  startedAt: number;
  events: TerminalEvent[];
};

export type RecordingEvents = {
  version: 1;
  recorder: "aeon";
  /** `t` is ms from clip t=0; the clip's frames use the same origin. */
  clock: "clip";
  clip: ClipMeta;
  /** With --tabs there is one clip per recorded tab; the first is also `clip`. */
  clips?: ClipMeta[];
  events: VideoEvent[];
  /** A terminal session recorded beside the tab. The kit draws it as a pane. */
  terminal?: TerminalCast;
  /** Beats named with `aeon record mark` while recording, on the clip clock. */
  marks?: Mark[];
  /** Foley cues on the clip clock, derived from `events` (keys while typing, a trigger on Enter or click). */
  soundCues?: SoundCue[];
  /** The scanline join from an `align` step (see record-align.ts). */
  align?: {
    text: string;
    via: "provenance" | "text" | "none";
    aligned: boolean;
    box?: Box;
    jsonPath?: string;
    line?: number;
  };
  /** Set when the action list is incomplete (no trace was reachable at stop time). */
  note?: string;
};

/**
 * One clip per tab, in the order each tab first appears. A tab opened mid-run is its own clip
 * on the same clock as the recording, so an editor can show it beside the first.
 */
export function tabClips(
  events: VideoEvent[],
  recording: ClipMeta,
  extraTabIds: number[] = [],
  takes: ReadonlyMap<
    number,
    Pick<ClipMeta, "file" | "width" | "height" | "startedAt" | "durationMs" | "frames">
  > = new Map(),
): ClipMeta[] {
  const ids: number[] = [];
  const add = (id: number | undefined) => {
    if (id === undefined || ids.includes(id)) return;
    ids.push(id);
  };
  for (const event of events) add(event.tabId);
  for (const id of extraTabIds) add(id);
  for (const id of takes.keys()) add(id);
  return ids.map((tabId) => {
    const take = takes.get(tabId);
    // A take copied into the folder carries its own size, start and length; without one (Chrome
    // was gone, or the tab recorded nothing) the clip keeps the recording's clock.
    if (!take) return { ...recording, file: `takes/${tabId}.webm`, source: "tabs", tabId };
    return {
      ...recording,
      ...take,
      startedAt: take.startedAt || recording.startedAt,
      source: "tabs",
      tabId,
    };
  });
}

/** Write events.json atomically so a reader never sees a half-written log. */
export async function writeEvents(
  folder: string,
  events: RecordingEvents,
  write: (path: string, data: string) => Promise<void> = async (path, data) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, data, "utf8");
  },
  rename: (from: string, to: string) => Promise<void> = async (from, to) => {
    const { rename: fsRename } = await import("node:fs/promises");
    await fsRename(from, to);
  },
): Promise<string> {
  const { join } = await import("node:path");
  const target = join(folder, "events.json");
  const temp = join(folder, ".events.json.tmp");
  await write(temp, JSON.stringify(events, null, 2) + "\n");
  await rename(temp, target);
  return target;
}

/** A trace action as Aeon's engine emits it (subset of the trace schema we need). */
export type TraceAction = {
  kind: string;
  tabId?: number;
  tStart: number;
  tEnd?: number;
  box?: Box;
  point?: { x: number; y: number };
  text?: string;
  url?: string;
  scroll?: { x?: number; y?: number; direction?: string; amount?: number };
  failed?: boolean;
  /** `film` actions (the beat bus): the story beat, its cue, count or JSON path. */
  beat?: string;
  cue?: string;
  count?: number;
  jsonPath?: string;
  actor?: "director";
};
export type Trace = {
  chatId?: string;
  trace: { at?: string; actions?: TraceAction[] }[];
};

const NAV = new Set(["navigate", "openTab", "goto", "back", "forward", "reload"]);
const CLICK = new Set(["click", "pointer", "dblclick", "tap", "check", "uncheck"]);
const TYPE = new Set(["fill", "type", "insertText"]);
const KEYS = new Set(["press", "keys"]);

type LooseEvent = { [K in keyof VideoEvent]?: VideoEvent[K] | undefined };
const clip = (t: number, at: number, kind: VideoEventKind, patch: LooseEvent = {}): VideoEvent =>
  ({
    id: `e${t}-${kind}`,
    kind,
    t: Math.max(0, Math.round(t)),
    at: Math.round(at),
    ...patch,
  }) as VideoEvent;

function pointOf(a: TraceAction): Point | undefined {
  return (
    a.point ?? (a.box ? { x: a.box.x + a.box.width / 2, y: a.box.y + a.box.height / 2 } : undefined)
  );
}

function kindOf(kind: string): VideoEventKind | undefined {
  if (NAV.has(kind)) return "navigate";
  if (CLICK.has(kind)) return "click";
  if (TYPE.has(kind)) return "type";
  if (KEYS.has(kind)) return "press";
  if (kind === "scroll") return "scroll";
  if (kind === "tab-switch" || kind === "switchTab" || kind === "selectTab") return "tab-switch";
  return undefined;
}

function textOf(a: TraceAction, kind: VideoEventKind): string | undefined {
  if (kind === "navigate") return a.url ?? a.text ?? a.kind;
  if (kind === "press") return a.text ?? a.kind;
  if (kind === "scroll") return a.scroll?.direction;
  return a.text;
}

function oneEvent(
  a: TraceAction,
  t: number,
  common: { at: number; tabId?: number },
  point: Point | undefined,
  win: (p: Point) => Point | undefined,
  winBox: (b: Box) => Box | undefined,
): VideoEvent | undefined {
  const kind = kindOf(a.kind);
  if (!kind) return undefined;
  if (kind === "scroll" && !a.scroll && !point) return undefined;
  return clip(t, common.at, kind, {
    ...common,
    ...(point ? { page: point, window: win(point) } : {}),
    ...(kind === "scroll" ? { scroll: { x: a.scroll?.x ?? 0, y: a.scroll?.y ?? 0 } } : {}),
    text: textOf(a, kind),
    ...(a.box ? { box: { ...a.box }, windowBox: winBox(a.box) } : {}),
  });
}

/** A beat-bus action: Aeon's own UI said a story beat happened, with its text and box. */
function filmEvent(
  a: TraceAction,
  t: number,
  common: { at: number; tabId?: number },
  winBox: (b: Box) => Box | undefined,
): VideoEvent | undefined {
  if (!isBeat(a.beat)) return undefined;
  return clip(t, common.at, "beat", {
    ...common,
    beat: a.beat,
    ...(a.text ? { text: a.text } : {}),
    ...(a.cue ? { cue: a.cue } : {}),
    ...(a.count === undefined ? {} : { count: a.count }),
    ...(a.jsonPath ? { jsonPath: a.jsonPath } : {}),
    ...(a.actor ? { actor: a.actor } : {}),
    ...(a.box ? { box: { ...a.box }, windowBox: winBox(a.box) } : {}),
  });
}

/** Clip-local DPR facts from a physical frame size and a known device pixel ratio. */
export function clipScale(
  size: { width: number; height: number },
  dpr: number | undefined,
): Pick<ClipMeta, "dpr" | "logicalWidth" | "logicalHeight"> {
  if (!dpr || !Number.isFinite(dpr) || dpr <= 0 || !size.width || !size.height) return {};
  return {
    dpr,
    logicalWidth: Math.round(size.width / dpr),
    logicalHeight: Math.round(size.height / dpr),
  };
}

const SOUND_CUE: Record<string, SoundCueKind> = {
  start: "start",
  needs: "needs-you",
  "needs-you": "needs-you",
  done: "done",
};

/**
 * Foley cues from real events. Real keystrokes (`key` beats) score one key each at their own time;
 * a fill with no key beats falls back to ~55 ms per character. Aeon's own `sound` beats score the
 * sound it played. Nothing is scored that Aeon did not do.
 */
export function soundCuesFromEvents(events: VideoEvent[]): SoundCue[] {
  const realKeys = events.some((e) => e.kind === "beat" && e.beat === "key");
  return events.flatMap((e) => cuesOf(e, realKeys)).sort((a, b) => a.t - b.t);
}

function beatCue(e: VideoEvent): SoundCue | undefined {
  if (e.beat === "key") return { t: e.t, kind: "key" };
  if (e.beat === "send") return { t: e.t, kind: "trigger" };
  const sound = e.beat === "sound" && e.cue ? SOUND_CUE[e.cue] : undefined;
  return sound ? { t: e.t, kind: sound } : undefined;
}

function cuesOf(e: VideoEvent, realKeys: boolean): SoundCue[] {
  if (e.kind === "beat") {
    const cue = beatCue(e);
    return cue ? [cue] : [];
  }
  if (e.kind === "type" && e.text && !realKeys) {
    const n = Math.min(e.text.length, 80);
    return Array.from({ length: n }, (_, i) => ({ t: e.t + i * 55, kind: "key" as const }));
  }
  if (e.kind === "click" || (e.kind === "press" && /enter/i.test(e.text ?? "")))
    return [{ t: e.t, kind: "trigger" }];
  return [];
}

/**
 * Turn Aeon's timed trace into honest events. `t0` is the clip's wall-clock start, so every event
 * lands on the clip's clock. `windowOffset`/`scale` place page coordinates into window-space when
 * a window capture was calibrated; page coordinates are kept either way.
 */
export function eventsFromTrace(
  trace: Trace,
  t0: number,
  options: { windowOffset?: Point; scale?: number } = {},
): VideoEvent[] {
  const scale = options.scale ?? 1;
  const off = options.windowOffset;
  const win = (p: Point): Point | undefined =>
    off ? { x: Math.round(off.x + p.x * scale), y: Math.round(off.y + p.y * scale) } : undefined;
  const winBox = (b: Box): Box | undefined => {
    const o = win(b);
    return o
      ? { ...o, width: Math.round(b.width * scale), height: Math.round(b.height * scale) }
      : undefined;
  };
  const out: VideoEvent[] = [];
  for (const a of trace.trace.flatMap((step) => step.actions ?? [])) {
    if (a.failed || a.tStart < t0) continue; // failed or before the first frame is not in the clip
    const common = { at: a.tStart, ...(a.tabId === undefined ? {} : { tabId: a.tabId }) };
    const event =
      a.kind === "film"
        ? filmEvent(a, a.tStart - t0, common, winBox)
        : oneEvent(a, a.tStart - t0, common, pointOf(a), win, winBox);
    if (event) out.push(event);
  }
  return out
    .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
    .map((e, i) => ({ ...e, id: `e${i + 1}` }));
}
