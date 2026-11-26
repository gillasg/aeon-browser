// Passive code and state reads in the sandbox: page.code.bundle(), page.code.sourcemaps() and
// page.state.stores(). None attaches the debugger or changes the page. The bundle and source-map
// parsers run in the daemon (siteMapper requests); the store reader is page code embedded by
// source from native-browser-stores.ts, its result scrubbed (scrubDeep, from the round-3 claws)
// before it leaves the sandbox.
import { storesScript } from "./native-browser-stores.js";

export const browserReApi = `
var __reStoresPrelude = ${JSON.stringify(storesScript({}).replace(/stCollect\(window, document, \{\}\);\}\)\(\)$/, ""))};
async function __reHref(page) {
  try { return String(await page.evaluate(() => location.href)); } catch { return String(page.url); }
}
async function __reObserved(page) {
  var rows = await page.network.list('').catch(() => []);
  var list = Array.isArray(rows) ? rows : (rows && (rows.entries || rows.requests || rows.rows)) || [];
  return list.slice(0, 500).map((row) => ({method: row.method, url: String(row.url || '')})).filter((row) => row.url);
}
async function __reCached(page) {
  var rows = await page.network.list({type: 'javascript'}).catch(() => []);
  var list = Array.isArray(rows) ? rows : (rows && (rows.entries || rows.requests || rows.rows)) || [];
  var cached = {}, total = 0;
  for (var row of list.slice(0, 60)) {
    var body = row.id && await page.network.body(row.id).catch(() => null);
    if (!body || typeof body.text !== 'string' || body.truncated || total + body.text.length > 8000000) continue;
    cached[String(row.url)] = body.text; total += body.text.length;
  }
  return cached;
}
async function __reBundle(target, options = {}) {
  var page = browser.page(target), url = await __reHref(page);
  var observed = await __reObserved(page), cached = await __reCached(page);
  var value = await __call({siteMapper: 'code', url, options: {bundle: true, observed, cached, ...(options.maxFiles ? {maxFiles: options.maxFiles} : {})}});
  var graph = value.bundle || {candidates: [], chunks: [], flags: [], configs: [], queryParams: [], notes: []};
  var kinds = options.kind ? [].concat(options.kind) : null;
  var candidates = graph.candidates.filter((c) => (!kinds || kinds.includes(c.kind)) && (!options.confirmed || c.confirmed));
  return {summary: graph.summary, files: (value.files || []).length, candidates: candidates.slice(0, Math.min(Number(options.max) || 200, 400)),
    chunks: graph.chunks.slice(0, 200), flags: graph.flags, configs: graph.configs, queryParams: graph.queryParams, notes: graph.notes};
}
async function __reScripts(page) {
  var listed = await page.sources().catch(() => ({files: []}));
  return (listed.files || []).filter((file) => /^https?:/i.test(file));
}
async function __reSourcemaps(target, options = {}) {
  var page = browser.page(target), pageUrl = await __reHref(page);
  var files = options.file ? [String(options.file)] : (await __reScripts(page)).slice(0, Math.min(Number(options.maxFiles) || 10, 40));
  var positions = options.positions || (options.line ? [{line: Number(options.line), col: Number(options.col) || 0}] : []);
  var maps = [];
  for (var file of files)
    maps.push(await __call({siteMapper: 'sourcemaps', url: file, options: {pageUrl, positions, ...(options.contentChars ? {contentChars: options.contentChars} : {})}}).catch((error) => ({file, note: String(error && error.message || error)})));
  return {maps, withMaps: maps.filter((m) => m.sources && m.sources.length).length};
}
async function __reOriginal(file, line, col, pageUrl) {
  if (!/^https?:/i.test(String(file || '')) || !line) return undefined;
  var mapped = await __call({siteMapper: 'sourcemaps', url: file, options: {pageUrl, positions: [{line, col: col || 0}]}}).catch(() => null);
  return mapped && mapped.positions && mapped.positions[0] && mapped.positions[0].original;
}
async function __reStores(target, options = {}) {
  var page = browser.page(target);
  var raw = await page.inspect(__reStoresPrelude + 'stCollect(window, document, ' + JSON.stringify(options || {}) + ');})()');
  return scrubDeep(raw || {stores: [], kinds: []});
}
function __extendPageRe(target, base) {
  var state = base.state;
  if (typeof state === 'function') state.stores = (options = {}) => __reStores(target, options);
  base.code = Object.freeze({
    bundle: (options = {}) => __reBundle(target, options),
    sourcemaps: (options = {}) => __reSourcemaps(target, options),
  });
  return base;
}
`;
