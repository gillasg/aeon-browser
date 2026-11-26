// Regressions from the live site autopsy: page.why over parsed bodies, stream frames and
// formatted numbers; stores beside a cross-origin frame; replay keeping a POST body; script
// listing by type; pointer timeouts; waitForMessage with a RegExp; graft.list from parts.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const load = (file) => import(pathToFileURL(join(here, "..", "dist", file)).href);

globalThis.chrome ??= {
  debugger: {
    sendCommand: async () => ({}),
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: { get: async () => ({}), onRemoved: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} }, id: "x" },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
};

const { provNormalize, provSearch } = await load("provenance.js");
const { browserWhyApi } = await load("code-api-why.js");
const { browserRecordingApi } = await load("code-api-recording.js");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("formatted human numbers match raw JSON numbers", () => {
  assert.equal(provNormalize("10,385,963").num, 10385963);
  assert.equal(provNormalize("10,385,963 ratings").num, 10385963);
  assert.equal(provNormalize("59,99€").num, 59.99);
  assert.equal(provNormalize("€21").num, 21);
  assert.equal(provNormalize("₹1,999").num, 1999);
  assert.equal(provNormalize("1.234,56 €").num, 1234.56);
  assert.equal(provNormalize("$4.85M").num, 4850000);
  assert.equal(provNormalize("3.4B views").num, 3.4e9);
  const k = provNormalize("2.8K");
  assert.equal(k.num, 2800);
  assert.equal(provSearch({ viewers: 2834 }, k)[0].pointer, "/viewers");
  assert.equal(provSearch({ viewers: 2900 }, k).length, 0);
  assert.equal(provSearch({ total: 10385963 }, provNormalize("10,385,963"))[0].kind, "normalized");
  assert.equal(provSearch({ price: 59.99 }, provNormalize("59,99€"))[0].pointer, "/price");
  assert.equal(provNormalize(undefined).trimmed, "");
});

function whyRealm({ read, entries = [], body, frames }) {
  const page = {
    inspect: async () => read,
    network: { list: async () => entries, body: async (id) => body(id) },
    ...(frames ? { streams: { list: async () => frames } } : {}),
    sources: async () => ({ hits: [] }),
  };
  const ctx = vm.createContext({
    URL,
    console,
    Date,
    browser: { page: () => page },
    __key: (t) => String(t.tabId),
    __element: () => null,
    __call: async () => ({}),
    siteMapper: { operations: async () => [] },
  });
  vm.runInContext(browserRecordingApi + "\n" + browserWhyApi, ctx);
  return ctx;
}

const shown = (value) => ({ element: { value, tag: "span" }, hydration: {} });
const json = [
  { id: "1", method: "GET", url: "https://a.test/api/x", mimeType: "application/json" },
];

test("why links a value in an already-parsed network.body() and in {text}", async () => {
  const parsed = whyRealm({
    read: shown("10,385,963"),
    entries: json,
    body: () => ({ data: { count: 10385963 } }),
  });
  assert.equal(
    plain(await vm.runInContext("__pageWhy({tabId: 1}, '#n')", parsed)).jsonPath,
    "/data/count",
  );
  const text = whyRealm({
    read: shown("Blue"),
    entries: json,
    body: () => ({ text: '{"name":"Blue"}' }),
  });
  assert.equal(plain(await vm.runInContext("__pageWhy({tabId: 1}, '#n')", text)).jsonPath, "/name");
  const array = whyRealm({ read: shown("Red"), entries: json, body: () => [{ name: "Red" }] });
  assert.equal(
    plain(await vm.runInContext("__pageWhy({tabId: 1}, '#n')", array)).jsonPath,
    "/0/name",
  );
});

test("why scans WebSocket frames for a live value", async () => {
  const ctx = whyRealm({
    read: shown("2,734"),
    frames: [
      { direction: "sent", data: '{"rating":2734}' },
      { direction: "received", stream: "wss://socket.test/", data: '{"d":{"rating":2734}}' },
    ],
  });
  const result = plain(await vm.runInContext("__pageWhy({tabId: 1}, '#r')", ctx));
  assert.equal(result.jsonPath, "/d/rating");
  assert.deepEqual(result.stream, { url: "wss://socket.test/" });
});

test("byText rejects undefined and skips script text", async () => {
  const { browserWhyApi: api } = await load("code-api-why.js");
  const source = JSON.parse(/var __whyPageSource = (".*?");\n/.exec(api)[1]);
  const span = {
    tagName: "SPAN",
    innerText: "Price 42",
    textContent: "Price 42",
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }),
    getAttribute: () => null,
  };
  const script = { tagName: "SCRIPT", textContent: 'var x = "Price 42"' };
  const body = { tagName: "BODY" };
  span.parentElement = body;
  script.parentElement = body;
  const nodes = [
    { nodeValue: 'var x = "Price 42"', parentElement: script },
    { nodeValue: "Price 42", parentElement: span },
  ];
  const visited = [];
  const document = {
    body,
    getElementById: () => null,
    querySelector: () => null,
    elementFromPoint: () => null,
    createTreeWalker: (_root, _what, filter) => {
      let i = 0;
      return {
        nextNode() {
          while (i < nodes.length) {
            const node = nodes[i++];
            visited.push(node.parentElement.tagName);
            if (filter.acceptNode(node) === 1) return node;
          }
          return null;
        },
      };
    },
  };
  const ctx = vm.createContext({
    document,
    window: {},
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  });
  const read = vm.runInContext(source, ctx);
  assert.equal(read({ text: "Price 42" }).element.tag, "span");
  visited.length = 0;
  assert.equal(read({ text: undefined, selector: undefined }).element, undefined);
  assert.equal(read({ text: "undefined" }).element, undefined);
  assert.deepEqual(visited, []);
});

test("stores survive a cross-origin frame at window[0] and still find the real store", async () => {
  const { storesCollectForTest: collect } = await load("native-browser-stores.js");
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
      has() {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    },
  );
  const w = {
    get 0() {
      return hostile;
    },
    other: hostile,
    appStore: { getState: () => ({ ok: 1 }), subscribe() {}, setState() {} },
  };
  w.self = w;
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    body: { firstElementChild: null },
  };
  const result = collect(w, doc, {});
  assert.ok(result.stores.some((s) => s.source === "window.appStore"));
});

test("replay keeps the recorded POST body when no change overrides it", async () => {
  const { browserDataApi } = await load("code-api-data.js");
  const sent = [];
  const entry = {
    url: "https://shop.example/graphql",
    method: "POST",
    documentURL: "https://shop.example/",
    requestHeaders: { "content-type": "application/json" },
    requestBody: '{"query":"{ me { id } }"}',
  };
  const base = {
    inspect: async (expression) => {
      if (expression === "location.origin") return "https://shop.example";
      const arg = JSON.parse(expression.slice(expression.lastIndexOf("})(") + 3, -1));
      sent.push(arg);
      return { status: 200, ok: true, json: {} };
    },
  };
  const ctx = vm.createContext({
    URL,
    console,
    __call: async (r) => (r.network === "get" ? entry : null),
  });
  vm.runInContext(browserDataApi, ctx);
  const page = vm.runInContext("__extendPageData", ctx)("t", base);
  await page.replay("r_1");
  assert.equal(sent[0].body, entry.requestBody);
  assert.equal(sent[0].headers["content-type"], "application/json");
  await page.replay("r_1", { json: { query: "x" } });
  assert.equal(sent[1].body, undefined);
  assert.deepEqual(sent[1].json, { query: "x" });
});

test("scripts list by Chrome type or by the name javascript", async () => {
  const { matchesType } = await load("native-browser-network-list.js");
  const script = { type: "Script", mimeType: "text/javascript" };
  for (const want of ["Script", "script", "javascript", "js"])
    assert.ok(matchesType(script, want), want);
  assert.ok(matchesType({ type: "Other", mimeType: "application/javascript" }, "javascript"));
  assert.ok(!matchesType({ type: "XHR", mimeType: "application/json" }, "javascript"));
});

test("a pointer step takes click({timeout})", async () => {
  const { BrowserStepSchema } = await import("@browserkit/protocol");
  const step = {
    op: "pointer",
    target: { tabId: 1 },
    action: "click",
    x: 5,
    y: 5,
    timeoutMs: 3000,
  };
  const issues = BrowserStepSchema.safeParse(step).error?.issues ?? [];
  // The bare target misses ids that are irrelevant here; timeoutMs itself must be accepted.
  assert.ok(
    issues.length > 0 && issues.every((issue) => issue.path[0] === "target"),
    JSON.stringify(issues),
  );
  const without =
    BrowserStepSchema.safeParse({ ...step, timeoutMs: undefined }).error?.issues ?? [];
  assert.equal(issues.length, without.length);
});

test("waitForMessage takes a RegExp", async () => {
  const { browserEventsApi } = await load("code-api-events.js");
  assert.match(browserEventsApi, /match instanceof RegExp/);
});

test("graft.list reads css and js from a boost summary's parts", async () => {
  const { browserDemoClawsApi } = await load("code-api-demo-claws.js");
  const ctx = vm.createContext({
    URL,
    setTimeout,
    __helpTopics: {},
    __siteBase: {},
    __siteL2: {},
    site: {},
    browser: {
      boosts: {
        list: async () => [
          { id: "graft-a", name: "a", enabled: true, sites: ["x.com"], parts: ["css"] },
          { id: "graft-b", name: "b", enabled: true, sites: ["x.com"], parts: ["css", "js"] },
        ],
      },
    },
  });
  vm.runInContext(browserDemoClawsApi, ctx);
  const page = vm.runInContext("__extendPageDemoClaws", ctx)("t", { url: () => "https://x.com/" });
  const list = plain(await page.graft.list({}));
  assert.deepEqual(
    list.map((g) => [g.id, g.css, g.js]),
    [
      ["graft-a", true, false],
      ["graft-b", true, true],
    ],
  );
});
