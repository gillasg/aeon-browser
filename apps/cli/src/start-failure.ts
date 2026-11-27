import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { graftAppRoot } from "@graft/location";

/** The supervisor's remembered cause, absent once the daemon is ready or the text is empty. */
export function startFailureOf(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const row = record as { state?: unknown; error?: unknown };
  if (row.state === "ready") return undefined;
  if (typeof row.error !== "string") return undefined;
  const error = row.error.trim();
  return error.length > 0 ? error : undefined;
}

export async function readStartFailure(): Promise<string | undefined> {
  try {
    const text = await readFile(join(graftAppRoot(), "daemon-supervisor-status.json"), "utf8");
    return startFailureOf(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export function notRunningMessage(startError: string | undefined): string {
  const base =
    "Graft is not running. Open Chrome with Graft loaded (the daemon starts with it), then retry.";
  return startError ? `${base} Last start failed: ${startError}` : base;
}
