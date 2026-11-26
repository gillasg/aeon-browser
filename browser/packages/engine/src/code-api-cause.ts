// page.cause(action, opts?) in the sandbox: runs one action and reports what it caused — the new
// api and GraphQL requests diffed against their earlier calls, stream frames, the URL, store keys
// and DOM changes, with trackers and other noise counted apart. The pure parts live in
// native-browser-cause.ts and are embedded here by source, so the tests run the same code.
import {
  causeBody,
  causeClass,
  causeDiffKeys,
  causeDiffRequests,
  causeDiffStores,
  causeGqlOf,
  causeKey,
  causeQuery,
  causeSliceFrames,
  causeValue,
} from "./native-browser-cause.js";

const embedded = [
  causeClass,
  causeKey,
  causeQuery,
  causeBody,
  causeValue,
  causeDiffKeys,
  causeGqlOf,
  causeDiffRequests,
  causeDiffStores,
  causeSliceFrames,
];

const help = {
  cause:
    "page.cause(action, {settleMs = 1500, stores = true, dom = true}) runs action() and says what it caused: {requests: [{id, kind: 'api'|'graphql', method, url, op?, diff?: {query?, variables?, body?}, status}], frames: [{stream, direction, sample}], url: {before, after}, stores: [{kind, path, before, after}], dom: {added, removed, changedText, samples}, noise: {tracker, media, challenge, asset, beacon, sensor, document}, result}. Each new request is diffed against the latest earlier call of the same endpoint or GraphQL op, so a filter click shows e.g. diff.query.cat: ['all', 'tech']: the parameter to call directly.",
};

export const browserCauseApi = `
${embedded.map(String).join("\n")}
var __causeHelp = ${JSON.stringify(help)};
if (typeof __helpTopics === 'object') for (var __causeKey of Object.keys(__causeHelp)) __helpTopics[__causeKey] = __causeHelp[__causeKey];
async function __causeEntries(target, base) {
  try {
    var rows = typeof __call === 'function' && target !== undefined
      ? await __call({network: 'list', target})
      : await base.network.list({});
    return Array.isArray(rows) ? rows : [];
  } catch (error) { return []; }
}
async function __causeQuiet(read) { try { return await read(); } catch (error) { return undefined; } }
function __causeObserve(token) {
  var bag = globalThis.__aeonCause || (globalThis.__aeonCause = {});
  var state = {added: 0, removed: 0, changedText: 0, samples: []};
  var note = (text) => { text = String(text || '').trim().replace(/\\s+/g, ' '); if (text && state.samples.length < 3) state.samples.push(text.slice(0, 120)); };
  var observer = new MutationObserver((records) => {
    for (var record of records) {
      if (record.type === 'characterData') { state.changedText += 1; note(record.target.textContent); continue; }
      state.added += record.addedNodes.length; state.removed += record.removedNodes.length;
      for (var node of record.addedNodes) note(node.textContent);
    }
  });
  observer.observe(document.documentElement, {childList: true, subtree: true, characterData: true});
  bag[token] = {state, observer};
  return true;
}
function __causeCollect(token) {
  var bag = globalThis.__aeonCause || {}, item = bag[token];
  if (!item) return null;
  item.observer.disconnect();
  delete bag[token];
  return item.state;
}
async function __causeSnap(target, base, options) {
  var census = typeof gqlCensus === 'function' ? gqlCensus : null;
  var entries = await __causeEntries(target, base);
  return {
    url: await __causeQuiet(() => base.inspect(() => location.href)),
    entries,
    ops: census ? __causeQuietSync(() => census(entries, {})) : [],
    frames: base.streams && base.streams.list ? await __causeQuiet(() => base.streams.list()) : undefined,
    stores: options.stores !== false && base.state && base.state.stores ? await __causeQuiet(() => base.state.stores()) : undefined,
  };
}
function __causeQuietSync(read) { try { return read(); } catch (error) { return []; } }
async function __causeSettle(ms) { if (ms > 0) await new Promise((done) => setTimeout(done, ms)); }
async function __pageCause(target, base, action, options = {}) {
  if (typeof action !== 'function') throw Error('page.cause(action): action must be a function, e.g. () => page.click("text=Tech")');
  var settleMs = Math.max(0, Math.min(Number(options.settleMs ?? 1500) || 0, 15000));
  var before = await __causeSnap(target, base, options);
  var token = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var watching = options.dom !== false && await __causeQuiet(() => base.inspect('(' + String(__causeObserve) + ')(' + JSON.stringify(token) + ')'));
  var result, dom = null;
  try {
    result = await action();
    await __causeSettle(settleMs);
  } finally {
    if (watching) dom = await __causeQuiet(() => base.inspect('(' + String(__causeCollect) + ')(' + JSON.stringify(token) + ')'));
  }
  var after = await __causeSnap(target, base, options);
  var diffed = causeDiffRequests(before.entries, after.entries, before.ops, after.ops);
  return {
    requests: diffed.requests,
    frames: causeSliceFrames(before.frames, after.frames),
    url: {before: before.url ?? null, after: after.url ?? null},
    stores: options.stores === false ? [] : causeDiffStores(before.stores, after.stores),
    dom: dom || {added: 0, removed: 0, changedText: 0, samples: []},
    noise: diffed.noise,
    ...(result !== undefined ? {result} : {}),
  };
}
function __extendPageCause(target, base) {
  return Object.assign(base, {cause: (action, options) => __pageCause(target, base, action, options)});
}
`;
