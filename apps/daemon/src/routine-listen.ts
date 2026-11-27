import type { RoutineListen, RoutineRecord } from "@graft/domain";

// The shared definition of a live watcher: parsing, matching, the timer fallback and the code a
// listening routine runs in the browser. The browser code reuses page.waitForResponse (CDP Network
// events, body read only for the matching response, no extra request) and the routine's own check,
// so a live check keeps exactly the same "new since last time" state (browser.changes) as a timer
// check: both run in the same per-routine realm.

/** Omitted keeps the current option (editors that do not know about listen); null removes it. */
export function optionalListen(
  value: unknown,
  fallback: RoutineListen | null = null,
): RoutineListen | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("listen must be an object with a url, or null.");
  const input = value as Record<string, unknown>;
  const url = listenUrl(input.url);
  const type = listenType(input.type);
  return { url, ...(type ? { type } : {}) };
}

function listenUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000)
    throw new Error("listen.url must be a URL part of at most 2000 characters.");
  return value.trim();
}

function listenType(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || !value.trim() || value.length > 100)
    throw new Error("listen.type must be a resource type or MIME such as json.");
  return value.trim();
}

/** A routine is live when it carries a listen filter. */
export function isLive(routine: Pick<RoutineRecord, "listen">): boolean {
  return Boolean(routine.listen && routine.listen.url);
}

/** URL matching is a substring: the same test the engine's page.waitForResponse applies. */
export function matchesListenUrl(url: string, listen: RoutineListen): boolean {
  return Boolean(listen.url) && url.includes(listen.url);
}

/** A resource type (Fetch, XHR) or a MIME (json, image/, +json), as page.network filters use. */
export function matchesListenType(
  entry: { type?: string; mimeType?: string },
  wanted: string,
): boolean {
  if (entry.type === wanted) return true;
  const mime = (entry.mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return mimeMatches(mime, wanted.toLowerCase());
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

/** Whether a finished response is one the listener should hand to the check. */
export function matchesListenResponse(
  response: { url: string; type?: string; mimeType?: string },
  listen: RoutineListen,
): boolean {
  return (
    matchesListenUrl(response.url, listen) &&
    (!listen.type || matchesListenType(response, listen.type))
  );
}

/** Normalise a site to a host, like the routine's "only these sites" list. */
export function siteHost(site: string): string {
  return site
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

export function siteOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Which open tab a live routine watches. The routine's sites name the watched site when present;
 * without them the listen URL part must appear in the tab's own URL. No tab is opened or kept.
 */
export function tabMatchesListen(tabUrl: string, listen: RoutineListen, sites: string[]): boolean {
  if (sites.length) {
    const host = siteOfUrl(tabUrl);
    return (
      Boolean(host) &&
      sites.some((site) => {
        const want = siteHost(site);
        return Boolean(want) && (host === want || host.endsWith(`.${want}`));
      })
    );
  }
  return matchesListenUrl(tabUrl, listen);
}

const STREAM_TYPES = new Set(["ws", "sse", "webrtc", "stream"]);
const PUSH_TYPES = new Set(["push", "notification", "badge", "title", "notifications"]);

/**
 * The wait a live check makes. A stream type (ws, sse, webrtc, stream) waits on page.streams for
 * the next frame from a matching URL; a push type (push, notification, badge, title) waits on
 * page.notifications. Both are woken by the engine's CDP events, never by polling. Anything else
 * waits for the next matching finished response.
 */
export function liveWaitCode(listen: RoutineListen): string {
  const url = JSON.stringify(listen.url);
  const type = listen.type ?? "";
  if (STREAM_TYPES.has(type)) {
    const kind = type === "stream" ? "" : `kind: ${JSON.stringify(type)}, `;
    return `__graftLivePage.streams.waitFor({url: ${url}, ${kind}direction: "received"}, 55000)`;
  }
  if (PUSH_TYPES.has(type)) {
    const kind = type === "notifications" ? "" : `, kind: ${JSON.stringify(type)}`;
    return `__graftLivePage.notifications.waitFor({${kind.slice(2)}}, 55000)`;
  }
  return `__graftLivePage.waitForResponse(${url}, {${type ? `type: ${JSON.stringify(type)}, ` : ""}timeoutMs: 55000})`;
}

/**
 * The browser code run for one live check. It attaches to an existing tab (never opens one), waits
 * for the next matching response, and evaluates the routine's own check with `response` in scope.
 * Placing the check last makes its value the cell's value, so met/skipped/failed behave as they do
 * for a timer check. Top-level bindings stay in the routine's realm across responses.
 */
export function liveCheckCode(check: string, listen: RoutineListen, sites: string[]): string {
  const hosts = JSON.stringify(sites.map(siteHost).filter(Boolean));
  const tabTest = sites.length
    ? `var h = ''; try { h = new URL(u).hostname.toLowerCase().replace(/^www\\./, ''); } catch (e) {}
     return ${hosts}.some(function(s){ return h === s || h.endsWith('.' + s); });`
    : `return u.includes(${JSON.stringify(listen.url)});`;
  // Names are prefixed so they cannot shadow the engine's internal realm globals (e.g. __tabs).
  return `var __graftLiveTabs = await browser.tabs();
var __graftLiveTab = __graftLiveTabs.find(function(t){ var u = String(t.url || ''); ${tabTest} });
if (!__graftLiveTab) return {__liveIdle: true};
var __graftLivePage = await browser.tab(__graftLiveTab.id ?? __graftLiveTab.tabId ?? __graftLiveTab);
var __graftLiveFound = await ${liveWaitCode(listen)};
if (!__graftLiveFound) return {__liveIdle: true};
var response = __graftLiveFound;
${check}`;
}
