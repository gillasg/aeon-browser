// The cursor's host is a plain, unlabelled element with a closed shadow root. Page scripts cannot
// select it (no id, class or data-aeon-* attribute) and cannot read inside the shadow root. The
// painter and the orb share the extension's isolated world, and state crosses between them on an
// EventTarget that lives only in that world: nothing is dispatched on the page's window.

export const CURSOR_STATE_EVENT = "cursor-overlay-state";
export const CURSOR_COMMAND_EVENT = "cursor-overlay-command";

export interface CursorBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CursorSurfaceState {
  present: boolean;
  point?: { x: number; y: number };
  controls?: { tr: CursorBox | null; stop: CursorBox | null };
}

export interface CursorSurfaceCommand {
  x: number;
  y: number;
  place?: boolean;
  release?: boolean;
}

/** The isolated-world bus the painter and the orb share; the page's window never sees it. */
export function cursorBus(): EventTarget {
  const scope = globalThis as { __cursorBus?: EventTarget };
  return (scope.__cursorBus ??= new EventTarget());
}

/**
 * Whether a child of <html> is the cursor's host, judged from any world by its fixed inline style
 * (expandos set by the isolated-world painter are invisible to other worlds).
 */
export const CURSOR_HOST_TEST =
  'n.style.zIndex === "2147483647" && n.style.contain === "strict" && n.style.position === "fixed"';

/** Finds the painter's host from the world it was painted in. */
export function findCursorSurface(): HTMLElement | undefined {
  const parent = document.documentElement || document.body;
  if (!parent) return undefined;
  for (const child of Array.from(parent.children)) {
    if ((child as HTMLElement & { __cursorSurface?: boolean }).__cursorSurface)
      return child as HTMLElement;
  }
  return undefined;
}
