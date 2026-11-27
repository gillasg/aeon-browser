// page.graft, browser.join, site.pipe, page.cache.read, page.download.parse, page.feed.collect
// and page.editor in the sandbox. Evaluated after every other part (it wraps site and browser).
// The pure halves live in native-browser-*.ts and are embedded here by source, so the tests run
// the same code. Nothing here touches a page until one of them is called.
import {
  joinDelta,
  joinKeyText,
  joinKeys,
  joinRows,
  joinSelect,
  pipeTransform,
  pipeViewTarget,
} from "./native-browser-join.js";
import {
  confineFilePath,
  detectFileFormat,
  htmlTables,
  parseDelimited,
  parseFileText,
  rowsToObjects,
  typedCell,
} from "./native-browser-file-parse.js";
import { cacheRead, editorDetect, feedStep } from "./native-browser-feed-editor.js";
import {
  GRAFT_PREFIX,
  HOST,
  graftBoost,
  graftCovers,
  graftHash,
  graftId,
  graftLive,
  graftMatch,
  isGraft,
} from "./native-browser-graft.js";

const embedded = [
  joinKeys,
  joinKeyText,
  joinRows,
  joinSelect,
  joinDelta,
  pipeTransform,
  pipeViewTarget,
  confineFilePath,
  detectFileFormat,
  parseDelimited,
  typedCell,
  rowsToObjects,
  htmlTables,
  parseFileText,
  graftMatch,
  graftId,
  graftBoost,
  graftHash,
  graftCovers,
  isGraft,
];

const HELP = {
  graft:
    "page.graft.apply({id?, match?: 'example.com' | '*.example.com', css?, js?, data?, widgets?, persist?: true}) puts a live overlay on a site (badges, extra table columns, bulk buttons, data from another site as the frozen `data` constant inside js) and keeps it on every reload with no model call; it is a boost underneath. persist: false applies css to this visit only. page.graft.list({host?}) lists grafts; page.graft.remove(id) takes one off every page.",
  join: "browser.join(left, right, {on: 'id' | ['id', 'userId'] | (row, side) => key, type?: 'inner'|'left'|'right'|'full', select?: [names] | (l, r) => row}) joins rows from any two sources (site.call results, page tables, files); clashing right fields come back as right_<name>. {delta: true} compares an old snapshot (left) with a new one (right): {added, removed, changed: [{key, fields, before, after}], unchanged, summary}.",
  pipe: "site.pipe([{call: ['github.com', 'listIssues', {repo}]}, {filter: {state: 'open'}}, {join: {with: {call: [...]}, on: ['user', 'login'], type: 'left'}}, {dedupe: 'id'}, {sort: {by: 'updated', desc: true}}, {limit: 20}, {to: 'issues.json'}]) runs compiled site ops and transforms (map, filter, pick, flat, join, dedupe, sort, limit) with zero model calls; {from: rows} starts from data, {to: name | fn} saves or hands the rows on; {to: {view: {url, token, title?}}} pushes them to a live viewer on 127.0.0.1 or localhost (never another host). Returns {rows, steps: [{step, rows}], models: 0}.",
  cache:
    "page.cache.read({cacheName?, url?: string | RegExp, contentType?, limit = 50, maxBytes = 200000, body?}) reads the site's Cache Storage (service-worker caches) from disk with no network request: {caches, entries: [{cacheName, url, status, contentType, json | text, truncated}]}. Secrets in bodies are redacted.",
  parse:
    "page.download.parse(target?, {format?, header?, types?, limit?, table?, roots?}) turns a file into rows in memory: CSV, TSV, JSON, NDJSON and HTML tables (XLSX and PDF throw UNSUPPORTED). target is a workspace path, a download from page.downloads.waitFor() (its folder must be in roots), {text, name?}, or nothing for the latest finished download. Paths with .. or outside the roots throw PATH_OUTSIDE_ROOT.",
  feed: "page.feed.collect({container?, item?, key?, extract?, limit = 200, maxScrolls = 60, until?, plateau = 3, waitMs = 350}) scrolls a virtualized feed or list (chat, timeline, issue list) a screen at a time, keeps items as they are drawn, dedupes by id, link or text hash and stops at limit, until(items), maxScrolls or the end: {items, scrolls, exhausted, totalSeen}.",
  editor:
    "page.editor.detect(target?) names the rich editor (monaco, codemirror, prosemirror, lexical, slate, contenteditable, textarea); page.editor.read(target?) returns {text, lines}; page.editor.insert(text, {target?, at?: 'end'|'start'}) and page.editor.replace(text, {target?}) write through the editor's own API or input events, so its state stays in step.",
};

export const browserDemoClawsApi = `
var GRAFT_PREFIX = ${JSON.stringify(GRAFT_PREFIX)}, HOST = ${String(HOST)};
${embedded.map(String).join("\n")}
var __d8Help = ${JSON.stringify(HELP)};
for (var __d8Key of Object.keys(__d8Help)) __helpTopics[__d8Key] = __helpTopics[__d8Key] ? __d8Help[__d8Key] + ' ' + __helpTopics[__d8Key] : __d8Help[__d8Key];
var __d8FeedStep = ${String(feedStep)};
var __d8Editor = ${String(editorDetect)};
var __d8CacheRead = ${String(cacheRead)};
var __d8GraftLive = ${String(graftLive)};
var __d8Wait = (ms) => new Promise((done) => setTimeout(done, ms));
var __D8_SECRET_KEY = /(token|secret|password|passwd|auth|session|cookie|api[_-]?key|credential)/i;
function __d8Scrub(value, depth) {
  depth = depth || 0;
  if (typeof value === 'string') return typeof ringScrub === 'function' ? ringScrub(value) : value;
  if (!value || typeof value !== 'object' || depth > 40) return value;
  if (Array.isArray(value)) return value.map((item) => __d8Scrub(item, depth + 1));
  var out = {};
  for (var name of Object.keys(value)) out[name] = __D8_SECRET_KEY.test(name) && typeof value[name] !== 'object' ? '[redacted]' : __d8Scrub(value[name], depth + 1);
  return out;
}
// page.graft: boosts underneath, so nothing new runs in the page or the worker.
async function __d8PageUrl(base) {
  try { return typeof base.url === 'function' ? await base.url() : await base.inspect(() => location.href); } catch { return ''; }
}
async function __d8GraftApply(base, spec) {
  spec = spec || {};
  var host = graftMatch(spec.match, spec.match ? '' : await __d8PageUrl(base));
  var boost = graftBoost(spec, host);
  if (spec.persist === false) {
    if (boost.js || boost.widgets) throw Error('INVALID_INPUT: a graft with js or widgets must persist; persist: false takes css only');
    await base.inspect(__d8GraftLive, {id: boost.id, css: boost.css});
    return {id: boost.id, host, persisted: false};
  }
  var saved = await browser.boosts.save(boost);
  // Shown now on this page too, not only after a reload, when the graft is for this site.
  if (boost.css && graftCovers(host, await __d8PageUrl(base))) await base.inspect(__d8GraftLive, {id: boost.id, css: boost.css}).catch(() => undefined);
  return Object.assign({id: boost.id, host, persisted: true}, saved && saved.warning ? {warning: saved.warning} : {});
}
async function __d8GraftList(options) {
  var host = options && options.host ? graftMatch(options.host, '') : '';
  var all = await browser.boosts.list(host ? 'https://' + host.replace(/^\\*\\./, '') + '/' : undefined);
  return [].concat(all || []).filter(isGraft).map((boost) => ({id: boost.id, name: boost.name, sites: boost.sites, enabled: boost.enabled !== false, css: __d8GraftHas(boost, 'css'), js: __d8GraftHas(boost, 'js')}));
}
// boosts.list() summarizes a boost as {parts: ['css', 'js', …]}; a full boost carries the fields.
function __d8GraftHas(boost, part) {
  return Array.isArray(boost.parts) ? boost.parts.indexOf(part) >= 0 : Boolean(boost[part]);
}
async function __d8GraftRemove(base, id) {
  var full = graftId(id);
  var removed = await browser.boosts.remove(full).then(() => true, () => false);
  // A css-only graft lives in this visit's DOM: take it off too.
  var live = await base.inspect(__d8GraftLive, {id: full, css: null}).catch(() => ({removed: false}));
  return {id: full, removed: removed || Boolean(live && live.removed)};
}
// page.feed.collect: one page step per screen, deduped here, stopped by limit, until or plateau.
async function __d8FeedCollect(base, options) {
  options = options || {};
  var limit = options.limit ?? 200, maxScrolls = options.maxScrolls ?? 60, plateau = options.plateau ?? 3;
  var keyOf = typeof options.key === 'function' ? options.key : typeof options.key === 'string' ? (item) => item[options.key] : (item) => item.key;
  var items = [], seen = new Set(), totalSeen = 0, still = 0, scrolls = 0, exhausted = false, stopped = '';
  for (; scrolls <= maxScrolls; scrolls++) {
    var step = await base.inspect(__d8FeedStep, {container: options.container, item: options.item, scroll: true, fraction: options.fraction});
    if (!step || step.missing) throw Error('NOT_FOUND: page.feed.collect container ' + JSON.stringify(options.container) + ' is not on the page');
    var added = 0;
    for (var raw of step.items) {
      totalSeen += 1;
      var item = typeof options.extract === 'function' ? options.extract(raw) : raw;
      if (item == null) continue;
      var key = joinKeyText(keyOf(item)) ?? JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key); items.push(item); added += 1;
      if (items.length >= limit) break;
    }
    if (items.length >= limit) { stopped = 'limit'; break; }
    if (typeof options.until === 'function' && options.until(items)) { stopped = 'until'; break; }
    still = !step.moved && added === 0 ? still + 1 : 0;
    if (still >= plateau) { exhausted = true; stopped = 'end'; break; }
    await __d8Wait(options.waitMs ?? 350);
  }
  return {items: items.slice(0, limit), scrolls, exhausted, totalSeen, stopped: stopped || 'maxScrolls'};
}
// page.download.parse: confine, read through the workspace (the host resolves symlinks), parse.
async function __d8Parse(base, target, options) {
  options = options || {};
  if (target && typeof target === 'object' && typeof target.text === 'string')
    return parseFileText(String(target.name || target.filename || 'data'), target.text, options);
  if (target === undefined || target === null) {
    var downloads = await base.downloads.list({});
    var done = [].concat(downloads || []).filter((item) => !item.state || item.state === 'complete');
    target = done[done.length - 1];
    if (!target) throw Error('NOT_FOUND: no finished download to parse; pass a workspace path or {text}');
  }
  var path = typeof target === 'string' ? target : target.path || target.name || target.filename;
  var name = confineFilePath(path, options.roots || []);
  var reply = await __call({workspace: 'read', name});
  var data = reply && reply.data !== undefined ? reply.data : reply;
  if (!data || typeof data.text !== 'string') throw Error('NOT_FOUND: ' + name + ' could not be read as text');
  return Object.assign({path: name}, parseFileText(name, data.text, Object.assign({mime: target && target.mime}, options)));
}
async function __d8Cache(base, options) {
  options = Object.assign({}, options || {});
  if (Object.prototype.toString.call(options.url) === '[object RegExp]') options.url = [options.url.source, options.url.flags];
  var read = await base.inspect(__d8CacheRead, options);
  return read && read.entries ? Object.assign(read, {entries: read.entries.map((entry) => __d8Scrub(entry))}) : read;
}
function __d8EditorCall(base, op, target, text, at) {
  return base.evaluate(__d8Editor, {op, target: target || undefined, text, at});
}
function __extendPageDemoClaws(target, base) {
  var downloads = base.downloads || {}, download = base.download;
  return Object.assign(base, {
    graft: Object.freeze({
      apply: (spec) => __d8GraftApply(base, spec),
      list: (options) => __d8GraftList(options),
      remove: (id) => __d8GraftRemove(base, id),
    }),
    cache: Object.freeze({read: (options) => __d8Cache(base, options)}),
    // page.download(target) still downloads; .parse rides on it.
    download: Object.assign(typeof base.download === 'function' ? (...args) => download(...args) : () => { throw Error('UNSUPPORTED: page.download is not available here'); }, {parse: (file, options) => __d8Parse(base, file, options)}),
    downloads: Object.freeze(Object.assign({}, downloads, {parse: (file, options) => __d8Parse(base, file, options)})),
    feed: Object.freeze({collect: (options) => __d8FeedCollect(base, options)}),
    editor: Object.freeze({
      detect: (where) => __d8EditorCall(base, 'detect', where),
      read: (where) => __d8EditorCall(base, 'read', where),
      insert: (text, options = {}) => __d8EditorCall(base, 'insert', options.target, String(text), options.at),
      replace: (text, options = {}) => __d8EditorCall(base, 'replace', options.target, String(text)),
    }),
  });
}
// site.pipe: sources are compiled site calls or data, every other step is a pure transform.
async function __d8PipeSource(step) {
  if (step.from !== undefined) return typeof step.from === 'function' ? step.from() : step.from;
  var call = Array.isArray(step.call) ? step.call : [step.call.host, step.call.op, step.call.params];
  if (typeof call[0] !== 'string' || typeof call[1] !== 'string') throw Error('INVALID_INPUT: site.pipe call is [host, op, params?]');
  return site.call(call[0], call[1], call[2] || {});
}
async function __d8PipeView(view, rows) {
  var target = pipeViewTarget(view);
  var headers = {'content-type': 'application/json'};
  if (target.token) { headers.authorization = 'Bearer ' + target.token; headers['x-graft-view-token'] = target.token; }
  var response = await fetch(target.url, {method: 'POST', headers, body: JSON.stringify({rows, title: target.title})});
  if (!response.ok) throw Error('UPSTREAM: site.pipe view push answered ' + response.status);
}
async function __d8Pipe(steps, options) {
  if (!Array.isArray(steps) || !steps.length) throw Error('INVALID_INPUT: site.pipe takes a non-empty array of steps: help("pipe")');
  var rows = options && options.input !== undefined ? options.input : [], trace = [];
  for (var step of steps) {
    if (!step || typeof step !== 'object') throw Error('INVALID_INPUT: each site.pipe step is an object');
    var label = Object.keys(step)[0];
    if (step.call || step.from !== undefined) rows = await __d8PipeSource(step);
    else if (step.to !== undefined) {
      if (typeof step.to === 'function') await step.to(rows);
      else if (step.to && typeof step.to === 'object' && step.to.view !== undefined) await __d8PipeView(step.to.view, rows);
      else await artifact(String(step.to), JSON.stringify(rows, null, 2));
    } else {
      if (step.join && step.join.with && !Array.isArray(step.join.with)) step = {join: Object.assign({}, step.join, {with: await __d8PipeSource(step.join.with)})};
      rows = pipeTransform(rows, step, joinRows);
    }
    trace.push({step: label, rows: Array.isArray(rows) ? rows.length : rows == null ? 0 : 1});
  }
  return {rows, steps: trace, models: 0};
}
// The same site.* as before (L2's proxy: site.<ability>(inputs) runs a saved ability), plus pipe.
site = Object.freeze(new Proxy(Object.assign({}, __siteBase, __siteL2, {pipe: __d8Pipe}), {
  get: (own, name) => {
    if (typeof name !== 'string' || name in own) return own[name];
    if (name === 'then' || name === 'toJSON' || name === 'inspect') return undefined;
    return async (inputs = {}, options = {}) => own.run(name, inputs, options);
  },
}));
browser = Object.freeze(Object.assign({}, browser, {join: (left, right, options) => joinRows(left, right, options)}));
`;
