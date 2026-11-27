// Which recording is live: one pointer file, `recordings/current` in the data dir, holding
// {folder, out}. start writes it and refuses while a take is live; stop reads it whatever --out says.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "./client.js";

export interface RecordingPointer {
  folder: string;
  out?: string;
}

export function pointerFile(): string {
  return join(dataDirectory(), "recordings", "current");
}

export function writePointer(pointer: RecordingPointer): void {
  const file = pointerFile();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(pointer));
}

/** The live recording's pointer, or undefined. A plain folder path (older builds) still reads. */
export function readPointer(): RecordingPointer | undefined {
  let text: string;
  try {
    text = readFileSync(pointerFile(), "utf8").trim();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<RecordingPointer>;
    if (typeof value.folder === "string")
      return { folder: value.folder, ...(value.out ? { out: value.out } : {}) };
  } catch {
    // Not JSON: an older pointer that held only the folder.
  }
  return { folder: text };
}

/** Stop finished `folder`: the pointer goes, unless it already names another take. */
export function releasePointer(folder: string): void {
  if (readPointer()?.folder === folder) rmSync(pointerFile(), { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The folder of a take that is still running, or undefined. A crashed capture does not count. */
export function liveRecording(): string | undefined {
  const pointer = readPointer();
  if (!pointer) return undefined;
  const stateFile = join(pointer.folder, ".recording.json");
  if (!existsSync(stateFile)) return undefined;
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { source?: string; pid?: number };
    if (state.source === "tabs" || state.pid === undefined || alive(state.pid))
      return pointer.folder;
  } catch {
    return undefined;
  }
  return undefined;
}

export function refuseIfRecording(): void {
  const folder = liveRecording();
  if (folder)
    throw new Error(
      `RECORDING_RUNNING: stop it first (graft record stop). The live take is in ${folder}.`,
    );
}

/** The folder stop finishes: the pointer's, never a guess from --out. */
export function stopTarget(out: string | undefined): string {
  const pointer = readPointer();
  if (pointer) return pointer.folder;
  if (out) return out;
  throw new Error("No recording is running (graft record start begins one).");
}

/** A recording against a data dir with no daemon would log nothing: say so at start. */
export async function requireDaemon(connect: () => Promise<unknown>): Promise<void> {
  try {
    await connect();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `DAEMON_NOT_RUNNING: no Graft daemon answers for the data dir ${dataDirectory()}. ` +
        `Start Graft (graft start) or point GRAFT_DATA_DIR at the running one. (${why})`,
      { cause: error },
    );
  }
}
