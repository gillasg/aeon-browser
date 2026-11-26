// Listing a recording: filters for match/method/type, frame scope and an incremental cursor.
import { summarize, type NetworkEntry } from "./native-browser-network-format.js";
import { classFilter, classOfEntry } from "./request-class.js";

export interface ListOptions {
  match?: string;
  method?: string;
  type?: string;
  since?: number;
  frames?: "top" | "all";
  cursor?: boolean;
  /** One request class or several: "api", ["api", "graphql"]. */
  class?: string | string[];
}

function expandRedirects(entries: Iterable<NetworkEntry>): NetworkEntry[] {
  const expanded: NetworkEntry[] = [];
  for (const entry of entries) {
    if (entry.redirects?.length) {
      for (let i = 0; i < entry.redirects.length; i++) {
        const hop = entry.redirects[i];
        if (!hop) continue;
        expanded.push({
          id: `${entry.id}#hop-${hop.hop ?? i}`,
          url: hop.url,
          method: entry.method,
          type: entry.type,
          startedAt: entry.startedAt,
          ...(entry.frameId ? { frameId: entry.frameId } : {}),
          ...(entry.frameUrl ? { frameUrl: entry.frameUrl } : {}),
          ...(entry.source ? { source: entry.source } : {}),
          ...(entry.documentURL ? { documentURL: entry.documentURL } : {}),
          requestHeaders: hop.requestHeaders ?? {},
          responseHeaders: hop.headers,
          status: hop.status,
          done: true,
        });
      }
    }
    expanded.push(entry);
  }
  return expanded;
}

export function listEntries(
  entries: Iterable<NetworkEntry>,
  options: Record<string, unknown>,
): unknown[] {
  const match = typeof options.match === "string" && options.match ? options.match : undefined;
  const method = typeof options.method === "string" ? options.method.toUpperCase() : undefined;
  const since = typeof options.since === "number" ? options.since : undefined;
  const topOnly = options.frames === "top";
  const classes = classFilter(options.class);
  return expandRedirects(entries)
    .filter((entry) => !topOnly || (!entry.frameUrl && !entry.source))
    .filter((entry) => since === undefined || entry.startedAt > since)
    .filter((entry) => !match || entry.url.includes(match))
    .filter((entry) => !method || entry.method === method)
    .filter((entry) => typeof options.type !== "string" || matchesType(entry, options.type))
    .filter((entry) => !classes || classes(classOfEntry(entry)))
    .map(summarize);
}

/** The last few requests, for "nothing matched, but this is what happened". */
export function recentOf(entries: readonly NetworkEntry[]): string[] {
  return entries
    .slice(-3)
    .map(
      (entry) => entry.method + " " + pathOf(entry.url) + (entry.status ? " " + entry.status : ""),
    );
}

/** A Chrome resource type (Fetch, XHR, Document) or a MIME: json, html, image/png, image/, +json. */
export function matchesType(entry: { type?: string; mimeType?: string }, wanted: string): boolean {
  if (entry.type === wanted) return true;
  const want = wanted.toLowerCase();
  if (entry.type && entry.type.toLowerCase() === want) return true;
  // Scripts by resource type or MIME: 'Script', 'script', 'javascript' and 'js' all mean them.
  if (/^(script|javascript|js)$/.test(want))
    return entry.type === "Script" || /javascript|ecmascript/.test(mimeOf(entry.mimeType));
  return mimeMatches(mimeOf(entry.mimeType), wanted.toLowerCase());
}

function mimeOf(mime: string | undefined): string {
  return (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function mimeMatches(mime: string, want: string): boolean {
  if (!mime || !want) return false;
  if (want === "json") return mime.includes("json");
  if (want === "+json") return mime.includes("+json");
  if (want === "html") return mime.includes("/html") || mime.endsWith("html");
  if (want.endsWith("/")) return mime.startsWith(want);
  if (want.includes("/")) return mime === want || mime.startsWith(`${want}+`);
  return false;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/**
 * Why a list came back empty: the tab is recorded from its first request on, so an empty list
 * means the page loaded before this chat had the tab.
 */
export function describeState(input: {
  entries?: NetworkEntry[];
  stopped?: boolean;
  passive?: boolean;
  fromStart?: boolean;
}): Record<string, unknown> {
  const entries = input.entries;
  if (!entries)
    return input.stopped
      ? { recording: false, entries: 0, note: "network capture is stopped: page.network.start()" }
      : {
          recording: false,
          entries: 0,
          note: "nothing captured in this tab yet: capture starts when this chat opens or navigates a tab; reload the page to capture it",
        };
  const first = entries.length ? Math.min(...entries.map((entry) => entry.startedAt)) : undefined;
  return {
    recording: true,
    passive: input.passive === true,
    entries: entries.length,
    ...(first ? { since: new Date(first).toISOString() } : {}),
    ...(entries.length ? { recent: recentOf(entries) } : {}),
    ...(entries.length
      ? {}
      : {
          note: input.fromStart
            ? "nothing recorded in this tab yet: the page has made no requests since the chat opened it (the page itself and its fetch/XHR calls are listed); page.network.start() records everything"
            : "capture began after the page loaded: reload to capture its requests, or page.network.start() before the flow",
        }),
  };
}
