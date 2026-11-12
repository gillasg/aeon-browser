// Aeon's own tabs (Home in the new tab, a chat in a tab, the viewer, site scripts) get the cursor
// box too, from the same shortcut. Chrome keeps content scripts and chrome.scripting out of
// extension pages, so these pages load orb-content.js themselves, and the worker hands them the
// shared cursor's shape to draw (CURSOR_LOCAL) instead of injecting it.

const AEON_TAB_PAGES = new Set(["/home.html", "/chat.html", "/viewer.html", "/site-scripts.html"]);

/** Service worker → an Aeon page: draw the shared page cursor here. */
export const CURSOR_LOCAL = "aeon.cursor.local";

export interface CursorLocal {
  kind: typeof CURSOR_LOCAL;
  update: SummonUpdate;
  css: string;
  mark: object;
}

/** A top-level Aeon page the cursor can be summoned on. `base` is chrome.runtime.getURL(""). */
export function isAeonTabPage(url: string | undefined, base: string): boolean {
  if (!url?.startsWith(base)) return false;
  try {
    return AEON_TAB_PAGES.has(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Web pages and Aeon's own tabs: everywhere the cursor can be. */
export function isCursorPage(url: string | undefined, base: string): boolean {
  return /^https?:/.test(url ?? "") || isAeonTabPage(url, base);
}

/** The chat a chat tab shows, so the cursor box there follows that chat. */
export function pageChatId(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (url.pathname !== "/chat.html" || url.searchParams.get("host") === "panel") return undefined;
    return url.searchParams.get("chatId") || undefined;
  } catch {
    return undefined;
  }
}

export interface SummonUpdate {
  x: number;
  y: number;
  summon: true;
  place: true;
}

export function summonUpdate(x: number, y: number): SummonUpdate {
  return {
    x: Number.isFinite(x) ? Math.round(x) : 56,
    y: Number.isFinite(y) ? Math.round(y) : 56,
    summon: true,
    place: true,
  };
}

export function isCursorLocal(value: unknown): value is CursorLocal {
  const message = value as Partial<CursorLocal> | null;
  return (
    message?.kind === CURSOR_LOCAL &&
    typeof message.css === "string" &&
    typeof message.mark === "object" &&
    typeof message.update === "object"
  );
}

type CursorPage = { __aeonCursor?: (next: object, css: string, cursor: object) => void };

/** On an Aeon page: load the shared page cursor from the extension and draw it. */
export async function drawLocalCursor(message: CursorLocal): Promise<void> {
  const page = globalThis as CursorPage;
  if (!page.__aeonCursor) await loadScript(chrome.runtime.getURL("cursor-page.js"));
  page.__aeonCursor?.(message.update, message.css, message.mark);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = script.onerror = () => resolve();
    document.head.append(script);
  });
}
