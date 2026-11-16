// Which transport answered an operation last time: the site's own tab or plain HTTP. The next
// call starts there. Only a shape change, a 401/403 or a success moves the preference; a
// transport error or an offline browser leaves it where it was.

import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName, writeAtomic } from "./registry.js";

export type TransportName = "direct" | "page";

export interface TransportNote {
  transport: TransportName;
  at: string;
}

const FILE = "transport.json";
const writes = new Map<string, Promise<unknown>>();

function pathOf(site: string): string {
  return join(siteDir(siteName(site)), FILE);
}

/** Preferences live beside a mapped site; a client built from a bare model keeps none. */
function mapped(site: string): boolean {
  return existsSync(join(siteDir(siteName(site)), "model.json"));
}

/** Every learned transport preference for a site. A missing or broken file means none. */
export async function readTransportPreferences(
  site: string,
): Promise<Record<string, TransportNote>> {
  if (!mapped(site)) return {};
  try {
    const value = JSON.parse(await readFile(pathOf(site), "utf8")) as Record<string, unknown>;
    return cleanNotes(value);
  } catch {
    return {};
  }
}

function cleanNotes(value: Record<string, unknown>): Record<string, TransportNote> {
  const notes: Record<string, TransportNote> = {};
  for (const [id, note] of Object.entries(value ?? {})) {
    const item = note as Partial<TransportNote> | undefined;
    if (item?.transport !== "direct" && item?.transport !== "page") continue;
    notes[id] = {
      transport: item.transport,
      at: typeof item.at === "string" ? item.at : new Date().toISOString(),
    };
  }
  return notes;
}

export async function readTransportPreference(
  site: string,
  operationId: string,
): Promise<TransportNote | undefined> {
  return (await readTransportPreferences(site))[operationId];
}

export function recordTransportPreference(
  site: string,
  operationId: string,
  transport: TransportName,
): Promise<void> {
  return serialised(site, () =>
    withLock(site, async () => {
      if (!mapped(site)) return;
      // Read-modify-write under a lock, so the daemon and a CLI keep each other's notes.
      const notes = await readTransportPreferences(site);
      if (notes[operationId]?.transport === transport) return;
      notes[operationId] = { transport, at: new Date().toISOString() };
      await mkdir(siteDir(siteName(site)), { recursive: true });
      await writeAtomic(pathOf(site), JSON.stringify(notes, null, 2) + "\n");
    }),
  );
}

export function clearTransportPreferences(site: string): Promise<void> {
  return serialised(site, () =>
    withLock(site, async () => {
      await writeAtomic(pathOf(site), JSON.stringify({}, null, 2) + "\n");
    }),
  );
}

const LOCK = ".transport.lock";
const LOCK_WAIT_MS = 2000;

/** A short cross-process lock beside the file; a stale one is dropped rather than waited on. */
async function withLock<T>(site: string, work: () => Promise<T>): Promise<T> {
  const lock = join(siteDir(siteName(site)), LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!(await takeLock(lock))) {
    if (Date.now() > deadline) {
      await rm(lock, { recursive: true, force: true }).catch(() => undefined);
      if (!(await takeLock(lock))) return work();
      break;
    }
    await delay(10);
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function takeLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EEXIST";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = writes.get(key) ?? Promise.resolve();
  const next = prior.then(work, work);
  writes.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
