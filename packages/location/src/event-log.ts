import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The durable log of routine firings that `aeon mcp` serves as MCP events. The daemon appends;
// any number of MCP servers read. Each record has a monotonic integer cursor, so a reader resumes
// exactly after the last event it saw, across restarts of either side.

export type AeonEventKind = "watcher" | "listener" | "webhook";

export interface AeonEventRecord {
  cursor: number;
  kind: AeonEventKind;
  routineId: string;
  site: string;
  title: string;
  value: unknown;
  firedAt: string;
}

const KEEP = 2000;

export function eventLogPath(dataDirectory: string): string {
  return join(dataDirectory, "mcp-events.jsonl");
}

/** Every record in order; an unreadable or torn line is skipped. */
export async function readEventLog(dataDirectory: string): Promise<AeonEventRecord[]> {
  const text = await readFile(eventLogPath(dataDirectory), "utf8").catch(() => "");
  const records: AeonEventRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as AeonEventRecord;
      if (Number.isSafeInteger(record.cursor)) records.push(record);
    } catch {
      // A partial write at the tail is retried by nobody; skip it.
    }
  }
  return records;
}

let appending: Promise<unknown> = Promise.resolve();

/** Append one event with the next cursor. Appends from one process are serialised. */
export function appendEventLog(
  dataDirectory: string,
  event: Omit<AeonEventRecord, "cursor">,
): Promise<AeonEventRecord> {
  const next = appending.then(() => appendNow(dataDirectory, event));
  appending = next.catch(() => undefined);
  return next;
}

async function appendNow(
  dataDirectory: string,
  event: Omit<AeonEventRecord, "cursor">,
): Promise<AeonEventRecord> {
  await mkdir(dataDirectory, { recursive: true });
  const existing = await readEventLog(dataDirectory);
  const record = { cursor: (existing.at(-1)?.cursor ?? 0) + 1, ...event };
  if (existing.length >= KEEP * 2) {
    const kept = [...existing.slice(-KEEP), record].map((item) => JSON.stringify(item));
    const path = eventLogPath(dataDirectory);
    await writeFile(`${path}.tmp`, `${kept.join("\n")}\n`);
    await rename(`${path}.tmp`, path);
  } else await appendFile(eventLogPath(dataDirectory), `${JSON.stringify(record)}\n`);
  return record;
}
