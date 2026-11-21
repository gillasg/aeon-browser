// A terminal cast beside a tab recording: the command and what it printed, with times on the
// clip clock. Asciinema-style text is enough for the video kit to draw a pane. No pty.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordingEvents, TerminalCast, TerminalEvent } from "./record-events.js";

const MAX_CHARS = 100_000;

export function terminalCast(
  command: string,
  startedAt: number,
  chunks: { at: number; kind: "out" | "err"; text: string }[],
): TerminalCast {
  const events: TerminalEvent[] = [{ t: 0, kind: "in", text: command }];
  let last = 0;
  for (const chunk of chunks) {
    const t = Math.max(last, Math.round(chunk.at - startedAt));
    last = t;
    events.push({ t, kind: chunk.kind, text: chunk.text });
  }
  return { version: 1, command, startedAt, events };
}

/** Shift the cast onto the clip clock (t = 0 is the clip's first frame) and keep times ordered. */
export function alignCast(cast: TerminalCast, clipStartedAt: number | undefined): TerminalCast {
  if (clipStartedAt === undefined || !(clipStartedAt > 0)) return cast;
  const shift = cast.startedAt - clipStartedAt;
  let last = 0;
  const events = cast.events.map((event) => {
    const t = Math.max(last, Math.round(event.t + shift));
    last = t;
    return { ...event, t };
  });
  return { ...cast, events };
}

export function readRecording(folder: string): RecordingEvents | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(folder, "events.json"), "utf8")) as RecordingEvents;
    if (raw?.version !== 1 || !raw.clip) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export function keptTerminal(folder: string): TerminalCast | undefined {
  const terminal = readRecording(folder)?.terminal;
  if (!terminal || terminal.version !== 1 || typeof terminal.command !== "string") return undefined;
  if (!Array.isArray(terminal.events)) return undefined;
  return terminal;
}

/** Put the cast on an existing log, or start a log that is only the terminal. */
export function attachTerminal(
  recording: RecordingEvents | undefined,
  cast: TerminalCast,
): RecordingEvents {
  const terminal = alignCast(cast, recording?.clip?.startedAt);
  if (recording) return { ...recording, terminal };
  return {
    version: 1,
    recorder: "aeon",
    clock: "clip",
    clip: {
      file: "clip.mp4",
      source: "window",
      width: 0,
      height: 0,
      fps: 30,
      startedAt: cast.startedAt,
      durationMs: 0,
      frames: 0,
    },
    events: [],
    terminal,
    note: "Terminal cast only. Run `aeon record start` for a tab or window clip.",
  };
}

/** Run a command and keep its output. The exit code is the command's, even when the cast is saved. */
export async function runTerminal(command: string): Promise<{ code: number; cast: TerminalCast }> {
  const startedAt = Date.now();
  const chunks: { at: number; kind: "out" | "err"; text: string }[] = [];
  let used = command.length;
  const take = (kind: "out" | "err") => (buf: Buffer) => {
    if (used >= MAX_CHARS) return;
    const text = buf.toString("utf8").slice(0, MAX_CHARS - used);
    used += text.length;
    if (text) chunks.push({ at: Date.now(), kind, text });
  };
  const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", take("out"));
  child.stderr.on("data", take("err"));
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (status) => resolve(status ?? 1));
  });
  return { code, cast: terminalCast(command, startedAt, chunks) };
}
