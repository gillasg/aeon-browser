// Lines of a terminal cast at a clip time. The kit draws these beside the tab. Same shape as
// events.json `terminal` (see EVENTS.md).
import type { Rect, TerminalCast } from "./types";

export type TermLine = { kind: "in" | "out" | "err"; text: string };

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
    const parts = event.text.split("\n");
    if (event.text.endsWith("\n")) parts.pop();
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i] ?? "";
      const newline = i < parts.length - 1;
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
