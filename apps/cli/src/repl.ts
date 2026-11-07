import { readFile } from "node:fs/promises";
import { flag, has, type Args } from "browserkit/dist/args.js";
import { out } from "browserkit/dist/output.js";
import type { BrowserCell, CellOptions } from "./cell-run.js";

// `aeon repl`: one cell of browser code in the user's Chrome. Any runner works: the full CLI's
// daemon host, or repl-fast.ts's lean one.

export interface CellRunner {
  runCell(code: string, options?: CellOptions): Promise<BrowserCell>;
  runInBrowser(code: string, options?: CellOptions): Promise<unknown>;
}

/** What `aeon repl` prints: the cell's log, then its value. */
export function replText(cell: { output?: string; value?: unknown }): string {
  const output = cell.output?.trimEnd();
  // bu.state() logs its text and returns it; print it once.
  const echoed = typeof cell.value === "string" && Boolean(output?.includes(cell.value.trimEnd()));
  return [output, echoed ? "" : cellText(cell.value)].filter(Boolean).join("\n");
}

function cellText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

async function replCode(args: Args): Promise<string> {
  const given = args.positional.join(" ");
  const code =
    given === "-"
      ? await readStdin()
      : given.startsWith("@")
        ? await readFile(given.slice(1), "utf8")
        : given;
  if (!code.trim())
    throw new Error(
      'Usage: aeon repl "<code>" | @file.js | - [--session name] [--browser name] [--timeout s] [--quiet]',
    );
  return code;
}

export async function repl(host: CellRunner, args: Args): Promise<number> {
  const code = await replCode(args);
  const session = flag(args, "session") ?? "cli";
  const browser = flag(args, "browser");
  const where = { session, ...(typeof browser === "string" ? { browser } : {}) };
  // Seconds, as the help says; 500ms and 2s also read as written.
  const timeout = timeoutMs(flag(args, "timeout"));
  try {
    const cell = await host.runCell(code, {
      ...where,
      ...(timeout ? { timeoutMs: timeout } : {}),
    });
    // What the cell logged comes first, then its value, as in the engine's own repl.
    if (!has(args, "quiet")) out(replText(cell));
    return 0;
  } catch (error) {
    const logged = (error as { output?: string }).output?.trimEnd();
    if (logged && !has(args, "quiet")) out(logged);
    // A timed-out cell can leave its tabs and jobs behind: close the session's own.
    if (timeout && /timed?\s?out|timeout/i.test(String(error)))
      await host
        .runInBrowser("await browser.session.close()", { ...where, timeoutMs: 5000 })
        .catch(() => undefined);
    // --quiet drops the output, never the error: it goes to stderr.
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
}

function timeoutMs(value: string | true | undefined): number | undefined {
  if (value === undefined || value === true) return undefined;
  const text = String(value).trim();
  const seconds = /^(\d+(?:\.\d+)?)s$/i.exec(text);
  const millis = /^(\d+)ms$/i.exec(text);
  const number = seconds
    ? Number(seconds[1]) * 1000
    : millis
      ? Number(millis[1])
      : Number(text) * 1000;
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
