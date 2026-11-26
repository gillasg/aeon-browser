// The recorder's side of the beat bus: arm Aeon's UI hooks for a take, read the beats it wrote,
// and turn them into events on the clip clock. Best effort: a Chrome without the hook yields none.
// The bus is `chrome.storage.session`, reachable only from the extension, so it goes through Core.
import { eventsFromTrace, type TraceAction, type VideoEvent } from "./record-events.js";

export const FILM_ARMED_KEY = "aeon-film-armed";
export const FILM_BEATS_KEY = "aeon-film-beats";

export type FilmAction = "arm" | "disarm" | "read" | "clear";
/** One trip over the beat bus: Core relays it to the extension worker in every connected Chrome. */
export type FilmBus = (action: FilmAction) => Promise<{ ok?: unknown; beats?: unknown }>;

export async function armBeats(bus: FilmBus, on: boolean): Promise<boolean> {
  try {
    return (await bus(on ? "arm" : "disarm")).ok === true;
  } catch {
    return false;
  }
}

export async function readBeats(bus: FilmBus): Promise<TraceAction[]> {
  try {
    const { beats } = await bus("read");
    return Array.isArray(beats) ? beats.filter(isFilmAction) : [];
  } catch {
    return [];
  }
}

const isFilmAction = (row: unknown): row is TraceAction =>
  typeof row === "object" &&
  row !== null &&
  (row as TraceAction).kind === "film" &&
  typeof (row as TraceAction).tStart === "number";

/** Beat-bus rows plus the trace's own events, one ordered list on the clip clock. */
export function withBeats(events: VideoEvent[], beats: TraceAction[], t0: number): VideoEvent[] {
  if (!beats.length) return events;
  const fromBus = eventsFromTrace({ trace: [{ actions: beats }] }, t0);
  return [...events, ...fromBus]
    .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
    .map((e, i) => ({ ...e, id: `e${i + 1}` }));
}

/** First beat named `beat` at or after `sinceMs` (epoch), for `wait: beat`. */
export const beatSeen = (beats: TraceAction[], beat: string, sinceMs: number): boolean =>
  beats.some((b) => b.beat === beat && b.tStart >= sinceMs);
