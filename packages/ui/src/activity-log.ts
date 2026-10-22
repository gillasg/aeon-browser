import { useEffect, useState } from "react";
import type { PiSessionEventDto } from "@aeon/protocol";

// Actions that matter (orders, messages, bookings, deletes, site changes), newest first, in the
// extension's localStorage, which every Aeon page shares. Writes sent through a site's API come
// from Core on the step that sent them, with every item; runs that typed into or submitted a
// page are logged by the orb. Undo stays off until a tool reports how to reverse what it did.

export interface ActivityEntry {
  id: string;
  at: string;
  chatId: string;
  host: string;
  /** What the user asked for. */
  task: string;
  /** What it changed, e.g. "Typed into 2 fields, submitted 1 form". */
  summary: string;
  /** Present only when the site lets the change be reversed. */
  undo?: { label: string };
  /** Every item a write through the site's API changed, for the full list. */
  items?: string[];
}

export const ACTIVITY_LOG_KEY = "aeonActivityLog";
const MAX_ENTRIES = 200;

export function readActivityLog(): ActivityEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACTIVITY_LOG_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function appendActivity(entry: ActivityEntry): void {
  try {
    const next = [entry, ...readActivityLog().filter((item) => item.id !== entry.id)];
    localStorage.setItem(ACTIVITY_LOG_KEY, JSON.stringify(next.slice(0, MAX_ENTRIES)));
    window.dispatchEvent(new Event(ACTIVITY_LOG_KEY));
  } catch {
    /* Storage may be unavailable; the log is a convenience. */
  }
}

export function useActivityLog(): ActivityEntry[] {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    const read = () => setEntries(readActivityLog());
    read();
    window.addEventListener("storage", read);
    window.addEventListener(ACTIVITY_LOG_KEY, read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener(ACTIVITY_LOG_KEY, read);
    };
  }, []);
  return entries;
}

/**
 * Logs the writes a step sent through sites' APIs (siteApi.write / batch). Each chat page that
 * sees the step logs it; the id keeps it to one entry.
 */
export function logApiWrites(
  event: PiSessionEventDto,
  info: { chatId: string; task?: string },
): void {
  if (event.kind !== "tool-end" || !event.writes?.length) return;
  for (const write of event.writes) {
    if (!write.done) continue;
    const failed = write.failed ? `, ${write.failed} failed` : "";
    appendActivity({
      id: [info.chatId, event.toolCallId, write.site, write.operation].join(":"),
      at: new Date().toISOString(),
      chatId: info.chatId,
      host: write.site,
      task: info.task ?? "",
      summary: `${operationWords(write.operation)}: ${write.done} item${write.done === 1 ? "" : "s"}${failed}`,
      items: write.items,
    });
  }
}

/** removeFromWatchLater → "Remove from watch later". */
function operationWords(operation: string): string {
  const words = operation.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Entries from the last 24 hours, for the count in the top bar. */
export function recentActivityCount(entries: readonly ActivityEntry[], now = Date.now()): number {
  return entries.filter((entry) => now - Date.parse(entry.at) < 86_400_000).length;
}

/** "Typed into 2 fields, submitted 1 form" from the write actions of a run. */
export function describeWrites(kinds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) {
    const verb = WRITE_VERBS.find(([pattern]) => pattern.test(kind));
    if (verb) counts.set(verb[1], (counts.get(verb[1]) ?? 0) + 1);
  }
  return [...counts]
    .map(([phrase, count]) => phrase.replace("#", String(count)).replace(/\(s\)/, plural(count)))
    .join(", ");
}

const WRITE_VERBS: Array<[RegExp, string]> = [
  [/fill|type|insert/i, "typed into # field(s)"],
  [/select|check/i, "changed # option(s)"],
  [/upload|drop/i, "uploaded # file(s)"],
  [/submit/i, "submitted # form(s)"],
  [/press|key/i, "pressed # key(s)"],
  [/drag/i, "dragged # item(s)"],
];

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function isEntry(value: unknown): value is ActivityEntry {
  const entry = value as Partial<ActivityEntry> | null;
  return (
    typeof entry?.id === "string" &&
    typeof entry.at === "string" &&
    typeof entry.task === "string" &&
    typeof entry.summary === "string"
  );
}
