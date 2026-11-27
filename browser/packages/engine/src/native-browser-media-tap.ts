// page.media.audioState() and page.media.captions: whether a tab is making sound, what its media
// elements are doing, and the captions they show. Captions are watched only between start() and
// stop(): the page gets a cue listener and a mutation observer then, never before, and stop() or
// the tab closing removes them. Cue text is scrubbed of tokens and addresses before it leaves.
import { redactHarText } from "./native-browser-network-format.js";
import type { Cdp } from "./native-browser-visual-claws.js";

type Value = Record<string, unknown>;
export interface Cue {
  text: string;
  source: string;
  at: number;
  start?: number;
  end?: number;
}
export interface MediaTabs {
  get(tabId: number): Promise<{
    audible?: boolean | undefined;
    mutedInfo?: { muted: boolean; reason?: string | undefined } | undefined;
  }>;
}

export const CUE_LIMIT = 200;
const SECRET_PAIR = /\b(password|passwd|pwd|token|api[_-]?key|secret|otp|code)\s*[:=]\s*\S+/gi;
const watching = new Set<number>();

export function scrubCue(text: string): string {
  return redactHarText(String(text).slice(0, 1000)).replace(SECRET_PAIR, "$1: <redacted>");
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const answer = (await cdp("Runtime.evaluate", { expression, returnByValue: true })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string };
  };
  if (answer?.exceptionDetails) throw new Error("EVAL_FAILED: " + answer.exceptionDetails.text);
  return answer?.result?.value as T;
}

const MEDIA_STATE = String(() =>
  [...document.querySelectorAll("video, audio")].slice(0, 20).map((node) => {
    const media = node as HTMLMediaElement;
    return {
      tag: media.tagName.toLowerCase(),
      id: media.id || undefined,
      paused: media.paused,
      ended: media.ended,
      currentTime: Math.round(media.currentTime * 100) / 100,
      duration: Number.isFinite(media.duration) ? Math.round(media.duration * 100) / 100 : null,
      muted: media.muted,
      volume: media.volume,
      playbackRate: media.playbackRate,
      tracks: media.textTracks ? media.textTracks.length : 0,
    };
  }),
);

// Runs in the page. start: listen to every text track's cuechange and watch live caption
// containers; cues go into a ring buffer of `limit`. read: the buffer since `after`. stop: undo.
const CAPTION_TAP = String((arg: { action: string; limit: number; after?: number }) => {
  type Tap = {
    cues: {
      text: string;
      source: string;
      at: number;
      start?: number | undefined;
      end?: number | undefined;
    }[];
    seq: number;
    stop: () => void;
  };
  const w = window as unknown as { __graftCaptions?: Tap };
  if (arg.action === "read") {
    const tap = w.__graftCaptions;
    return tap ? { cues: tap.cues.filter((cue) => cue.at > (arg.after ?? 0)), seq: tap.seq } : null;
  }
  if (arg.action === "stop") {
    const had = Boolean(w.__graftCaptions);
    w.__graftCaptions?.stop();
    delete w.__graftCaptions;
    return { stopped: had };
  }
  if (w.__graftCaptions) return { started: true, already: true };
  const tap: Tap = { cues: [], seq: 0, stop: () => undefined };
  const last = new Map<string, string>();
  const push = (source: string, text: string, start?: number, end?: number) => {
    text = text.replace(/\s+/g, " ").trim();
    if (!text || last.get(source) === text) return;
    last.set(source, text);
    tap.cues.push({ text, source, at: ++tap.seq, start, end });
    if (tap.cues.length > arg.limit) tap.cues.shift();
  };
  const undo: (() => void)[] = [];
  const hook = (track: TextTrack, index: number) => {
    if (track.mode === "disabled") track.mode = "hidden";
    const onCue = () => {
      for (const cue of [...(track.activeCues ?? [])])
        push(
          "track:" + (track.label || track.language || index),
          (cue as VTTCue).text ?? "",
          cue.startTime,
          cue.endTime,
        );
    };
    track.addEventListener("cuechange", onCue);
    undo.push(() => track.removeEventListener("cuechange", onCue));
  };
  document
    .querySelectorAll("video, audio")
    .forEach((node) => [...(node as HTMLMediaElement).textTracks].forEach(hook));
  const SELECTOR = ".ytp-caption-segment, [data-caption], [aria-live]";
  const scan = () =>
    document
      .querySelectorAll(SELECTOR)
      .forEach((el, i) =>
        push(
          el.matches(".ytp-caption-segment")
            ? "youtube"
            : el.hasAttribute("data-caption")
              ? "data-caption"
              : "live:" + i,
          (el as HTMLElement).innerText || el.textContent || "",
        ),
      );
  const observer = new MutationObserver(scan);
  observer.observe(document.body || document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  undo.push(() => observer.disconnect());
  scan();
  tap.stop = () => undo.splice(0).forEach((fn) => fn());
  w.__graftCaptions = tap;
  return { started: true };
});

const tap = (cdp: Cdp, arg: Value) =>
  evaluate<Value | null>(cdp, `(${CAPTION_TAP})(${JSON.stringify(arg)})`);

function matches(cue: Cue, filter: unknown): boolean {
  if (filter == null || filter === "") return true;
  if (typeof filter === "string") return cue.text.toLowerCase().includes(filter.toLowerCase());
  const f = filter as Value;
  if (typeof f.text === "string" && !cue.text.toLowerCase().includes(f.text.toLowerCase()))
    return false;
  if (typeof f.regex === "string" && !new RegExp(f.regex, "i").test(cue.text)) return false;
  if (typeof f.source === "string" && !cue.source.startsWith(f.source)) return false;
  return true;
}

async function readCues(cdp: Cdp, after = 0): Promise<{ cues: Cue[]; seq: number } | null> {
  const answer = (await tap(cdp, { action: "read", limit: CUE_LIMIT, after })) as {
    cues: Cue[];
    seq: number;
  } | null;
  if (!answer) return null;
  return {
    seq: answer.seq,
    cues: answer.cues.map((cue) => ({ ...cue, text: scrubCue(cue.text) })),
  };
}

async function waitFor(
  cdp: Cdp,
  value: Value,
  sleep: (ms: number) => Promise<void>,
): Promise<unknown> {
  const timeoutMs = Math.min(Math.max(Number(value.timeoutMs) || 10_000, 100), 50_000);
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  for (;;) {
    const read = await readCues(cdp, after);
    if (!read) throw new Error("INVALID_INPUT: call page.media.captions.start() first");
    const hit = read.cues.find((cue) => matches(cue, value.filter));
    if (hit) return { cue: hit };
    after = read.seq;
    if (Date.now() >= deadline) throw new Error(`TIMEOUT: no caption matched in ${timeoutMs} ms`);
    await sleep(250);
  }
}

function watchClose(tabId: number, onClosed?: (listener: (tabId: number) => void) => void): void {
  if (watching.size === 0 && onClosed) onClosed((closed) => watching.delete(closed));
  watching.add(tabId);
}

/** Tabs whose captions are being watched (for tests and status). */
export const captionTabs = (): number[] => [...watching];
export function forgetCaptions(tabId: number): void {
  watching.delete(tabId);
}

export interface MediaTapDeps {
  cdp: Cdp;
  tabs: MediaTabs;
  sleep?: (ms: number) => Promise<void>;
  onClosed?: (listener: (tabId: number) => void) => void;
}

export async function mediaTapCall(
  tabId: number,
  value: Value,
  deps: MediaTapDeps,
): Promise<unknown> {
  const { cdp } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  switch (value.mediaTap) {
    case "audioState": {
      const tab = await deps.tabs.get(tabId);
      const elements = await evaluate<unknown[]>(cdp, `(${MEDIA_STATE})()`);
      return {
        audible: tab.audible === true,
        muted: tab.mutedInfo?.muted === true,
        mutedReason: tab.mutedInfo?.reason,
        elements: elements ?? [],
      };
    }
    case "captionsStart": {
      const answer = await tap(cdp, { action: "start", limit: CUE_LIMIT });
      watchClose(tabId, deps.onClosed);
      return answer;
    }
    case "captionsStop":
      forgetCaptions(tabId);
      return tap(cdp, { action: "stop", limit: CUE_LIMIT });
    case "captionsList": {
      const read = await readCues(cdp, Number(value.after) || 0);
      return read
        ? { cues: read.cues.filter((cue) => matches(cue, value.filter)), watching: true }
        : { cues: [], watching: false };
    }
    case "captionsWait":
      return waitFor(cdp, value, sleep);
    default:
      throw new Error(
        "INVALID_INPUT: mediaTap is audioState, captionsStart, captionsStop, captionsList or captionsWait",
      );
  }
}
