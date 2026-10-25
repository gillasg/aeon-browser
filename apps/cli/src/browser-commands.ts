import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { flag, has, type Args } from "browserkit/dist/args.js";
import { out, printJson, printRows } from "browserkit/dist/output.js";
import type { Command } from "browserkit/dist/usage.js";
import { dataDirectory } from "./client.js";
import type { DaemonHost } from "./host.js";
import { readJournal } from "./host.js";

// The browser itself, as Aeon sees it: the daemon and the user's Chrome. These replace the
// bridge-only commands (status, tabs, repl, journal, serve) browserkit's own command line has.

const TABS = `(await browser.tabs()).map((tab) => ({ target: tab.target, title: tab.title, url: tab.url }))`;

function cellText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

async function status(host: DaemonHost, args: Args): Promise<number> {
  const client = await host.connect();
  const browsers = await client.settings(undefined);
  if (has(args, "json")) {
    printJson({ running: true, browsers: browsers.length });
    return 0;
  }
  out(`Aeon is running; ${browsers.length} browser(s) connected.`);
  return 0;
}

async function tabs(host: DaemonHost, args: Args): Promise<number> {
  const list = ((await host.runInBrowser(TABS, { session: "cli" })) ?? []) as {
    target?: { tabId?: number };
    title?: string;
    url?: string;
  }[];
  if (has(args, "json")) {
    printJson(list);
    return 0;
  }
  printRows(list.map((tab) => [tab.target?.tabId, tab.title, tab.url]));
  return 0;
}

async function repl(host: DaemonHost, args: Args): Promise<number> {
  const given = args.positional.join(" ");
  const code =
    given === "-"
      ? await readStdin()
      : given.startsWith("@")
        ? await readFile(given.slice(1), "utf8")
        : given;
  if (!code.trim())
    throw new Error(
      'Usage: aeon repl "<code>" | @file.js | - [--session name] [--timeout s] [--quiet]',
    );
  const session = flag(args, "session") ?? "cli";
  // Seconds, as the help says; 500ms and 2s also read as written.
  const timeout = timeoutMs(flag(args, "timeout"));
  try {
    const value = await host.runInBrowser(code, {
      session,
      ...(timeout ? { timeoutMs: timeout } : {}),
    });
    if (!has(args, "quiet")) out(cellText(value));
    return 0;
  } catch (error) {
    // A timed-out cell can leave its tabs and jobs behind: close the session's own.
    if (timeout && /timed?\s?out|timeout/i.test(String(error)))
      await host
        .runInBrowser("await browser.session.close()", { session, timeoutMs: 5000 })
        .catch(() => undefined);
    if (!has(args, "quiet")) out(error instanceof Error ? error.message : String(error));
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

async function journal(args: Args): Promise<number> {
  const session = args.positional[0] ?? "cli";
  const limit = Number(flag(args, "limit") ?? 50);
  const entries = await readJournal(session, limit);
  if (has(args, "json")) printJson(entries);
  else if (!entries.length) out("No journal entries.");
  else
    for (const entry of entries)
      out(
        `${String(entry.ts ?? "")} ${entry.isError ? "ERR" : "ok "} ${String(entry.durationMs ?? 0)}ms ${String(entry.resultPreview ?? "").slice(0, 120)}`,
      );
  return 0;
}

async function serve(host: DaemonHost, args: Args): Promise<number> {
  let state: { endpoint?: string; pid?: number };
  try {
    state = JSON.parse(await readFile(join(dataDirectory(), "core-connection.json"), "utf8")) as {
      endpoint?: string;
      pid?: number;
    };
  } catch {
    throw new Error(
      "Aeon is not running. Open Chrome with Aeon loaded (the daemon starts with it), then retry.",
    );
  }
  if (has(args, "json")) printJson(state);
  else {
    out(`Aeon's daemon answers at ${state.endpoint ?? "?"} (pid ${state.pid ?? "?"}).`);
    out("Connected. Press Ctrl+C to stop watching.");
  }
  await host.connect();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  return 0;
}

export function browserCommands(host: DaemonHost): Command[] {
  return [
    {
      name: "status",
      group: "Browser",
      summary: "show whether Aeon and a browser are connected",
      help: `Usage: aeon status [--json]`,
      run: (args) => status(host, args),
    },
    {
      name: "tabs",
      group: "Browser",
      summary: "list the browser's open tabs",
      help: `Usage: aeon tabs [--json]

Prints tab id, title and URL, one tab per line; --json prints the browser's own entries.`,
      run: (args) => tabs(host, args),
    },
    {
      name: "repl",
      group: "Browser",
      summary: "run a browser_code cell",
      help: `Usage: aeon repl "<code>" | @file.js | - [--session name] [--timeout s] [--quiet]

The last expression is returned. Variables and tabs persist per session. @file.js runs code from
a file and - reads it from stdin, so long cells need no quoting. --timeout is in seconds (30,
500ms and 2s also work); a timed-out cell closes the session's own tabs and jobs. --quiet prints
nothing but keeps the exit code.`,
      run: (args) => repl(host, args),
    },
    {
      name: "journal",
      group: "Browser",
      summary: "show the last cells a session ran",
      help: `Usage: aeon journal [session] [--limit n] [--json]`,
      run: journal,
    },
    {
      name: "serve",
      group: "Browser",
      summary: "watch the daemon's Core endpoint in the foreground",
      help: `Usage: aeon serve

Usually the daemon starts with Chrome; this keeps a process attached to watch it.`,
      run: (args) => serve(host, args),
    },
  ];
}
