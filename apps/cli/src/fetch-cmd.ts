import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "browserkit/dist/usage.js";
import type { DaemonHost } from "./host.js";

// `graft fetch <url>`: one HTTP request through the user's signed-in Chrome, with curl's flags.
// It is a single browser cell (browser.fetch, or page.request from a tab of that origin with
// --page), so the engine's per-hop redirect, private-network and site-rule checks apply. No model
// is called and no debugger is attached. The body goes to stdout; a one-line receipt to stderr.

export const FETCH_HELP = `Usage: graft fetch [options] <url>

Makes one request with your signed-in Chrome's cookies, for sites with no public API:
  graft fetch https://substack.com/api/v1/inbox | jq .
  graft fetch -X POST --json '{"read":true}' https://substack.com/api/v1/inbox/mark

  -X, --method <METHOD>   request method (GET; POST when a body is given)
  -H, --header <N: V>     add a header (repeatable)
  -d, --data <s|@file>    request body, or read it from a file
      --json <json>       JSON body; sets Content-Type: application/json
      --page              send from an open tab of that origin (the page's own request)
      --browser <name>    which connected Chrome profile to use (see graft browsers)
  -i, --include           print the status line and headers first (auth headers redacted)
  -f, --fail              exit 22 when the status is 400 or above
  -o, --output <path>     write the body to a file instead of stdout
  -q, --quiet             no receipt on stderr
      --timeout <ms>      request timeout in milliseconds (30000)`;

export interface FetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  page: boolean;
  browser?: string;
  include: boolean;
  fail: boolean;
  output?: string;
  quiet: boolean;
  timeoutMs: number;
  help: boolean;
}

export interface FetchResponse {
  status: number;
  statusText?: string;
  url?: string;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}

export interface FetchDeps {
  run(
    code: string,
    options: { session: string; timeoutMs: number; browser?: string },
  ): Promise<unknown>;
  stdout(text: string): void;
  stderr(text: string): void;
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string) => Promise<void>;
}

const VALUED: Record<string, string> = {
  "-X": "method",
  "--method": "method",
  "-H": "header",
  "--header": "header",
  "-d": "data",
  "--data": "data",
  "--json": "json",
  "--browser": "browser",
  "-o": "output",
  "--output": "output",
  "--timeout": "timeout",
};
const SWITCHES: Record<string, string> = {
  "--page": "page",
  "-i": "include",
  "--include": "include",
  "-f": "fail",
  "--fail": "fail",
  "-q": "quiet",
  "--quiet": "quiet",
  "-h": "help",
  "--help": "help",
};

/** Headers whose values are session secrets: never printed by --include. */
export const REDACTED_HEADERS = new Set([
  "set-cookie",
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-csrf-token",
  "x-xsrf-token",
]);

interface RawArgs {
  values: Record<string, string>;
  headers: Record<string, string>;
  switches: Set<string>;
  positional: string[];
}

function addHeader(headers: Record<string, string>, value: string): void {
  const colon = value.indexOf(":");
  if (colon <= 0) throw new Error(`Header must be "Name: Value", got "${value}"`);
  headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
}

/** Splits argv into valued flags, headers, switches and the URL. */
function scanArgs(argv: string[]): RawArgs {
  const raw: RawArgs = { values: {}, headers: {}, switches: new Set(), positional: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    const [name, inline] = arg.startsWith("--")
      ? (arg.split(/=(.*)/s, 2) as [string, string?])
      : [arg];
    const valued = VALUED[name];
    const toggle = SWITCHES[arg];
    if (valued) {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`${name} needs a value`);
      if (valued === "header") addHeader(raw.headers, value);
      else raw.values[valued] = value;
    } else if (toggle) raw.switches.add(toggle);
    else if (arg.startsWith("-") && arg.length > 1) throw new Error(`Unknown option ${arg}`);
    else raw.positional.push(arg);
  }
  return raw;
}

/** The request body: --json (validated, with its content type) or -d text or @file. */
async function readBody(
  raw: RawArgs,
  read: (path: string) => Promise<string>,
): Promise<string | undefined> {
  const { json, data } = raw.values;
  if (json !== undefined) {
    try {
      JSON.parse(json);
    } catch {
      throw new Error("--json is not valid JSON");
    }
    if (!Object.keys(raw.headers).some((name) => name.toLowerCase() === "content-type"))
      raw.headers["Content-Type"] = "application/json";
    return json;
  }
  if (data === undefined) return undefined;
  return data.startsWith("@") ? read(data.slice(1)) : data;
}

function readTimeout(value: string | undefined): number {
  const timeoutMs = value === undefined ? 30_000 : Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("--timeout must be milliseconds");
  return timeoutMs;
}

/** Parses curl-style arguments; -d @file is read here so the cell gets the body itself. */
export async function parseFetchArgs(
  argv: string[],
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<FetchOptions> {
  const raw = scanArgs(argv);
  const { values, switches } = raw;
  const help = switches.has("help");
  const url = raw.positional[0] ?? "";
  if (!help && !url) throw new Error(FETCH_HELP);
  const body = await readBody(raw, read);
  return {
    url,
    method: (values.method ?? (body !== undefined ? "POST" : "GET")).toUpperCase(),
    headers: raw.headers,
    ...(body !== undefined ? { body } : {}),
    page: switches.has("page"),
    ...(values.browser ? { browser: values.browser } : {}),
    include: switches.has("include"),
    fail: switches.has("fail"),
    ...(values.output ? { output: values.output } : {}),
    quiet: switches.has("quiet"),
    timeoutMs: readTimeout(values.timeout),
    help,
  };
}

/** Only http and https: file:, javascript:, data: and the rest are refused before Chrome. */
export function checkFetchUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error(`graft fetch only supports http and https URLs, not ${parsed.protocol}`);
  return parsed;
}

/** The browser cell: browser.fetch with no tab, or page.request from a tab of the origin. */
export function fetchCell(options: FetchOptions): string {
  const init = JSON.stringify({
    method: options.method,
    headers: options.headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
  const url = JSON.stringify(options.url);
  if (!options.page)
    return `return await browser.fetch(${url}, { ...${init}, as: "text", timeoutMs: ${options.timeoutMs} });`;
  // Reuse a tab the user already has on that origin; open a quiet one only when there is none.
  return `const origin = new URL(${url}).origin;
const open = (await browser.tabs()).find((tab) => { try { return new URL(tab.url).origin === origin; } catch { return false; } });
const page = open ? await browser.tab(open.id) : await browser.openTab(origin, { quiet: true });
return await page.request(${url}, ${init});`;
}

export function formatHeaders(response: FetchResponse): string {
  const lines = [`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`];
  for (const [name, value] of Object.entries(response.headers ?? {}))
    lines.push(`${name}: ${REDACTED_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value}`);
  return lines.join("\n") + "\n\n";
}

function bodyOf(response: FetchResponse): string {
  if (response.text !== undefined) return response.text;
  if (response.json !== undefined) return JSON.stringify(response.json);
  return "";
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Sends the cell; a missing or malformed answer is an error like any failed cell. */
async function send(options: FetchOptions, deps: FetchDeps): Promise<FetchResponse> {
  const response = (await deps.run(fetchCell(options), {
    session: "cli-fetch",
    timeoutMs: options.timeoutMs + 5_000,
    ...(options.browser ? { browser: options.browser } : {}),
  })) as FetchResponse | undefined;
  if (!response || typeof response.status !== "number") throw new Error("no response");
  return response;
}

async function print(options: FetchOptions, response: FetchResponse, deps: FetchDeps) {
  const body = bodyOf(response);
  const head = options.include ? formatHeaders(response) : "";
  if (!options.output) return deps.stdout(head + body);
  await (deps.writeFile ?? ((path, data) => writeFile(path, data)))(options.output, body);
  if (head) deps.stdout(head);
}

/** Runs the command; returns the exit code (curl's 22 for --fail on an HTTP error). */
export async function runFetch(argv: string[], deps: FetchDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  let options: FetchOptions;
  try {
    options = await parseFetchArgs(argv, deps.readFile);
    if (!options.help) checkFetchUrl(options.url);
  } catch (error) {
    deps.stderr(`${message(error)}\n`);
    return 2;
  }
  if (options.help) {
    deps.stdout(FETCH_HELP + "\n");
    return 0;
  }
  const started = now();
  let response: FetchResponse;
  try {
    response = await send(options, deps);
  } catch (error) {
    deps.stderr(`graft fetch: ${message(error)}\n`);
    return 1;
  }
  await print(options, response, deps);
  if (!options.quiet) {
    const seconds = ((now() - started) / 1000).toFixed(1);
    deps.stderr(`${response.status} · ${seconds} s · via Chrome${options.page ? " tab" : ""}\n`);
  }
  return options.fail && response.status >= 400 ? 22 : 0;
}

export function fetchCommand(host: DaemonHost): Command {
  return {
    name: "fetch",
    group: "Browser",
    summary: "make an HTTP request with your signed-in Chrome's cookies",
    help: FETCH_HELP,
    // The shared parser has no short or repeatable flags, so read this command's own argv.
    run: () => {
      const argv = process.argv.slice(2);
      return runFetch(argv.slice(argv.indexOf("fetch") + 1), {
        run: (code, options) => host.runInBrowser(code, options),
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      });
    },
  };
}
