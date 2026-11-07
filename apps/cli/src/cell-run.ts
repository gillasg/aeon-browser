import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AeonClient, dataDirectory } from "./client.js";

// Running one browser cell through the daemon and keeping it in the CLI journal. Light on purpose:
// `aeon repl` loads only this and the client (see repl-fast.ts).

export interface BrowserCell {
  value?: unknown;
  output?: string;
  error?: string;
  detail?: string;
}

export interface CellOptions {
  session?: string;
  timeoutMs?: number;
  browser?: string;
}

export const journalPath = (): string => join(dataDirectory(), "cli-journal.jsonl");

/** Runs the cell and journals it; the cell's own error stays in the result. */
export async function runCellOn(
  client: AeonClient,
  code: string,
  options: CellOptions = {},
): Promise<BrowserCell> {
  const session = options.session ?? "cli";
  const started = Date.now();
  const result = (await client.browserRun({
    code,
    session,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.browser ? { browser: options.browser } : {}),
  })) as BrowserCell;
  await record(session, result, Date.now() - started);
  return result;
}

export const offline = (result: BrowserCell): boolean =>
  result.error === "BROWSER_OFFLINE" || result.error === "AMBIGUOUS_BROWSER";

/** What a failed cell says, and for a missing browser how Aeon recovers. */
export function cellErrorMessage(result: BrowserCell): string {
  const code = result.error ?? "INTERNAL";
  if (code === "AMBIGUOUS_BROWSER")
    return "Several browsers are connected. Pick one with --browser <name> (see aeon browsers).";
  if (code === "BROWSER_OFFLINE")
    return "Aeon's browser is not connected. Open Chrome with Aeon loaded, then retry.";
  return result.detail ? `${code}: ${result.detail}` : code;
}

async function record(session: string, result: BrowserCell, durationMs: number): Promise<void> {
  const preview =
    result.error ?? result.detail ?? stringify(result.value) ?? result.output?.slice(0, 200) ?? "";
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    session,
    isError: Boolean(result.error),
    durationMs,
    resultPreview: preview.slice(0, 200),
  });
  const file = journalPath();
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, line + "\n").catch(() => undefined);
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value) ?? undefined;
  } catch {
    return String(value);
  }
}
