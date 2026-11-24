// Round 3 page claws in the sandbox: page.ringNetwork, page.framework, page.checkout, page.dialogs.auto,
// page.clipboard, page.workers and page.wasm. Nothing runs, subscribes or enables a domain until one is
// called; each stop() tears its subscription down. The pure parts live in native-browser-*.ts and are
// embedded here by source so the tests run the same code.
import {
  ringCreate,
  ringEvict,
  ringPush,
  ringQuery,
  ringScrub,
  ringConstSource,
  ringScrubUrl,
} from "./native-browser-ring-recorder.js";
import {
  frameworkScript,
  frameworkSource,
  hydrationWarningsOf,
  scrubDeep,
} from "./native-browser-framework.js";
import {
  checkoutCollect,
  checkoutOf,
  checkoutSource,
  dialogDecision,
  dialogLogPush,
  wasmTapInstall,
  wasmTapList,
  wasmTapRemove,
  workersOf,
} from "./native-browser-round3.js";

const embedded = [
  ringScrub,
  ringScrubUrl,
  ringCreate,
  ringEvict,
  ringPush,
  ringQuery,
  scrubDeep,
  hydrationWarningsOf,
  frameworkScript,
  checkoutOf,
  dialogDecision,
  dialogLogPush,
  workersOf,
];

export const browserRound3ClawsApi = `
${ringConstSource}
${frameworkSource}
${checkoutSource}
${embedded.map(String).join("\n")}
var checkoutCollect = ${String(checkoutCollect)};
var wasmTapInstall = ${String(wasmTapInstall)};
var wasmTapList = ${String(wasmTapList)};
var wasmTapRemove = ${String(wasmTapRemove)};
var __r3Ring = new Map(), __r3Dialogs = new Map();
async function __r3RingStart(target, options) {
  var key = __key(target), prior = __r3Ring.get(key);
  if (prior) return {started: false, running: true, windowMs: prior.state.windowMs};
  var state = ringCreate(options || {});
  var push = (row) => ringPush(state, row, Date.now());
  var streams = [
    __cdpStream(target, 'Network.requestWillBeSent', (p) => push({id: p.requestId, method: p.request && p.request.method, url: p.request && p.request.url, type: p.type, preview: p.request && p.request.postData})),
    __cdpStream(target, 'Network.responseReceived', (p) => push({id: p.requestId, url: p.response && p.response.url, status: p.response && p.response.status, mimeType: p.response && p.response.mimeType})),
    __cdpStream(target, 'Network.loadingFailed', (p) => push({id: p.requestId, failed: p.errorText || 'failed'})),
  ];
  __r3Ring.set(key, {state, streams});
  await Promise.all(streams.map((s) => s.ready));
  return {started: true, windowMs: state.windowMs, maxEntries: state.maxEntries};
}
async function __r3RingStop(target) {
  var key = __key(target), ring = __r3Ring.get(key);
  if (!ring) return {stopped: false};
  __r3Ring.delete(key);
  await Promise.all(ring.streams.map((s) => s.stop()));
  return {stopped: true, kept: 0};
}
function __r3RingRecent(target, filter) {
  var ring = __r3Ring.get(__key(target));
  if (!ring) throw Error('INVALID_INPUT: page.ringNetwork.recent needs page.ringNetwork.start() first');
  return ringQuery(ring.state, filter || {}, Date.now());
}
async function __r3Framework(target, options) {
  var page = browser.page(target);
  var raw = await page.inspect(frameworkScript(options || {}));
  var lines = await page.console({errors: true}).catch(() => []);
  var texts = (Array.isArray(lines) ? lines : (lines && lines.messages) || []).map((m) => String((m && (m.text || m.message)) || m));
  raw = raw || {frameworks: [], components: [], hydration: []};
  raw.hydration = (raw.hydration || []).concat(hydrationWarningsOf(texts));
  return scrubDeep(raw);
}
async function __r3DialogsAuto(target, options) {
  var key = __key(target), policy = Object.assign({action: 'accept'}, options || {});
  if (policy.action !== 'accept' && policy.action !== 'dismiss') throw Error("INVALID_INPUT: page.dialogs.auto action is 'accept' or 'dismiss'");
  var prior = __r3Dialogs.get(key);
  if (prior) { prior.policy = policy; return {auto: policy.action, replaced: true}; }
  var page = browser.page(target), entry = {policy, log: []};
  await page.cdp('Page.enable', {}).catch(() => {});
  entry.stream = __cdpStream(target, 'Page.javascriptDialogOpening', async (event) => {
    var decision = dialogDecision(entry.policy, event || {});
    await page.cdp('Page.handleJavaScriptDialog', decision).catch(() => {});
    dialogLogPush(entry.log, event || {}, decision, ringScrub);
  });
  __r3Dialogs.set(key, entry);
  await entry.stream.ready;
  return {auto: policy.action};
}
async function __r3DialogsStop(target) {
  var key = __key(target), entry = __r3Dialogs.get(key);
  if (!entry) return {stopped: false};
  __r3Dialogs.delete(key);
  await entry.stream.stop();
  return {stopped: true, handled: entry.log.length};
}
async function __r3ClipboardGrant(page) {
  var origin = await page.inspect(() => location.origin).catch(() => undefined);
  for (var name of ['clipboard-read', 'clipboard-write'])
    await page.cdp('Browser.setPermission', {permission: {name, allowWithoutSanitization: true}, setting: 'granted', origin}).catch(() => {});
}
async function __r3ClipboardRead(target) {
  var page = browser.page(target);
  await __r3ClipboardGrant(page);
  var got = await page.inspect(async () => {
    try {
      var text = '', html = '';
      for (var item of await navigator.clipboard.read()) {
        if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
      }
      return {ok: true, text, html};
    } catch (error) { return {ok: false, error: String(error && error.message || error)}; }
  });
  if (!got || !got.ok) return {permitted: false, error: (got && got.error) || 'clipboard unavailable'};
  return {permitted: true, text: ringScrub(got.text || '').slice(0, 100000), html: ringScrub(got.html || '').slice(0, 200000)};
}
async function __r3ClipboardWrite(target, value) {
  var data = typeof value === 'string' ? {text: value} : (value || {});
  if (typeof data.text !== 'string') throw Error('INVALID_INPUT: page.clipboard.write needs {text, html?}');
  var page = browser.page(target);
  await __r3ClipboardGrant(page);
  var got = await page.inspect(async (arg) => {
    try {
      var parts = {'text/plain': new Blob([arg.text], {type: 'text/plain'})};
      if (arg.html) parts['text/html'] = new Blob([arg.html], {type: 'text/html'});
      await navigator.clipboard.write([new ClipboardItem(parts)]);
      return {ok: true};
    } catch (error) { return {ok: false, error: String(error && error.message || error)}; }
  }, {text: data.text, html: typeof data.html === 'string' ? data.html : ''});
  return got && got.ok ? {written: true, html: !!data.html} : {written: false, error: (got && got.error) || 'clipboard unavailable'};
}
async function __r3Workers(target) {
  var page = browser.page(target);
  var origin = await page.inspect(() => location.origin);
  var result = await page.cdp('Target.getTargets', {});
  return workersOf((result && result.targetInfos) || [], origin);
}
function __r3Dialogs0(target, base) {
  var legacy = typeof base.dialogs === 'function' ? base.dialogs : async () => ({});
  return Object.assign((...args) => legacy(...args), {
    auto: (options = {}) => __r3DialogsAuto(target, options),
    stop: () => __r3DialogsStop(target),
    history: () => { var entry = __r3Dialogs.get(__key(target)); return entry ? entry.log.slice() : []; },
  });
}
function __extendPageRound3(target, base) {
  return Object.assign(base, {
    ringNetwork: Object.freeze({
      start: (options = {}) => __r3RingStart(target, options),
      stop: () => __r3RingStop(target),
      recent: (filter = {}) => __r3RingRecent(target, filter),
      clear: () => { var ring = __r3Ring.get(__key(target)); if (ring) ring.state.entries.length = 0; return {cleared: !!ring}; },
    }),
    framework: Object.freeze({inspect: (options = {}) => __r3Framework(target, options)}),
    checkout: Object.freeze({detect: async () => checkoutOf(await browser.page(target).inspect(checkoutCollect))}),
    dialogs: __r3Dialogs0(target, base),
    clipboard: Object.freeze({read: () => __r3ClipboardRead(target), write: (value) => __r3ClipboardWrite(target, value)}),
    workers: Object.freeze({list: () => __r3Workers(target)}),
    wasm: Object.freeze({
      start: () => browser.page(target).inspect(wasmTapInstall),
      list: () => browser.page(target).inspect(wasmTapList),
      stop: () => browser.page(target).inspect(wasmTapRemove),
    }),
  });
}
`;
