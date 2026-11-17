// The cursor's host is a plain, unlabelled element with a closed shadow root. Page scripts cannot
// select it (no id, class or data-aeon-* attribute) and cannot read inside the shadow root. State
// crosses between the main-world painter and the isolated-world orb over these two neutral DOM
// events, so nothing about Aeon is written into the page DOM.

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

/**
 * Finds the painter's host from the main world. The painter marks it with a non-enumerable expando
 * rather than an id, so a page script has no selector for it. Isolated worlds have their own DOM
 * wrappers and cannot see this expando; they use CURSOR_STATE_EVENT instead.
 */
export function findCursorSurface(): HTMLElement | undefined {
  const parent = document.documentElement || document.body;
  if (!parent) return undefined;
  for (const child of Array.from(parent.children)) {
    if ((child as HTMLElement & { __cursorSurface?: boolean }).__cursorSurface)
      return child as HTMLElement;
  }
  return undefined;
}
