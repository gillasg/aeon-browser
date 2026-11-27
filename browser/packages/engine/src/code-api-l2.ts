// The L2 grammar of graft-l2-contract.d.ts, evaluated in the browser_code realm after every other
// part: human.* (the user, when only a person can do a step), site.ops/call/watch/write beside
// site.run, page.ref and page.wire, tab-qualified refs (t<tab>:e<id>) and help topics for them.
// Each name delegates to the capability that already exists (bu.*, siteMapper.*, page.rules),
// so the older names stay working as hidden aliases.
const HELP = {
  human:
    "human.handoff(why, {page?, kind?: 'cliff-edge'|'auth'|'captcha'|'question', target?, actionLabel?, options?, input?}) asks the user to do a step in the tab and returns 'done' or the text they typed; Cancel throws HANDOFF_CANCELLED. Example: await human.handoff('Pay $42.10 to Acme?', {kind: 'cliff-edge', actionLabel: 'Pay $42.10', target: 't7:e12'}). human.signIn({page?, account?}) signs in with the user's password manager; human.fillProfile({page?}) fills a form from the user's profile; human.fillCode({page?}) types the one-time code the site just sent.",
  site: "site.ops(host) lists a mapped site's operations; await site.call('github.com', 'listIssues', {repo}) runs one; site.watch(host, op, params) returns only items new since the last watch; site.write(host, op, params) runs a write; site.run(ability, inputs) runs a saved ability. siteMapper.* stays available.",
  wire: "page.wire(rules) applies declarative network rules in Chrome and returns {undo}. Rules: {match, abort: true}, {match, headers: {name: value}}, {match, fulfill: {status?, json?, body?}}, {turbo: true}. Example: var w = await page.wire([{match: '||ads.example.com', abort: true}]); ...; await w.undo(). It is not page.route: no per-request callback runs.",
  tap: "page.tap(kind, {match?}) opens a live stream; help('live') lists the kinds (network, ws, sse, notifications, console, downloads, storage).",
  pool: "browser.pool(items, async (page, item) => page.read(), {concurrency: 4}) runs one tab per item in parallel. Refs are tab-qualified (t<tab>:e<id>), so a ref from one tab never acts on another.",
  tabs: "browser.tabs() lists tabs; browser.page(tab) opens one as a Page; page.ref is 't<tabId>'. browser.openTab(url, {background: true}) opens a new tab.",
  refs: "page.state() prints numbered ids. page.click('t7:e12') acts on element 12 of tab 7 only: on another tab it throws WRONG_TAB. Bare ids (12, 'e12') act on the page they are passed to.",
};

export const browserL2Api = `
var __l2Help = ${JSON.stringify(HELP)};
for (var __l2Key of Object.keys(__l2Help)) __helpTopics[__l2Key] = __helpTopics[__l2Key] ? __l2Help[__l2Key] + ' ' + __helpTopics[__l2Key] : __l2Help[__l2Key];
var __helpBase = help;
var __L2_OVERVIEW = 'L2: page.* uses Playwright names (click, fill, getByRole, waitForURL); human.* hands a step to the user; site.* calls mapped site APIs; browser.* holds tabs, pool and fetch.';
help = function (topic) {
  if (topic) return __helpBase(topic);
  console.log(__L2_OVERVIEW);
  return __L2_OVERVIEW + String.fromCharCode(10) + __helpBase();
};
// 't7:e12' on tab 7 is 'e12' (or 12); on another tab it is refused, never acted on.
var __TAB_REF = /^t(\\d+):((?:f\\d+:)?e?\\d+)$/;
function __tabRef(target, element) {
  if (typeof element !== 'string') return element;
  var match = __TAB_REF.exec(element);
  if (!match) return element;
  var tabId = Number(match[1]);
  var own = target && typeof target === 'object' ? target.tabId : target;
  if (own !== undefined && own !== null && Number(own) !== tabId)
    throw Error('WRONG_TAB: ' + element + ' is from tab ' + tabId + ', not this page (t' + own + '); act on browser.page(' + tabId + ') or read this page.state() again');
  return /^\\d+$/.test(match[2]) ? Number(match[2]) : match[2];
}
function __l2Page(options) {
  return options && options.page && options.page.target ? options.page.target : options && options.target;
}
function __l2Pass(options, extra) {
  var target = __l2Page(options);
  return Object.assign({}, extra || {}, target ? {target} : {});
}
var __HUMAN_KINDS = ['cliff-edge', 'auth', 'captcha', 'question'];
var human = Object.freeze({
  handoff: async (why, options = {}) => {
    if (options.kind !== undefined && !__HUMAN_KINDS.includes(options.kind))
      throw Error('INVALID_INPUT: human.handoff kind must be one of ' + __HUMAN_KINDS.join(', ') + ', not ' + JSON.stringify(options.kind));
    var message = String(why ?? '');
    // A question is the plain hand-off: the user answers in the cursor's ask; choices go in the text.
    if (Array.isArray(options.options) && options.options.length) message += ' (' + options.options.map(String).join(' / ') + ')';
    if (options.input) message += ' ' + String(options.input);
    var kind = options.kind === 'question' ? undefined : options.kind;
    var target = options.page && options.page.target;
    var element = options.target;
    var selector = typeof element === 'string' && !__TAB_REF.test(element) ? element : element && typeof element.selector === 'string' ? element.selector : undefined;
    if (typeof element === 'string' && __TAB_REF.test(element)) {
      var tab = Number(__TAB_REF.exec(element)[1]);
      if (target && Number(target.tabId) !== tab) __tabRef(target, element);
      if (!target) target = __targetNow(tab);
    }
    return bu.handoff(message, {
      ...(target ? {target} : {}), ...(kind ? {kind} : {}), ...(selector ? {selector} : {}),
      ...(options.actionLabel ? {actionLabel: options.actionLabel} : {}),
      ...(options.start === true ? {start: true} : {}), ...(options.wait === true ? {wait: true} : {}),
    });
  },
  signIn: (options = {}) => bu.signIn(__l2Pass(options, options.account ? {account: options.account} : {})),
  fillProfile: (options = {}) => bu.fillProfile(__l2Pass(options, Array.isArray(options.fields) ? {fields: options.fields} : {})),
  fillCode: (options = {}) => bu.fillCode(__l2Pass(options, options.waitMs ? {waitMs: options.waitMs} : {})),
});
// site.ops/call/watch/write: the mapped-site calls, under the contract's names, beside abilities.
var __siteL2 = {
  ops: (host) => siteMapper.operations(host),
  call: (host, op, params = {}) => siteMapper.call(host, op, params),
  watch: (host, op, params = {}) => siteMapper.watch(host, op, params),
  write: (host, op, params = {}) => siteMapper.write(host, op, params),
};
site = Object.freeze(new Proxy(Object.assign({}, __siteBase, __siteL2), {
  get: (target, name) => {
    if (typeof name !== 'string' || name in target) return target[name];
    if (name === 'then' || name === 'toJSON' || name === 'inspect') return undefined;
    return async (inputs = {}, options = {}) => target.run(name, inputs, options);
  },
}));
function __wireOne(page, rule) {
  if (!rule || typeof rule !== 'object') throw Error('INVALID_INPUT: page.wire takes an array of rules: help("wire")');
  if (rule.turbo === true) return page.turbo().then(() => 'turbo');
  if (rule.match instanceof RegExp || (rule.match !== undefined && typeof rule.match !== 'string'))
    throw Error('INVALID_INPUT: page.wire match must be a URL filter string such as "||ads.example.com" or "/api/"');
  if (rule.abort === true) return page.rules.block({urls: [rule.match]}).then(() => 'rules');
  if (rule.headers && typeof rule.headers === 'object') return page.rules.headers(rule.headers).then(() => 'rules');
  if (rule.fulfill && typeof rule.fulfill === 'object') {
    var json = rule.fulfill.json !== undefined;
    return page.rules.mock(rule.match, json ? rule.fulfill.json : String(rule.fulfill.body ?? ''), json ? 'application/json' : 'text/plain').then(() => 'rules');
  }
  throw Error('INVALID_INPUT: unknown page.wire rule ' + JSON.stringify(Object.keys(rule)) + ': help("wire")');
}
async function __wireRules(page, rules) {
  var applied = new Set();
  for (var rule of [].concat(rules || [])) applied.add(await __wireOne(page, rule));
  return Object.freeze({
    undo: async () => {
      if (applied.has('rules')) await page.rules.clear();
      if (applied.has('turbo')) await page.turbo(false);
    },
  });
}
// Tab-qualified ids and the contract's page members, on every page handle.
function __extendPageL2(target, base) {
  // click, fill, press, hold and paste resolve t<tab>:e<id> in __element / __locatorFor.
  var select = base.selectOption, upload = base.upload;
  var bare = (element) => { var out = __tabRef(target, element); return typeof out === 'number' ? String(out) : out; };
  if (typeof select === 'function') base.selectOption = (element, value) => select(bare(element), value);
  if (typeof upload === 'function') base.upload = (element, files) => files === undefined ? upload(element) : upload(bare(element), files);
  Object.defineProperty(base, 'ref', {value: 't' + (target && typeof target === 'object' ? target.tabId : target), enumerable: false});
  base.wire = (rules) => __wireRules(base, rules);
  return base;
}
`;
