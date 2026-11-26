// Recording beat hooks. When `aeon record` arms a take (session key `aeon-film-armed`), Aeon's own
// UI writes its story beats (summon, send, receipt, learned, handoff, sound…) to the session
// store, where the recorder reads them onto the clip clock. Unarmed, every call is one boolean
// check: no storage writes, no DOM reads and nothing visible changes.

export const FILM_ARMED_KEY = "aeon-film-armed";
export const FILM_BEATS_KEY = "aeon-film-beats";
const MAX_BEATS = 2000;

export type FilmBeat =
  | "summon"
  | "key"
  | "send"
  | "teach"
  | "learned"
  | "receipt"
  | "handoff"
  | "resume"
  | "sound"
  | "provenance";
export type FilmDetail = {
  text?: string;
  cue?: string;
  count?: number;
  box?: { x: number; y: number; width: number; height: number };
};

let armed = false;
let queue: Record<string, unknown>[] = [];

/** Follow the armed flag; call once at boot. */
export function watchFilm(): void {
  try {
    void chrome.storage.session
      .get(FILM_ARMED_KEY)
      .then((v) => (armed = v[FILM_ARMED_KEY] === true));
    chrome.storage.session.onChanged.addListener((changes) => {
      if (FILM_ARMED_KEY in changes) armed = changes[FILM_ARMED_KEY]?.newValue === true;
    });
  } catch {
    armed = false;
  }
}

export const filmArmed = (): boolean => armed;

/** A story beat as a trace `film` action. A no-op unless a recording is armed. */
export function filmBeat(beat: FilmBeat, detail: FilmDetail = {}): void {
  if (!armed) return;
  queue.push({ kind: "film", beat, tStart: Date.now(), ...detail });
  if (queue.length === 1) queueMicrotask(flush);
}

function flush(): void {
  const fresh = queue;
  queue = [];
  void chrome.storage.session
    .get(FILM_BEATS_KEY)
    .then((v) => {
      const old = Array.isArray(v[FILM_BEATS_KEY]) ? (v[FILM_BEATS_KEY] as unknown[]) : [];
      return chrome.storage.session.set({
        [FILM_BEATS_KEY]: [...old, ...fresh].slice(-MAX_BEATS),
      });
    })
    .catch(() => undefined);
}
