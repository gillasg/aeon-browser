// `aeon record stop --tabs`: the hidden tab takes Aeon's engine recorded, copied into the
// recording folder as takes/<tabId>.webm (or .mp4) with their real size, start and length.
// The engine's browser.saveTake() writes into a chat workspace, which a CLI cell does not have,
// so the take is streamed back here with the same stop/read/drop calls saveTake makes.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClipMeta } from "./record-events.js";

/** Runs one browser cell and returns its value (DaemonHost.runInBrowser in production). */
export type CellRunner = (code: string) => Promise<unknown>;

/** What a stopped take reports (the engine's `stopped` record). */
type Stopped = {
  bytes?: number;
  mimeType?: string;
  ms?: number;
  firstFrameAt?: number;
  width?: number;
  height?: number;
  frames?: { received?: number; drawn?: number } | number;
};

export type SavedTake = Pick<
  ClipMeta,
  "file" | "width" | "height" | "startedAt" | "durationMs" | "frames"
>;

/** The most a take may be: a runaway recording must not fill the disk. */
const MAX_BYTES = 2_000_000_000;

function stoppedOf(value: unknown): Stopped | undefined {
  const take = value as { stopped?: unknown; error?: unknown } | null | undefined;
  return take?.stopped && typeof take.stopped === "object" ? (take.stopped as Stopped) : undefined;
}

function frameCount(frames: Stopped["frames"]): number {
  if (typeof frames === "number") return frames;
  return Number(frames?.drawn ?? frames?.received ?? 0) || 0;
}

export function takeExtension(mimeType: string | undefined): "mp4" | "webm" {
  return String(mimeType ?? "").includes("mp4") ? "mp4" : "webm";
}

const call = (request: Record<string, unknown>) =>
  `return await __call(${JSON.stringify(request)})`;

/** Stream a stopped take's bytes into `target`; false when it could not be read whole. */
async function copyTake(
  run: CellRunner,
  tabId: number,
  bytes: number,
  target: string,
): Promise<boolean> {
  writeFileSync(target, Buffer.alloc(0));
  let offset = 0;
  while (offset < bytes) {
    const part = (await run(call({ takes: "read", tabId, offset }))) as { base64?: unknown };
    const chunk = Buffer.from(typeof part?.base64 === "string" ? part.base64 : "", "base64");
    if (!chunk.length) break;
    appendFileSync(target, chunk);
    offset += chunk.length;
  }
  if (offset >= bytes) return true;
  rmSync(target, { force: true });
  return false;
}

function savedTake(file: string, done: Stopped): SavedTake {
  return {
    file,
    width: Number(done.width) || 0,
    height: Number(done.height) || 0,
    startedAt: Number(done.firstFrameAt) || 0,
    durationMs: Math.round(Number(done.ms) || 0),
    frames: frameCount(done.frames),
  };
}

/** Copy one tab's take into `folder/takes/`. Undefined when the tab had no usable take. */
export async function saveTabTake(
  run: CellRunner,
  folder: string,
  tabId: number,
): Promise<SavedTake | undefined> {
  const done = stoppedOf(await run(call({ takes: "stop", tabId })).catch(() => undefined));
  try {
    const bytes = Number(done?.bytes) || 0;
    if (!done || bytes <= 0 || bytes > MAX_BYTES) return undefined;
    const file = `takes/${tabId}.${takeExtension(done.mimeType)}`;
    mkdirSync(join(folder, "takes"), { recursive: true });
    return (await copyTake(run, tabId, bytes, join(folder, file)))
      ? savedTake(file, done)
      : undefined;
  } catch {
    return undefined;
  } finally {
    await run(call({ takes: "drop", tabId })).catch(() => undefined);
  }
}

/** Every recorded tab's take, by tab id. A tab whose take is missing or unreadable is left out. */
export async function saveTabTakes(
  run: CellRunner,
  folder: string,
  tabIds: readonly number[],
): Promise<Map<number, SavedTake>> {
  const saved = new Map<number, SavedTake>();
  for (const tabId of new Set(tabIds)) {
    const take = await saveTabTake(run, folder, tabId);
    if (take) saved.set(tabId, take);
  }
  return saved;
}
