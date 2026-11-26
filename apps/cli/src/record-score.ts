// The fast path's score: synthesized cues from events.json:
// hushed keys, a dry trigger, a soft arrival note and a bell chord on receipts. Pure TypeScript,
// deterministic, 48 kHz 16-bit stereo, no audio assets and no dependencies.
import type { SoundCueKind } from "./record-events.js";

export const SAMPLE_RATE = 48_000;
export type ScoreHitKind = "key" | "trigger" | "chord" | "note";
export type ScoreHit = { t: number; kind: ScoreHitKind };
export type Bus = { l: Float32Array; r: Float32Array };

const db = (d: number) => 10 ** (d / 20);

/** A recording cue as the kit scores it: arrive is a soft note, done a chord, the rest triggers. */
export function hitKind(kind: SoundCueKind | "chord"): ScoreHitKind {
  if (kind === "key") return "key";
  if (kind === "done" || kind === "chord") return "chord";
  if (kind === "arrive" || kind === "needs-you") return "note";
  return "trigger";
}

/** mulberry32: the same score always renders the same samples. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function add(bus: Bus, i: number, v: number, pan = 0): void {
  if (i < 0 || i >= bus.l.length) return;
  bus.l[i] = (bus.l[i] ?? 0) + v * (1 - Math.max(0, pan));
  bus.r[i] = (bus.r[i] ?? 0) + v * (1 + Math.min(0, pan));
}

/** Hushed mechanical key: 18 ms of filtered noise over a damped switch transient. */
function key(bus: Bus, start: number, rand: () => number): void {
  const n = Math.round(0.018 * SAMPLE_RATE);
  const f = 1900 * (0.9 + rand() * 0.2);
  const g = db(-30) * (0.85 + rand() * 0.3);
  const pan = (rand() - 0.5) * 0.3;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    lp += 0.35 * (rand() * 2 - 1 - lp);
    const env = Math.exp(-t / 0.0035);
    const body = Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.002);
    add(bus, start + i, g * env * (0.6 * lp + 0.5 * body), pan);
  }
}

/** Dry glass/shutter trigger: 25 ms, crisp attack. */
function trigger(bus: Bus, start: number, rand: () => number): void {
  const n = Math.round(0.025 * SAMPLE_RATE);
  const g = db(-20);
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const w = rand() * 2 - 1;
    hp = 0.7 * (hp + w - prev);
    prev = w;
    const env = Math.min(1, i / 24) * Math.exp(-t / 0.005);
    const tone = Math.sin(2 * Math.PI * 3150 * t) * 0.6 + Math.sin(2 * Math.PI * 5400 * t) * 0.25;
    add(bus, start + i, g * env * (0.45 * hp + tone));
  }
}

/** Bell-like arrival: D5 + A5, 6 ms attack, exponential decay, a whisper of inharmonic air. */
function chord(bus: Bus, start: number, gainDb = -14, notes: number[] = [587.33, 880]): void {
  const n = Math.round(1.1 * SAMPLE_RATE);
  const g = db(gainDb);
  const attack = 0.006 * SAMPLE_RATE;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.min(1, i / attack) * Math.exp(-t / (0.24 / 3));
    notes.forEach((f, k) => {
      const v =
        Math.sin(2 * Math.PI * f * t) +
        0.08 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t / 0.03);
      add(bus, start + i, (g / notes.length) * env * v, k === 0 ? -0.15 : 0.15);
    });
  }
}

/** Render hits (video ms) into stereo float buffers `durationMs` long. */
export function synthesize(hits: readonly ScoreHit[], durationMs: number, seed = 7): Bus {
  const len = Math.max(1, Math.round((durationMs / 1000) * SAMPLE_RATE));
  const bus: Bus = { l: new Float32Array(len), r: new Float32Array(len) };
  const rand = rng(seed);
  const s = (ms: number) => Math.round((ms / 1000) * SAMPLE_RATE);
  for (const h of [...hits].sort((a, b) => a.t - b.t)) {
    const jitter = h.kind === "key" ? Math.round((rand() - 0.5) * 0.004 * SAMPLE_RATE) : 0;
    if (h.kind === "key") key(bus, s(h.t) + jitter, rand);
    else if (h.kind === "trigger") trigger(bus, s(h.t), rand);
    else if (h.kind === "chord") chord(bus, s(h.t));
    else chord(bus, s(h.t), -20, [880]);
  }
  return bus;
}

/** 16-bit PCM stereo WAV. */
export function encodeWav(bus: Bus): Uint8Array {
  const frames = bus.l.length;
  const data = frames * 4;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const text = (o: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, data, true);
  const pcm = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 4, pcm(bus.l[i] ?? 0), true);
    view.setInt16(46 + i * 4, pcm(bus.r[i] ?? 0), true);
  }
  return out;
}
