// Lines of a terminal cast at a clip time. The kit draws these beside the tab. Same shape as
// events.json `terminal` (see EVENTS.md).
import type { Rect, TerminalCast } from "./types.ts";

export type TermLine = { kind: "in" | "out" | "err"; text: string };

// CSI/OSC escapes and lone control bytes a PTY emits; the pane shows text only.
const ANSI =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[()][A-Z0-9]|\u001b[=>]/g;

/** Text as a terminal would show it: escapes gone, carriage-return redraws collapsed. */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).at(-1) ?? "")
    .join("\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

type StreamRow = {
  type?: string;
  message?: { content?: { type?: string; text?: string; name?: string; input?: unknown }[] };
  result?: string;
  duration_ms?: number;
};

const firstArg = (input: unknown): string => {
  if (!input || typeof input !== "object") return "";
  const v = Object.values(input as Record<string, unknown>)[0];
  return typeof v === "string" ? v.split("\n")[0]!.slice(0, 80) : "";
};

/**
 * Stream-JSON agent output (one JSON object per line) as the rows a person would read: text,
 * each tool with its first argument, `Learned on …`, the result and the real elapsed time.
 */
export function streamJsonLines(jsonl: string): string[] {
  const out: string[] = [];
  for (const raw of jsonl.split("\n")) {
    let row: StreamRow;
    try {
      row = JSON.parse(raw) as StreamRow;
    } catch {
      continue;
    }
    for (const part of row.message?.content ?? []) {
      if (part.type === "tool_use")
        out.push(`› ${part.name ?? "tool"} ${firstArg(part.input)}`.trimEnd());
      else if (part.type === "text" && part.text)
        out.push(...part.text.split("\n").filter(Boolean));
    }
    if (row.type === "result") {
      if (row.result) out.push(...row.result.split("\n").filter(Boolean));
      if (row.duration_ms !== undefined) out.push(`${(row.duration_ms / 1000).toFixed(1)} s`);
    }
  }
  return out;
}

/** Lines visible at clip time `t` (ms). The command is a `$` line; output stays in arrival order. */
export function terminalLines(cast: TerminalCast, t: number, max = 16): TermLine[] {
  const lines: TermLine[] = [];
  let open: TermLine | undefined;
  const close = () => {
    if (!open) return;
    lines.push(open);
    open = undefined;
  };
  for (const event of cast.events) {
    if (event.t > t) break;
    if (event.kind === "in") {
      close();
      const parts = event.text.split("\n");
      if (event.text.endsWith("\n")) parts.pop();
      for (let i = 0; i < parts.length; i++)
        lines.push({ kind: "in", text: (i === 0 ? "$ " : "") + (parts[i] ?? "") });
      continue;
    }
    const clean = stripAnsi(event.text);
    const ended = clean.endsWith("\n");
    const parts = clean.split("\n");
    if (ended) parts.pop();
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i] ?? "";
      const newline = ended || i < parts.length - 1;
      open = open
        ? { kind: open.kind, text: open.text + piece }
        : { kind: event.kind, text: piece };
      if (newline) close();
    }
  }
  if (open) lines.push(open);
  return lines.slice(Math.max(0, lines.length - max));
}

/** Chrome area and the terminal pane beside it (below, when the frame is taller than it is wide). */
export function terminalFrame(
  width: number,
  height: number,
  present: boolean,
): { chrome: Rect; term: Rect } {
  if (!present)
    return { chrome: { x: 0, y: 0, w: width, h: height }, term: { x: 0, y: 0, w: 0, h: 0 } };
  const gap = Math.round(Math.min(width, height) * 0.012);
  if (width >= height) {
    const tw = Math.round(width * 0.34);
    return {
      chrome: { x: 0, y: 0, w: width - tw, h: height },
      term: { x: width - tw + gap, y: gap, w: tw - gap * 2, h: height - gap * 2 },
    };
  }
  const th = Math.round(height * 0.32);
  return {
    chrome: { x: 0, y: 0, w: width, h: height - th },
    term: { x: gap, y: height - th + gap, w: width - gap * 2, h: th - gap * 2 },
  };
}
