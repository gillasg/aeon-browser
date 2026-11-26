// page.network.graphql, page.graphql.call, page.wall and page.feeds in the sandbox, plus the wall
// note on summary(), feed.collect() and openTab. The pure parts live in native-browser-graphql.ts,
// native-browser-wall.ts and native-browser-feeds.ts and are embedded here by source, so the tests
// run the same code.
import {
  gqlBuildCall,
  gqlCensus,
  gqlDataOf,
  gqlFromUrl,
  gqlHashOf,
  gqlItemOf,
  gqlJson,
  gqlMerge,
  gqlOpName,
  gqlOpsOf,
  gqlResponseKeys,
  gqlScrub,
} from "./native-browser-graphql.js";
import {
  wallDetect,
  wallFacts,
  wallLine,
  wallLogin,
  wallMainDoc,
  wallPartial,
  wallPath,
  wallStatusKind,
  wallTextKind,
} from "./native-browser-wall.js";
import {
  feedAllowed,
  feedLinkFacts,
  feedLinksOf,
  feedParse,
  feedSite,
  feedTag,
  feedText,
  feedTypeOf,
  feedXmlItems,
} from "./native-browser-feeds.js";

const embedded = [
  gqlScrub,
  gqlOpName,
  gqlHashOf,
  gqlJson,
  gqlItemOf,
  gqlFromUrl,
  gqlOpsOf,
  gqlCensus,
  gqlResponseKeys,
  gqlMerge,
  gqlBuildCall,
  gqlDataOf,
  wallTextKind,
  wallStatusKind,
  wallPath,
  wallMainDoc,
  wallPartial,
  wallLogin,
  wallDetect,
  wallLine,
  feedTypeOf,
  feedSite,
  feedAllowed,
  feedLinksOf,
  feedText,
  feedTag,
  feedXmlItems,
  feedParse,
];

const help = {
  graphql:
    "page.network.graphql({op?, limit?, keys?}) lists every GraphQL operation the tab sent, by name, from the recording: standard POST {operationName, query, variables} (an anonymous query is named by its first root field), batched POST arrays (one row per item with batchIndex) and persisted GETs (?operationName&extensions, or /api/v3/<Op>/<sha256>): [{id, op, kind: 'query'|'mutation'|'persisted', hash, url, method, variables (secrets redacted), batchIndex, status, responseKeys}]. page.graphql.call(op, variables?, {replace?, raw?}) re-sends the latest recorded operation of that name from the page with its cookies, headers, query or persisted hash and batch wrapper, merging variables into the recorded ones ({replace: true} replaces them), and returns the answer's data ({raw: true}: the whole response).",
  wall: "page.wall() says whether the page is behind a wall: {blocked, kind: 'cloudflare'|'vercel'|'aws-waf'|'akamai'|'datadome'|'perimeterx'|'rate-limit'|'login'|'waf'|null, status, signal, partial: [{url, status, kind}]}. It reads the title, a text sample and vendor markers (Turnstile, Vercel checkpoint, PerimeterX, DataDome, AWS WAF) plus the recorded statuses (403, 429, 503, 708). partial lists data requests (/api, /graphql, /csi, XHR) a wall refused while the page itself loaded: what the page shows is then incomplete. openTab prints a '[wall]' line, and summary() and an empty feed.collect() carry a wall field when one is found. An empty page behind a wall is not an empty result: say so, see help('gated').",
  feeds:
    "page.feeds({peek = true, limit = 5}) lists the page's declared side doors: <link rel=alternate> RSS, Atom, JSON Feed and oEmbed. Each is [{type: 'rss'|'atom'|'json'|'oembed', href, title, items: [{title, link, date}], sample}], with one bounded peek (64 KB) per feed, only same-origin (oEmbed: same site); others come back with skipped. A feed is the cheapest source to watch for new items.",
};

export const browserPosthocNetApi = `
${embedded.map(String).join("\n")}
var wallFacts = ${String(wallFacts)};
var feedLinkFacts = ${String(feedLinkFacts)};
var __pnHelp = ${JSON.stringify(help)};
if (typeof __helpTopics === 'object') for (var __pnKey of Object.keys(__pnHelp)) __helpTopics[__pnKey] = __pnHelp[__pnKey];
// Read quietly: straight from the recording, so an empty list prints no note and starts nothing.
async function __pnEntries(base) {
  try {
    var rows = typeof __call === 'function' && base.__pnTarget
      ? await __call({network: 'list', target: base.__pnTarget})
      : await base.network.list({});
    return Array.isArray(rows) ? rows : [];
  } catch (error) { return []; }
}
async function __pnGraphql(base, options = {}) {
  var ops = gqlCensus(await __pnEntries(base), options);
  if (options.keys === false) return ops;
  var bodies = new Map();
  for (var op of ops.slice(-30)) {
    if (!op.id || bodies.has(op.id)) continue;
    bodies.set(op.id, await base.network.body(op.id).catch(() => undefined));
  }
  return ops.map((op) => Object.assign(op, {responseKeys: gqlResponseKeys(bodies.get(op.id), op.batchIndex)}));
}
async function __pnGraphqlCall(base, name, variables, options = {}) {
  var ops = gqlCensus(await __pnEntries(base), {op: name});
  var op = ops[ops.length - 1];
  if (!op) throw Error('NOT_FOUND: no recorded GraphQL operation ' + JSON.stringify(String(name)) + '; page.network.graphql() lists what the tab sent');
  var recorded = await base.network.get(op.id);
  var call = gqlBuildCall(recorded, op, variables, options.replace === true);
  var sent;
  try { sent = await base.replay(op.id, call.json !== undefined ? {json: call.json} : {url: call.url}); }
  catch (error) {
    if (typeof browser !== 'object' || !browser.fetch) throw error;
    sent = await browser.fetch(call.url, {method: call.method, ...(call.json !== undefined ? {json: call.json} : {})});
  }
  if (options.raw === true) return sent;
  var json = sent && sent.json !== undefined ? sent.json : gqlJson(sent && (sent.text || sent.body));
  if (json === undefined) throw Error('the GraphQL answer was not JSON (status ' + (sent && sent.status) + ')');
  return gqlDataOf(json);
}
async function __pnWall(base) {
  var facts = await base.inspect(wallFacts);
  return wallDetect(facts, await __pnEntries(base));
}
async function __pnFeeds(base, options = {}) {
  var url = await base.inspect(() => location.href);
  var feeds = feedLinksOf(await base.inspect(feedLinkFacts), url);
  if (options.peek === false) return feeds;
  var limit = Math.max(1, Math.min(Number(options.limit) || 5, 50));
  var out = [];
  for (var feed of feeds) {
    if (!feed.allowed) { out.push(Object.assign(feed, {skipped: 'not same-origin'})); continue; }
    var answer = await base.request(feed.href, {method: 'GET'}).catch((error) => ({error: String(error && error.message || error)}));
    if (answer.error || answer.status >= 400) { out.push(Object.assign(feed, {error: answer.error || 'status ' + answer.status})); continue; }
    var body = answer.text !== undefined ? answer.text : answer.json;
    out.push(Object.assign(feed, feedParse(feed.type, body, limit)));
  }
  return out;
}
// One line when openTab lands behind a wall, hard or partial. Never fails the open.
async function __pnWallNote(target) {
  try {
    var wall = await Promise.race([__pnWall(browser.page(target)), new Promise((done) => setTimeout(() => done(null), 1500))]);
    var line = wall ? wallLine(wall) : '';
    if (line) console.log('[wall] ' + line + '; page.wall() has the details');
  } catch (ignored) {}
}
function __pnNoted(wall, result) {
  if (!wall || !(wall.blocked || wall.partial.length) || !result || typeof result !== 'object') return result;
  return Object.assign(result, {wall, blocked: wall.blocked});
}
function __extendPagePosthocNet(target, base) {
  var summary = base.summary, feed = base.feed;
  Object.defineProperty(base, '__pnTarget', {value: target, enumerable: false, configurable: true});
  var wall = () => __pnWall(base);
  return Object.assign(base, {
    network: Object.freeze(Object.assign({}, base.network, {graphql: (options) => __pnGraphql(base, options)})),
    graphql: Object.freeze({
      list: (options) => __pnGraphql(base, options),
      call: (op, variables, options) => __pnGraphqlCall(base, op, variables, options),
    }),
    wall,
    feeds: (options) => __pnFeeds(base, options),
    ...(summary ? {summary: async (...args) => __pnNoted(await wall().catch(() => null), await summary(...args))} : {}),
    ...(feed && feed.collect ? {feed: Object.freeze(Object.assign({}, feed, {collect: async (options) => {
      var result = await feed.collect(options);
      var items = result && Array.isArray(result.items) ? result.items : [];
      var found = await wall().catch(() => null);
      return items.length && !(found && found.partial.length) ? result : __pnNoted(found, result);
    }}))} : {}),
  });
}
`;
