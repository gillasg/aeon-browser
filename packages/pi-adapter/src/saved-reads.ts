import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Saved reads: the last text Aeon read from each page (page.markdown, page.data, page.table in
// browser code). When the user comes back to one of those pages, the page shows what changed
// since then ("2 changes since Tue") and the snapshot moves on to what they saw. Only pages
// Aeon has read are kept; the user's other browsing is never stored.

export interface SavedRead {
  url: string;
  at: string;
  /** The page's text as lines, for a line-level comparison. */
  lines: string[];
}

const MAX_LINES = 2000;
const MAX_LINE = 300;

/** A page's address without its fragment and tracking parameters. */
export function readKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const name of [...parsed.searchParams.keys()])
      if (/^(utm_|fbclid|gclid|ref$|ref_)/i.test(name)) parsed.searchParams.delete(name);
    return parsed.href;
  } catch {
    return url;
  }
}

function pathOf(root: string, url: string): string {
  return join(root, createHash("sha256").update(readKey(url)).digest("hex").slice(0, 32) + ".json");
}

/** Text as the lines a comparison works on: trimmed, without blanks, bounded. */
export function readLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 1)
    .map((line) => line.slice(0, MAX_LINE))
    .slice(0, MAX_LINES);
}

export async function getSavedRead(root: string, url: string): Promise<SavedRead | undefined> {
  try {
    return JSON.parse(await readFile(pathOf(root, url), "utf8")) as SavedRead;
  } catch {
    return undefined;
  }
}

/**
 * Saves what was read. `onlyIfKnown` updates a page that is already saved (the user looked at it
 * again) and never adds a new one, so the user's own browsing is not recorded.
 */
export async function putSavedRead(
  root: string,
  url: string,
  text: string,
  options: { onlyIfKnown?: boolean } = {},
): Promise<boolean> {
  if (!/^(https?|aeon-api):/i.test(url)) return false;
  if (options.onlyIfKnown && !(await getSavedRead(root, url))) return false;
  const lines = readLines(text);
  if (!lines.length) return false;
  await mkdir(root, { recursive: true });
  const path = pathOf(root, url);
  const record: SavedRead = { url: readKey(url), at: new Date().toISOString(), lines };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, path);
  return true;
}

/** A browser code read to save: {savedRead: {url, text}}. */
export function isSavedReadRequest(
  value: unknown,
): value is { savedRead: { url: string; text: string } } {
  const read = (value as { savedRead?: { url?: unknown; text?: unknown } } | null)?.savedRead;
  return typeof read?.url === "string" && typeof read.text === "string";
}
