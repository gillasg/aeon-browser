// page.read(): one read of the page. Data, the main repeated list, Markdown, the panels that
// scroll on their own and the text of embedded frames, merged and capped. A plain page costs one
// page call: expand, settle, Markdown, title, URL, data and a probe run together, and the probe
// says whether a list, scroll panels, a feed or frames are there to read at all. Evaluated in the
// sandbox realm.
import * as readers from "./page-readers.js";

export const browserReadApi = `
${readers.__readProbe.toString()}
${readers.__readWindowScroll.toString()}
${readers.__readBatch.toString()}

// A note is one line for the agent: a page-side stack trace (" at __listStep (...)") is cut off.
function __cleanNote(note) {
  return String(note).replace(/\\s+at\\s+(?:[\\w$.<>]+\\s+\\(|<anonymous>|\\S+:\\d+:\\d+)[\\s\\S]*$/, '').trim();
}

// Page source without indentation or comment lines: the batch must fit one evaluate (20,000
// characters). Line breaks stay, so no statement joins another.
function __compact(fn) {
  var nl = String.fromCharCode(10);
  return fn.toString().split(nl).map((line) => line.trim()).filter((line) => line && !line.startsWith('//')).join(nl);
}

async function __readBatchCall(base, options, max, skipWait, waitMs) {
  var fns = '{expand: ' + __compact(__expandRead) + ', wait: ' + __compact(__waitRead) +
    ', markdown: ' + __compact(__readMarkdown) + ', data: ' + __compact(__readPageData) +
    ', metadata: ' + __compact(__readMetadata) + ', probe: ' + __compact(__readProbe) + '}';
  var args = {expand: options.expand, maxClicks: options.maxClicks, skipWait, waitMs,
    markdown: {...options, max}, data: {...options, summary: options.summary === true}};
  return base.inspect('(' + __compact(__readBatch) + ')(' + fns + ', ' + JSON.stringify(args) + ')');
}

// The repeated list (inner scroller) and an infinite feed (the window) each get 40% of what is
// left, so a long virtual list can no longer starve the feed.
async function __readMore(base, options, probe, deadline) {
  var share = () => Math.floor(Math.max(0, deadline - Date.now()) * 0.4);
  var list = null, listNote, feed = null;
  if (probe.rows >= 3 || options.list) {
    try {
      if (share() < 300) throw Error('time budget spent');
      list = await __collectList(base, options.list || null, {
        max: Math.min(2000, Number(options.maxItems) || 1000),
        ...(options.maxScrolls ? {maxScrolls: options.maxScrolls} : {}),
        deadline: Date.now() + share(),
      });
    } catch (error) {
      listNote = 'no repeated list: ' + __cleanNote(String(error && error.message || error)).slice(0, 200);
    }
  }
  // A feed loads its next page on a window scroll event, even before the page is long enough to
  // scroll; repeated rows are the sign one may be there.
  if (probe.rows >= 3 && options.feed !== false && share() >= 300)
    feed = await base.inspect('(' + __readWindowScroll.toString() + ')(' + JSON.stringify({budgetMs: share()}) + ')').catch(() => null);
  return {list, listNote, feed};
}

async function __pageRead(base, target, options) {
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
  var waitMs = Math.min(options.waitMs ?? 5000, Math.max(0, deadline - Date.now()));
  var batch = await __readBatchCall(base, options, max, false, waitMs);
  var more = await __readMore(base, options, batch.probe, deadline);
  // The feed grew: its new items are in the page now, so read the Markdown again.
  if (more.feed && more.feed.rounds > 1)
    batch = {...batch, ...(await __readBatchCall(base, {...options, expand: false}, max, true, 0).then(({expand, wait, ...rest}) => rest))};
  return __readFinish(base, target, options, {batch, more, max, deadline, timedOut, readKey});
}

// A short page (an old portal laid out with tables or frames) has little but its menus and side
// text, so dropping "boilerplate" leaves almost nothing. When the main-content read kept under
// half of a short page's visible text, read the whole page instead.
async function __keepShortPage(base, options, batch, max, timedOut) {
  if (options.selector || options.mainOnly !== undefined || timedOut()) return null;
  var bodyChars = Number(batch.probe && batch.probe.bodyChars) || 0;
  var kept = String(batch.markdown.markdown || '').replace(/\\]\\([^)]*\\)/g, ']').replace(/\\s+/g, ' ').trim().length;
  if (bodyChars < 80 || bodyChars > 4000 || kept >= bodyChars * 0.5) return null;
  var whole = await base.inspect('(' + __compact(__readMarkdown) + ')(' + JSON.stringify({...options, max, mainOnly: false}) + ')').catch(() => null);
  var wholeText = whole && String(whole.markdown || '').replace(/\\]\\([^)]*\\)/g, ']').replace(/\\s+/g, ' ').trim();
  return wholeText && wholeText.length > kept + 40 ? whole : null;
}

async function __readFinish(base, target, options, run) {
  var {batch, more, max, deadline, timedOut, readKey} = run;
  var markdown = batch.markdown, fallbackNote;
  var whole = await __keepShortPage(base, options, batch, max, timedOut);
  if (whole) { markdown = whole; fallbackNote = 'short page: kept its navigation and side text'; }
  var mdBody = String(markdown.markdown || '').replace(/^#\\s+.*$/m, '').replace(/\\s+/g, ' ').trim();
  // Near-empty Markdown on a page with more text: fall back to the accessibility summary.
  if (mdBody.length < 40 && batch.probe.bodyChars > mdBody.length + 40 && !timedOut()) {
    var axState = await (base.summary || base.state)().catch(() => '');
    var axText = typeof axState === 'string' ? axState.trim() : '';
    if (axText.length > Math.max(40, String(markdown.markdown || '').trim().length)) {
      markdown = {...markdown, markdown: axText.slice(0, max), chars: Math.min(axText.length, max)};
      fallbackNote = 'markdown was near empty; fell back to accessibility text';
    }
  }
  var throttled = __throttlePage(batch.title, String(markdown.markdown || ''));
  if (throttled) throw Error(throttled);
  // The one scroll panel a complete list was collected from is already read.
  var listPanel = more.list && more.list.complete && more.list.scroller === 'inner' ? 1 : 0;
  var scrollers = options.scrollers === false || timedOut() || batch.probe.scrollers <= listPanel
    ? []
    : await __readScrollers(base, {deadline, maxChars: Math.floor(max / 2)}).catch(() => []);
  var embedded = await __readEmbeddedText(target, batch.probe, {deadline, maxChars: Math.floor(max / 4), frames: options.frames !== false});
  // A panel whose text did not grow while scrolling is already in the Markdown.
  var panels = scrollers.filter((panel) => panel.grew).map(({grew, height, view, ...panel}) => panel);
  var waited = batch.wait, list = more.list;
  var notes = [
    ...(batch.expand.clicked.length ? ['expanded ' + batch.expand.clicked.length + ' control(s): ' + batch.expand.clicked.join(', ')] : []),
    ...(fallbackNote ? [fallbackNote] : []),
    ...(markdown.notes || []),
    ...((batch.data && batch.data.notes) || []),
    ...(waited.note ? [waited.note] : []),
    ...(more.listNote ? [more.listNote] : []),
    ...(more.feed && !more.feed.complete ? ['the feed was still loading more when the time budget ran out'] : []),
  ].map(__cleanNote);
  var partial = !!(markdown.partial || (batch.data && batch.data.partial) || (list && list.partial) || waited.partial || panels.some((panel) => !panel.complete) || (more.feed && !more.feed.complete));
  var result = {
    url: batch.url,
    title: batch.title,
    data: batch.data,
    list: __cleanListLinks(list),
    markdown: typeof __cleanMarkdownLinks === 'function' ? __cleanMarkdownLinks(String(markdown.markdown || '')) : markdown.markdown,
    ...(panels.length ? {scrollers: panels} : {}),
    ...(embedded.length ? {embedded} : {}),
    wait: waited,
    expand: batch.expand,
    partial,
    notes,
  };
  await __readCap(result, max);
  var guard = await __call({guard: {kind: 'read', text: String(result.markdown || '').slice(0, 4000), title: String(result.title || ''), count: result.list && result.list.items ? result.list.items.length : 0, shown: result.list && result.list.count != null ? result.list.count : (result.list && result.list.items ? result.list.items.length : undefined), total: result.list ? result.list.total : undefined}}).catch(function () { return null; });
  if (guard && guard.rateLimited) throw Error(String(guard.rateLimited));
  if (guard && guard.contradiction) result.contradiction = guard.contradiction;
  if (guard && guard.location) result.location = guard.location;
  if (guard && guard.partial && result.list) {
    result.list.partial = true;
    if (guard.total != null) result.list.total = guard.total;
  }
  // text is the page text a check can match: the Markdown, then each frame's text under its name.
  var frames = (result.embedded || []).filter((entry) => entry.kind === 'frame');
  result.text = [String(result.markdown || ''), ...frames.map((frame) => '[frame: ' + frame.name + ']\\n' + frame.text)].join('\\n\\n');
  if (timedOut()) { result.partial = true; result.notes.push('time budget spent'); }
  (globalThis.__lastReads || (globalThis.__lastReads = new Map())).set(readKey, result);
  return result;
}

// Ad trackers and tracking parameters on the list's links, cut the way page.glance() cuts them.
function __cleanListLinks(list) {
  if (!list || !Array.isArray(list.items) || typeof __cleanLinkUrl !== 'function') return list;
  var clean = (item) => {
    if (!item || typeof item !== 'object') return item;
    var out = {...item};
    for (var key of Object.keys(out))
      if (typeof out[key] === 'string' && /^https?:[/][/]/.test(out[key])) out[key] = __cleanLinkUrl(out[key]);
    return out;
  };
  return {...list, items: list.items.map(clean)};
}

// Keeps a read under max characters; the full read goes to an artifact first, indented so grep
// and a line reader can work through it.
async function __readCap(result, max) {
  var serialized = JSON.stringify(result);
  if (serialized.length <= max) return;
  var saved = 'page-read-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  var file = await artifact(saved, JSON.stringify(result, null, 2)).catch(() => null);
  var where = (file && file.path) || saved;
  result.partial = true;
  result.artifact = where;
  result.notes.push('the full read (' + serialized.length + ' characters) is saved as ' + where);
  result.data = {partial: true, note: 'data omitted here; the full read is saved as ' + where};
  result.markdown = result.markdown.slice(0, Math.max(500, Math.floor(max * 0.6))) + '\\n\\n[PARTIAL: cut to ' + max + ' characters; full read saved as ' + where + ']';
  if (result.list) result.list = {...result.list, items: result.list.items.slice(0, 30), partial: true, note: 'list cut to 30 items; full read saved as ' + where};
  if (JSON.stringify(result).length <= max) return;
  var skeleton = {...result, markdown: '', list: null, data: null, scrollers: undefined, embedded: undefined};
  var room = Math.max(0, max - JSON.stringify(skeleton).length - 250);
  result.markdown = result.markdown.slice(0, room);
  result.list = null;
  delete result.scrollers;
  delete result.embedded;
  result.data = {partial: true, note: 'omitted to keep the read under ' + max + ' characters'};
  result.notes.push('list and data omitted to keep the read under ' + max + ' characters');
}

// What the Markdown cannot see: open shadow roots (from the probe) and the text of the page's
// frames, same-origin or not, nested too. Empty and tiny ones (ads, trackers) are left out.
async function __readEmbeddedText(target, probe, options) {
  var out = [], room = options.maxChars, nl = String.fromCharCode(10);
  var take = (entry) => {
    var text = String(entry.text || '').replace(/[ \\t]+/g, ' ').trim();
    // Frames under a dozen characters are ads and trackers; a component's label can be short.
    if (text.length < (entry.kind === 'frame' ? 12 : 3) || room <= 0) return;
    var cut = text.slice(0, Math.min(room, 8000));
    room -= cut.length;
    out.push({...entry, text: cut, ...(cut.length < text.length ? {partial: true} : {})});
  };
  (probe.shadows || []).forEach(take);
  if (!options.frames || !probe.frames || Date.now() > options.deadline - 3000) return out;
  var frames = ((await __step({op: 'frames', target, action: 'list'}).catch(() => ({data: []}))).data || []).slice(1, 16);
  var texts = await Promise.all(frames.map((frame) => __step({op: 'frames', target, action: 'evaluate', frameId: frame.frameId, frameKey: frame.frameKey,
    expression: 'JSON.stringify({title: document.title, text: (document.body && document.body.innerText) || ""})'})
    .then((r) => JSON.parse(String(r.data || '{}'))).catch(() => ({}))));
  frames.forEach((frame, index) => {
    var got = texts[index] || {};
    var origin = (() => { try { return new URL(frame.url).origin; } catch { return frame.name || frame.frameId; } })();
    take({kind: 'frame', where: frame.url || frame.name || frame.frameId, name: String(got.title || '').trim() || origin,
      text: String(got.text || '').split(nl).filter(Boolean).join(nl)});
  });
  return out;
}
`;
