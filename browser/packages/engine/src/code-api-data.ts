// Data helpers for browser_code: calling a site's endpoints from inside its page, the page's
// embedded data and metadata, clean Markdown, session export, fetching without a tab, and a
// pool that works through many URLs in parallel tabs. Evaluated in the sandbox realm.
import { literalLoopback, privateTarget } from "@browserkit/protocol";
import { THROTTLE_PAGE_JS } from "./rate-limit.js";
import * as readers from "./page-readers.js";

/** Origin of a captured URL. An opaque page and an unreadable URL are "null". */
function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "null";
  }
}

/** The page to open again: the one that sent the request, else the request's own origin. */
function replayHome(requestOrigin: string | undefined, sentFrom: string | undefined): string {
  if (sentFrom && sentFrom !== "null") return sentFrom;
  return requestOrigin && requestOrigin !== "null" ? requestOrigin : "";
}

function sentPhrase(
  requestOrigin: string | undefined,
  sentFrom: string | undefined,
  home: string,
): string {
  const opaque = "a page with an opaque origin (such as about:blank)";
  if (sentFrom === "null") return `sent from ${opaque} to ${requestOrigin}`;
  if (sentFrom && requestOrigin && sentFrom !== requestOrigin)
    return `sent from ${sentFrom} to ${requestOrigin}`;
  return `sent from ${home}`;
}

function replayLeft(
  id: string,
  requestOrigin: string | undefined,
  sentFrom: string | undefined,
  tab: string,
): string {
  const opaque = "a page with an opaque origin (such as about:blank)";
  const home = replayHome(requestOrigin, sentFrom);
  const here = tab === "null" ? opaque : tab;
  const go = home ? (home.endsWith("/") ? home : `${home}/`) : "";
  const next = go
    ? `\nNext: await page.goto(${JSON.stringify(go)})`
    : "\nNext: await page.network.list()";
  const where = home ? `go ${home} first` : "open the page that sent it first";
  const from = sentPhrase(requestOrigin, sentFrom, home || "an unknown page");
  return `REPLAY_ORIGIN: ${id} was ${from}, the tab is on ${here}; ${where}${next}`;
}

/**
 * Why page.replay must not send, or undefined when this tab can.
 * Allowed: the tab is on the request's origin, or still on the page that sent it.
 * Anything else is refused before fetch. The functions are copied into the sandbox.
 */
export function replayOriginRefusal(
  id: string,
  requestUrl: string,
  sentFromUrl: string | undefined,
  tabOrigin: string,
): string | undefined {
  const requestOrigin = requestUrl ? originOf(requestUrl) : undefined;
  const tab = tabOrigin || "null";
  const sentFrom = sentFromUrl ? originOf(sentFromUrl) : undefined;
  if (samePage(tab, requestOrigin)) return undefined;
  if (sentFrom && sentFrom !== "null" && tab === sentFrom) return undefined;
  return replayLeft(id, requestOrigin, sentFrom, tab);
}

function samePage(tab: string, requestOrigin: string | undefined): boolean {
  return Boolean(
    requestOrigin && requestOrigin !== "null" && tab !== "null" && tab === requestOrigin,
  );
}

/**
 * changes.url may only change the path and query of the recorded request. Another origin, a
 * downgrade, or a private or mapped address is refused before fetch. Same-origin loopback
 * (a dev site replaying itself) stays allowed.
 */
export function replayUrlRefusal(
  id: string,
  nextUrl: string,
  recordedUrl: string,
): string | undefined {
  let next: URL;
  let recorded: URL;
  try {
    next = new URL(nextUrl);
    recorded = new URL(recordedUrl);
  } catch {
    return `REPLAY_ORIGIN: ${id} has a URL that is not an address; the request was not sent`;
  }
  if (next.origin === recorded.origin && literalLoopback(next.hostname)) return undefined;
  const blocked = privateTarget(next.href);
  if (!blocked && next.origin === recorded.origin) return undefined;
  const why = blocked ?? `another origin ${next.origin}`;
  const home = `${recorded.origin}/`;
  return (
    `REPLAY_ORIGIN: ${id} would leave ${recorded.origin} for ${next.href} (${why}); the request was not sent` +
    `\nNext: await page.goto(${JSON.stringify(home)})`
  );
}

/** Browser-owned headers are always dropped. Secret headers are dropped once the hop leaves the origin. */
export function replayHeaders(
  headers: Record<string, string>,
  crossSite: boolean,
): Record<string, string> {
  const browser =
    /^(?::|host$|connection$|content-length$|cookie$|origin$|referer$|accept-encoding$|keep-alive$|transfer-encoding$|te$|upgrade$|via$|proxy-|sec-|priority$)/i;
  const secret =
    /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token)$|token|secret|session|password|signature/i;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (browser.test(name)) continue;
    if (crossSite && secret.test(name)) continue;
    kept[name] = value;
  }
  return kept;
}

export const browserDataApi = `
${originOf.toString()}
${replayHome.toString()}
${sentPhrase.toString()}
${replayLeft.toString()}
${samePage.toString()}
${replayOriginRefusal.toString()}
${replayHeaders.toString()}
${THROTTLE_PAGE_JS}

${readers.__pageRequest.toString()}

${readers.__readMetadata.toString()}

// Runs in the page, so the metadata reader is passed in rather than referenced.
${readers.__readPageData.toString()}

// HTML to Markdown, in the page: headings, paragraphs, lists, links, emphasis, code, quotes,
// images and tables. With mainOnly, navigation, headers, footers and asides are skipped. The
// result says when it saw less than the page holds (a feed or replies outside the area, a cut).
${readers.__readMarkdown.toString()}

// Puts "Show more", "Show replies", "Read more" and the like back into view, inside the main
// content only, at most ten times. It never clicks a control that posts, follows, likes, buys or
// navigates: only buttons whose whole label is one of these expansions.
${readers.__expandRead.toString()}

// Waits for the main content to settle: the text stops growing and no new resources arrive for
// two ticks after the page has had its first 1.5s, capped at five seconds. Called only by page.read.
${readers.__waitRead.toString()}


function __extendPageData(target, base) {
  var inspect = (fn, arg) => base.inspect('(' + fn.toString() + ')(' + JSON.stringify(arg ?? {}) + ')');
  var readElement = base.read;
  return Object.assign(base, {
    // A request made by the page itself: its cookies, its origin, its CSRF token (csrf: true).
    request: (url, init = {}) => inspect(__pageRequest, typeof url === 'object' ? url : {...init, url}),
    // Re-sends a recorded request (page.network.list) from the page, with optional changes.
    replay: async (id, changes = {}) => {
      var entry = await __call({network: 'get', target, id});
      var url = new URL(changes.url || entry.url);
      for (var [key, value] of Object.entries(changes.query || {})) url.searchParams.set(key, String(value));
      var blocked = await __call({network: 'guard', target, id: String(id), url: url.href, recorded: entry.url});
      if (blocked) throw Error(blocked);
      var crossSite = new URL(entry.url).origin !== url.origin;
      var headers = replayHeaders(entry.requestHeaders || {}, crossSite);
      Object.assign(headers, changes.headers || {});
      var request = {url: url.href, method: changes.method || entry.method, headers,
        credentials: crossSite ? 'omit' : 'include', redirect: 'manual'};
      if (changes.json !== undefined) {
        // No merge with the recording: an omitted field must not be silently replayed.
        request.json = changes.json;
      } else if (changes.body !== undefined) request.body = changes.body;
      else if (entry.requestBody !== undefined && !/^(GET|HEAD)$/i.test(request.method || 'GET')) request.body = entry.requestBody;
      // Fail before fetch: a tab that has left the sending page would lose cookies or be blocked.
      var tabOrigin = await base.inspect('location.origin');
      var refusal = replayOriginRefusal(String(id), url.href, entry.documentURL, tabOrigin == null ? 'null' : String(tabOrigin));
      if (refusal) throw Error(refusal);
      var sent = await inspect(__pageRequest, request);
      if (sent && (sent.type === 'opaqueredirect' || (sent.status >= 300 && sent.status < 400)))
        sent.note = 'The response was a redirect and was not followed, so nothing was sent to a second URL. Next: await page.network.list() or read the page.';
      return sent;
    },
    data: async (options = {}) => {
      if (typeof options === 'string') return __harvestRows(target, options);
      __noteRead(target);
      return base.inspect('(' + __readPageData.toString() + ')(' + __readMetadata.toString() + ', ' + JSON.stringify(options) + ')');
    },
    metadata: () => base.inspect('(' + __readMetadata.toString() + ')()'),
    markdown: async (options = {}) => {
      __noteRead(target);
      var result = await inspect(__readMarkdown, options);
      return result.partial
        ? result.markdown + '\\n\\n[PARTIAL: ' + (result.notes.join('; ') || 'read cut') + ']'
        : result.markdown;
    },
    // One read of the page (code-api-read.ts). A selector still reads one element.
    read: async (options = {}, settings = {}) =>
      typeof options === 'string' ? readElement(options, settings) : __pageRead(base, target, options),
    status: async () => {
      var status = await base.inspect(() => performance.getEntriesByType('navigation')[0]?.responseStatus ?? null);
      return status === null || status === undefined || status === '' ? null : Number(status);
    },
    // The page's session: every cookie (HttpOnly too) and its web storage.
    session: async (options = {}) => {
      var result = {url: await base.inspect(() => location.href)};
      if (options.cookies !== false) result.cookies = (await base.cdp('Network.getCookies', {urls: [result.url]})).cookies;
      if (options.storage !== false) Object.assign(result, await base.inspect(() => ({
        localStorage: Object.fromEntries(Object.entries(localStorage)),
        sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
      })));
      return result;
    },
  });
}

var __sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Works through many URLs (or items with a url) in parallel tabs, reusing each tab. Retries
// failures, backs off when a site answers 429 or 503, and spaces requests to the same host.
async function __pool(items, worker, options = {}) {
  var concurrency = Math.min(Math.max(Number(options.concurrency ?? 4), 1), 10);
  var retries = Math.max(Number(options.retries ?? 2), 0);
  var spacing = Math.max(Number(options.perHostDelayMs ?? 0), 0);
  var queue = items.map((item, index) => ({item, index, attempts: 0}));
  var results = new Array(items.length), lastHit = new Map(), backoff = new Map();
  var urlOf = (item) => typeof item === 'string' ? item : item && item.url;
  async function wait(host) {
    var until = Math.max((lastHit.get(host) ?? 0) + spacing, backoff.get(host) ?? 0);
    lastHit.set(host, Math.max(Date.now(), until));
    if (until > Date.now()) await __sleep(until - Date.now());
  }
  // The runner's tab is stored on 'tab' as soon as it exists, so a failure never leaks it.
  function dropTab(tab) {
    var dead = tab.page;
    tab.page = undefined;
    if (dead && dead.close) dead.close().catch(() => {});
  }
  async function attempt(job, tab) {
    var url = urlOf(job.item);
    try {
      if (url) {
        await wait(new URL(url).host);
        if (tab.page) await tab.page.goto(url, {present: false});
        else if (options.turbo) {
          tab.page = await browser.openTab('about:blank', {new: true, present: false, background: true});
          await tab.page.turbo(options.turbo === true ? {} : options.turbo);
          await tab.page.goto(url, {present: false});
        } else tab.page = await browser.openTab(url, {new: true, present: false, background: true});
        var status = await tab.page.status().catch(() => null);
        if (status === 429 || status === 503) {
          var host = new URL(url).host;
          backoff.set(host, Date.now() + Math.min(60000, 2000 * 2 ** job.attempts));
          throw Object.assign(Error('HTTP ' + status + ' from ' + host), {retryable: true});
        }
      } else if (!tab.page) throw Error('Each item needs a url (or be one)');
      return await worker(tab.page, job.item, job.index);
    } catch (error) {
      var message = String(error && error.message || error);
      if (/TARGET_LOST|about:blank|TAB_DEAD/.test(message)) dropTab(tab);
      throw error;
    }
  }
  async function runner() {
    var tab = {};
    try {
      while (queue.length) {
        var job = queue.shift();
        try {
          results[job.index] = {ok: true, item: job.item, value: await attempt(job, tab)};
        } catch (error) {
          if (job.attempts++ < retries) { queue.push(job); continue; }
          results[job.index] = {ok: false, item: job.item, error: String(error && error.message || error)};
        }
        globalThis.__partialValue = results.slice();
        if (options.onProgress) options.onProgress(results.filter(Boolean).length, items.length);
      }
    } finally {
      if (tab.page && options.keepTabs !== true) await tab.page.close().catch(() => {});
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, runner));
  return results;
}
`;
