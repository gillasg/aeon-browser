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
    // One read of the page: data, the main repeated list, Markdown and the panels that scroll on
    // their own, merged and capped. It expands "show more" controls and waits for the content to
    // settle; both only here. Everything fits a time budget (timeMs), so a huge page returns what
    // it has instead of running into the cell deadline. A selector still reads one element.
    read: async (options = {}, settings = {}) => {
      if (typeof options === 'string') return readElement(options, settings);
      __noteRead(target);
      var readKey = __key(target) + '|' + String((__tabs.get(__key(target)) || {}).url || '');
      var counts = globalThis.__readCounts || (globalThis.__readCounts = new Map());
      var times = (counts.get(readKey) || 0) + 1;
      counts.set(readKey, times);
      if (times > 4) {
        var prior = (globalThis.__lastReads && globalThis.__lastReads.get(readKey)) || {markdown: '', text: ''};
        return {...prior, partial: true, loop: true, notes: [...(prior.notes || []), 'stopped: this page was read ' + times + ' times in one cell without a new navigation']};
      }
      var budget = Number(options.timeMs);
      var deadline = Date.now() + Math.max(500, budget > 0 ? budget : 30000);
      var timedOut = () => Date.now() > deadline;
      var max = Math.max(2000, Math.min(200000, Number(options.max) || 40000));
      var expanded = options.expand === false || timedOut()
        ? {clicked: [], skipped: []}
        : await inspect(__expandRead, {max: options.maxClicks ?? 10}).catch(() => ({clicked: [], skipped: []}));
      var waited = timedOut()
        ? {settled: false, partial: true, note: 'time budget spent'}
        : await inspect(__waitRead, {maxMs: Math.min(options.waitMs ?? 5000, Math.max(0, deadline - Date.now()))}).catch(() => ({settled: false, partial: true, note: 'the settle wait failed'}));
      var markdown = await inspect(__readMarkdown, {...options, max});
      var pageTitle = await base.inspect(() => document.title);
      var mdBody = String(markdown.markdown || '')
        .replace(/^#\\s+.*$/m, '')
        .replace(/\\s+/g, ' ')
        .trim();
      var fallbackNote;
      if (mdBody.length < 40 && !timedOut()) {
        var axState = await base.state().catch(() => '');
        var axText = typeof axState === 'string' ? axState.trim() : '';
        if (axText.length > Math.max(40, String(markdown.markdown || '').trim().length)) {
          markdown = {
            ...markdown,
            markdown: axText.slice(0, max),
            chars: Math.min(axText.length, max),
          };
          fallbackNote = 'markdown was near empty; fell back to accessibility text';
        }
      }
      var throttled = __throttlePage(pageTitle, String(markdown.markdown || ''));
      if (throttled) throw Error(throttled);
      var data = await base.inspect(
        '(' + __readPageData.toString() + ')(' + __readMetadata.toString() + ', ' + JSON.stringify({...options, summary: options.summary === true}) + ')'
      );
      var list = null, listNote;
      try {
        if (timedOut()) throw Error('time budget spent');
        list = await __collectList(base, options.list || null, {
          max: Math.min(500, Number(options.maxItems) || 200),
          ...(options.maxScrolls ? {maxScrolls: options.maxScrolls} : {}),
          deadline: Math.min(deadline - 8000, Date.now() + 12000),
        });
      } catch (error) {
        listNote = 'no repeated list: ' + String(error && error.message || error).slice(0, 200);
      }
      var scrollers = options.scrollers === false || timedOut()
        ? []
        : await __readScrollers(base, {deadline, maxChars: Math.floor(max / 2)}).catch(() => []);
      var embedded = options.frames === false || timedOut()
        ? []
        : await __readEmbedded(base, target, {deadline, maxChars: Math.floor(max / 4)}).catch(() => []);
      // A panel whose text did not grow while scrolling is already in the Markdown.
      var panels = scrollers.filter((panel) => panel.grew).map(({grew, height, view, ...panel}) => panel);
      var notes = [
        ...(expanded.clicked.length ? ['expanded ' + expanded.clicked.length + ' control(s): ' + expanded.clicked.join(', ')] : []),
        ...(fallbackNote ? [fallbackNote] : []),
        ...(markdown.notes || []),
        ...((data && data.notes) || []),
        ...(waited.note ? [waited.note] : []),
        ...(listNote ? [listNote] : []),
      ];
      var partial = !!(markdown.partial || (data && data.partial) || (list && list.partial) || waited.partial || panels.some((panel) => !panel.complete));
      var result = {
        url: await base.inspect(() => location.href),
        title: pageTitle,
        data,
        list,
        markdown: markdown.markdown,
        ...(panels.length ? {scrollers: panels} : {}),
        ...(embedded.length ? {embedded} : {}),
        wait: waited,
        expand: expanded,
        partial,
        notes,
      };
      var serialized = JSON.stringify(result);
      if (serialized.length > max) {
        var saved = 'page-read-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        var file = await artifact(saved, serialized).catch(() => null);
        var where = (file && file.path) || saved;
        result.partial = true;
        result.artifact = where;
        result.notes.push('the full read (' + serialized.length + ' characters) is saved as ' + where);
        result.data = {partial: true, note: 'data omitted here; the full read is saved as ' + where};
        result.markdown = result.markdown.slice(0, Math.max(500, Math.floor(max * 0.6))) + '\\n\\n[PARTIAL: cut to ' + max + ' characters; full read saved as ' + where + ']';
        if (result.list) result.list = {...result.list, items: result.list.items.slice(0, 30), partial: true, note: 'list cut to 30 items; full read saved as ' + where};
        serialized = JSON.stringify(result);
        if (serialized.length > max) {
          var skeleton = {...result, markdown: '', list: null, data: null, scrollers: undefined, embedded: undefined};
          var room = Math.max(0, max - JSON.stringify(skeleton).length - 250);
          result.markdown = result.markdown.slice(0, room);
          result.list = null;
          delete result.scrollers;
          delete result.embedded;
          result.data = {partial: true, note: 'omitted to keep the read under ' + max + ' characters'};
          result.notes.push('list and data omitted to keep the read under ' + max + ' characters');
        }
      }
      var guard = await __call({guard: {kind: 'read', text: String(result.markdown || '').slice(0, 4000), title: String(result.title || ''), count: result.list && result.list.items ? result.list.items.length : 0, shown: result.list && result.list.count != null ? result.list.count : (result.list && result.list.items ? result.list.items.length : undefined), total: result.list ? result.list.total : undefined}}).catch(function () { return null; });
      if (guard && guard.rateLimited) throw Error(String(guard.rateLimited));
      if (guard && guard.contradiction) result.contradiction = guard.contradiction;
      if (guard && guard.location) result.location = guard.location;
      if (guard && guard.partial && result.list) {
        result.list.partial = true;
        if (guard.total != null) result.list.total = guard.total;
      }
      // text is the page text (the same string as markdown) so a check can match it.
      // data, list, markdown and the rest stay.
      result.text = String(result.markdown || '');
      if (timedOut()) { result.partial = true; result.notes.push('time budget spent'); }
      (globalThis.__lastReads || (globalThis.__lastReads = new Map())).set(readKey, result);
      return result;
    },
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

// What the Markdown cannot see: the text of the page's frames (same-origin or not, nested too)
// and of open shadow roots (web components). Empty and tiny ones (ads, trackers) are left out.
async function __readEmbedded(base, target, options) {
  var out = [], room = options.maxChars, nl = String.fromCharCode(10);
  var take = (entry) => {
    var text = String(entry.text || '').replace(/[ \\t]+/g, ' ').trim();
    // Frames under a dozen characters are ads and trackers; a component's label can be short.
    if (text.length < (entry.kind === 'frame' ? 12 : 3) || room <= 0) return;
    var cut = text.slice(0, Math.min(room, 8000));
    room -= cut.length;
    out.push({...entry, text: cut, ...(cut.length < text.length ? {partial: true} : {})});
  };
  var shadows = await base.inspect(() => {
    var found = [];
    var walk = (root) => {
      for (var el of root.querySelectorAll('*')) {
        if (!el.shadowRoot) continue;
        var text = Array.from(el.shadowRoot.children).map((child) => child.innerText || '').join(String.fromCharCode(10)).trim();
        if (text) found.push({kind: 'shadow', where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), text});
        walk(el.shadowRoot);
      }
    };
    walk(document);
    return found.slice(0, 30);
  }).catch(() => []);
  shadows.forEach(take);
  var frames = ((await __step({op: 'frames', target, action: 'list'}).catch(() => ({data: []}))).data || []).slice(1, 16);
  for (var frame of frames) {
    if (Date.now() > options.deadline - 3000 || room <= 0) break;
    var text = await __step({op: 'frames', target, action: 'evaluate', frameId: frame.frameId, frameKey: frame.frameKey,
      expression: '(document.body && document.body.innerText) || ""'}).then((r) => r.data).catch(() => '');
    take({kind: 'frame', where: frame.url || frame.name || frame.frameId, text: String(text || '').split(nl).filter(Boolean).join(nl)});
  }
  return out;
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
          tab.page = await browser.openTab('about:blank', {new: true, present: false});
          await tab.page.turbo(options.turbo === true ? {} : options.turbo);
          await tab.page.goto(url, {present: false});
        } else tab.page = await browser.openTab(url, {new: true, present: false});
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
