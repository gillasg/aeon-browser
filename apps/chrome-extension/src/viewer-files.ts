// Pure pieces of the file viewer: its deep link, the one reusable Viewer tab, the recent-files strip
// and which preview a file gets. Kept free of chrome.* so they are unit-tested in Node.

export interface ViewerTarget {
  chatId: string;
  path: string;
  line?: number;
  /** Session-storage id of a diff the chat handed over. */
  diff?: string;
}

export interface RecentFile extends ViewerTarget {
  openedAt: number;
}

export const RECENT_KEY = "aeon-viewer-recent";
export const RECENT_MAX = 8;

/** The deep link for one file: viewer.html?chatId=…&path=…&line=…&diff=… */
export function viewerHref(base: string, target: ViewerTarget): string {
  const url = new URL(base);
  url.search = "";
  url.searchParams.set("chatId", target.chatId);
  url.searchParams.set("path", target.path);
  if (target.line) url.searchParams.set("line", String(target.line));
  if (target.diff) url.searchParams.set("diff", target.diff);
  return url.href;
}

/** Reads a deep link back; undefined when it is not one. */
export function parseViewerHref(href: string): ViewerTarget | undefined {
  const url = new URL(href);
  const chatId = url.searchParams.get("chatId");
  const path = url.searchParams.get("path");
  if (!chatId || !path) return undefined;
  const line = Number(url.searchParams.get("line"));
  const diff = url.searchParams.get("diff");
  return {
    chatId,
    path,
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    ...(diff ? { diff } : {}),
  };
}

/**
 * The tab a click should reuse: the open Viewer tab (any file), preferring one in the given window,
 * then the most recently used. Every file click lands in this one tab instead of a new one.
 */
interface TabLike {
  id?: number | undefined;
  url?: string | undefined;
  windowId?: number | undefined;
  lastAccessed?: number | undefined;
}

export function pickViewerTab<T extends TabLike>(
  tabs: readonly T[],
  base: string,
  windowId?: number,
): T | undefined {
  const page = new URL(base);
  const viewers = tabs.filter((tab) => {
    if (tab.id === undefined || !tab.url) return false;
    try {
      const url = new URL(tab.url);
      return url.origin === page.origin && url.pathname === page.pathname;
    } catch {
      return false;
    }
  });
  return viewers.sort(
    (a, b) =>
      Number(b.windowId === windowId) - Number(a.windowId === windowId) ||
      (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
  )[0];
}

/** Puts a file at the front of the recent strip; the same file (and chat) appears once. */
export function pushRecent(
  list: readonly RecentFile[],
  target: ViewerTarget,
  now: number,
  max = RECENT_MAX,
): RecentFile[] {
  const same = (item: ViewerTarget) =>
    item.chatId === target.chatId && item.path === target.path && item.diff === target.diff;
  return [{ ...target, openedAt: now }, ...list.filter((item) => !same(item))].slice(0, max);
}

/** Validates what session storage returned, dropping anything malformed. */
export function readRecent(value: unknown): RecentFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.chatId !== "string" || typeof entry.path !== "string") return [];
    return [
      {
        chatId: entry.chatId,
        path: entry.path,
        openedAt: typeof entry.openedAt === "number" ? entry.openedAt : 0,
        ...(typeof entry.line === "number" ? { line: entry.line } : {}),
        ...(typeof entry.diff === "string" ? { diff: entry.diff } : {}),
      },
    ];
  });
}

export type PreviewKind = "markdown" | "csv" | "html" | "image" | "none";

export function previewKind(path: string, language: string): PreviewKind {
  const name = path.toLowerCase();
  if (language === "markdown" || /\.(md|markdown|mdx)$/.test(name)) return "markdown";
  if (/\.(csv|tsv)$/.test(name)) return "csv";
  if (language === "html" || /\.html?$/.test(name)) return "html";
  if (/\.svg$/.test(name)) return "image";
  return "none";
}

/** A small RFC 4180 reader: quoted fields, doubled quotes, CRLF. Tabs split a .tsv. */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const d = delimiter === "\t" ? "\\t" : delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`("(?:[^"]|"")*"|[^${d}\\r\\n]*)(${d}|\\r?\\n|\\r|$)`, "g");
  const rows: string[][] = [];
  let row: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[1] ?? "";
    const end = match[2] ?? "";
    if (match.index === text.length && raw === "") {
      // The end of the text: a trailing delimiter still owes its row an empty field.
      if (row.length) rows.push([...row, ""]);
      break;
    }
    row.push(raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw);
    if (end === delimiter) continue;
    rows.push(row);
    row = [];
    if (end === "") break;
  }
  return rows;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
