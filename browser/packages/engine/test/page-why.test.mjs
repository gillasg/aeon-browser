// page.why: value normalization, JSON pointer search and ranking, the four-link join over a fake
// browser (network bodies, hydration, component, sources, mapped operations), partial misses, and the
// provenance event a recording keeps. No Chrome, no model.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  provNormalize,
  provSearch,
  provRank,
  provOperation,
  provLeafKey,
} from "../dist/provenance.js";
import { browserWhyApi } from "../dist/code-api-why.js";
import { browserRecordingApi } from "../dist/code-api-recording.js";
import { browserReApi } from "../dist/code-api-re.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

test("values normalize: currency, thousands, negatives, plain text", () => {
  assert.equal(provNormalize("$1,234.50").num, 1234.5);
  assert.equal(provNormalize(" 1,234 ").num, 1234);
  assert.equal(provNormalize("(42)").num, -42);
  assert.equal(provNormalize("12%").num, 12);
  assert.equal(provNormalize("Acme Corp").num, undefined);
  assert.equal(provNormalize("  Acme   Corp ").trimmed, "Acme Corp");
});

test("search yields RFC 6901 pointers for exact, formatted and nested hits", () => {
  const data = {
    data: { metrics: [{ revenue: 1234.5 }, { revenue: "$1,234.50", "a/b": "x" }] },
    title: "Quarterly Report",
  };
  const hits = provSearch(data, provNormalize("$1,234.50"));
  assert.deepEqual(
    hits.map((h) => [h.pointer, h.kind]),
    [
      ["/data/metrics/0/revenue", "normalized"],
      ["/data/metrics/1/revenue", "exact"],
    ],
  );
  assert.equal(provSearch(data, provNormalize("x"))[0].pointer, "/data/metrics/1/a~1b");
  assert.equal(provSearch(data, provNormalize("quarterly report"))[0].kind, "normalized");
  assert.equal(provSearch(data, provNormalize("Quarterly"))[0].kind, "substring");
  assert.equal(provSearch(data, provNormalize("1234")).length, 0);
});

test("search survives cycles and depth bounds", () => {
  const loop = { name: "Loop" };
  loop.self = loop;
  assert.equal(provSearch(loop, provNormalize("Loop")).length, 1);
  const deep = { a: { b: { c: { d: "Deep" } } } };
  assert.equal(provSearch(deep, provNormalize("Deep"), { maxDepth: 2 }).length, 0);
});

test("ranking: exact over normalized, newer response over older, deeper over root", () => {
  const ranked = provRank([
    { pointer: "/a", kind: "normalized", depth: 1, recency: 9, source: "network" },
    { pointer: "/old/v", kind: "exact", depth: 2, recency: 1, source: "network" },
    { pointer: "/new/v", kind: "exact", depth: 2, recency: 2, source: "network" },
    { pointer: "/new/x/v", kind: "exact", depth: 3, recency: 2, source: "network" },
  ]);
  assert.deepEqual(
    ranked.map((c) => c.pointer),
    ["/new/x/v", "/new/v", "/old/v", "/a"],
  );
});

test("operations match by method and path template, most literal first", () => {
  const ops = [
    { id: "anyItem", method: "GET", path: "/api/{kind}/{id}" },
    { id: "getItem", method: "GET", path: "/api/items/{id}" },
    { id: "saveItem", method: "POST", path: "/api/items/{id}" },
  ];
  assert.equal(provOperation("get", "https://a.test/api/items/7?x=1", ops), "getItem");
  assert.equal(provOperation("POST", "https://a.test/api/items/7", ops), "saveItem");
  assert.equal(provOperation("GET", "https://a.test/other", ops), undefined);
  assert.equal(provLeafKey("/data/metrics/0/revenue"), "revenue");
});

function realm({ read, entries = [], bodies = {}, ops, hits = [], maps }) {
  const calls = [];
  const page = {
    inspect: async (expression) => {
      assert.equal(typeof expression, "string");
      return read;
    },
    network: {
      list: async () => {
        if (entries === null) throw Error("capture off");
        return entries;
      },
      body: async (id) => ({ body: bodies[id] }),
    },
    sources: async (options) => {
      calls.push(options.search);
      return { hits: hits.filter((h) => h.code.includes(options.search)) };
    },
    cdp: async (method, params) => {
      calls.push(method + ":" + params.backendNodeId);
      return { model: { border: [10, 20, 30, 20, 30, 40, 10, 40] } };
    },
  };
  const ctx = vm.createContext({
    URL,
    console,
    Date,
    browser: { page: () => page },
    __key: (t) => String(t.tabId),
    __element: (_t, id) => ({ kind: "backend", backendNodeId: Number(id), name: "Revenue" }),
    __call: async (req) => {
      calls.push(req);
      if (req.siteMapper === "sourcemaps") return maps(req);
      return { data: { subscriptionId: 1, events: [] } };
    },
    siteMapper: {
      operations: async () => {
        if (!ops) throw Error("not mapped");
        return ops;
      },
    },
  });
  vm.runInContext(
    browserRecordingApi + "\n" + browserWhyApi + (maps ? "\n" + browserReApi : ""),
    ctx,
  );
  return { ctx, calls, page };
}

const element = {
  value: "$1,234.50",
  tag: "span",
  bounds: { x: 1, y: 2, width: 30, height: 10 },
};

test("the four-link join: element, request with op, json pointer, component, source", async () => {
  const { ctx } = realm({
    read: {
      element,
      component: { name: "RevenueCard", framework: "react", props: { label: "Revenue" } },
      hydration: {},
    },
    entries: [
      {
        id: "1",
        method: "GET",
        url: "https://a.test/api/stats/1",
        status: 200,
        mimeType: "application/json",
      },
      {
        id: "2",
        method: "GET",
        url: "https://a.test/api/stats/2",
        status: 200,
        mimeType: "application/json",
      },
    ],
    bodies: {
      1: JSON.stringify({ data: { metrics: [{ revenue: 1234.5 }] } }),
      2: JSON.stringify({ data: { metrics: [{ revenue: 1234.5 }] } }),
    },
    ops: [{ id: "getStats", method: "GET", path: "/api/stats/{id}" }],
    hits: [{ file: "https://a.test/app.js", line: 42, code: "function RevenueCard(" }],
  });
  const result = plain(await vm.runInContext("__pageWhy({tabId: 1}, '#rev')", ctx));
  assert.deepEqual(result, {
    value: "$1,234.50",
    bounds: element.bounds,
    jsonPath: "/data/metrics/0/revenue",
    request: {
      id: "2",
      method: "GET",
      path: "/api/stats/2",
      url: "https://a.test/api/stats/2",
      status: 200,
      op: "getStats",
    },
    component: { name: "RevenueCard", framework: "react", props: { label: "Revenue" } },
    source: { file: "https://a.test/app.js", line: 42 },
  });
});

test("hydration fallback: __NEXT_DATA__, Apollo and Redux carry the value when no request did", async () => {
  const { ctx } = realm({
    read: {
      element: { ...element, value: "Blue Kettle" },
      component: { name: "Item", framework: "react", file: "src/Item.tsx", line: 7 },
      hydration: {
        __NEXT_DATA__: { props: { pageProps: { items: [{}, {}, { title: "Blue Kettle" }] } } },
        __APOLLO_STATE__: { "Item:1": { name: "Red Kettle" } },
        redux: { cart: { last: "blue kettle" } },
      },
    },
    entries: [],
  });
  const result = plain(await vm.runInContext("__pageWhy({tabId: 1}, 'Blue Kettle')", ctx));
  assert.equal(result.jsonPath, "/props/pageProps/items/2/title");
  assert.deepEqual(result.hydration, { kind: "__NEXT_DATA__" });
  assert.deepEqual(result.source, { file: "src/Item.tsx", line: 7 });
  assert.deepEqual(result.missing, ["network-body"]);
  const apollo = realm({
    read: {
      element: { ...element, value: "Red Kettle" },
      hydration: { __APOLLO_STATE__: { "Item:1": { name: "Red Kettle" } } },
    },
    entries: [],
  });
  const second = plain(await vm.runInContext("__pageWhy({tabId: 1}, 'x')", apollo.ctx));
  assert.equal(second.jsonPath, "/Item:1/name");
  assert.deepEqual(second.hydration, { kind: "__APOLLO_STATE__" });
});

test("partial misses name every broken link and still return what resolved", async () => {
  const { ctx } = realm({ read: { hydration: {} }, entries: null });
  const result = plain(await vm.runInContext("__pageWhy({tabId: 1}, {text: 'Ghost'})", ctx));
  assert.equal(result.value, "Ghost");
  assert.deepEqual(result.missing, [
    "element",
    "network-capture",
    "network-body",
    "component",
    "source-map",
  ]);
  const unmapped = realm({
    read: { element, hydration: {} },
    entries: [
      { id: "1", method: "GET", url: "https://a.test/api/x", mimeType: "application/json" },
    ],
    bodies: { 1: JSON.stringify({ total: "$1,234.50" }) },
  });
  const second = plain(await vm.runInContext("__pageWhy({tabId: 1}, '#t')", unmapped.ctx));
  assert.equal(second.request.path, "/api/x");
  assert.deepEqual(second.missing, ["site-op", "component", "source-map"]);
});

test("an observed id resolves through its box to a point", async () => {
  const seen = [];
  const { ctx, page } = realm({ read: { element, hydration: {} } });
  page.inspect = async (expression) => {
    seen.push(expression);
    return { element, hydration: {} };
  };
  await vm.runInContext("__pageWhy({tabId: 1}, 12)", ctx);
  assert.match(seen[0], /\{"x":20,"y":30,"text":"Revenue"\}\)$/);
});

test("a running recording keeps a provenance event with jsonPath and bounds", async () => {
  const { ctx } = realm({
    read: { element, hydration: { __NEXT_DATA__: { total: 1234.5 } } },
  });
  vm.runInContext("__provRecordings.set('1', globalThis.__events = [])", ctx);
  await vm.runInContext("__pageWhy({tabId: 1}, '#t')", ctx);
  const events = plain(vm.runInContext("__events", ctx));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "provenance");
  assert.equal(events[0].jsonPath, "/total");
  assert.deepEqual(events[0].bounds, element.bounds);
  assert.equal(events[0].value, "$1,234.50");
});

test("the page reader resolves a point to its element, React owner and source", () => {
  const match = /var __whyPageSource = (".*");\n/.exec(browserWhyApi);
  const source = JSON.parse(match[1]);
  const fiber = {
    type: "span",
    return: {
      type: { name: "PriceTag" },
      memoizedProps: { amount: 1234.5, onClick() {} },
      _debugSource: { fileName: "src/PriceTag.tsx", lineNumber: 12, columnNumber: 3 },
    },
  };
  const el = {
    tagName: "SPAN",
    innerText: " $1,234.50 ",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 5, top: 6, width: 7, height: 8 }),
    parentElement: null,
    __reactFiber$abc: fiber,
  };
  const ctx = vm.createContext({
    window: { __INITIAL_STATE__: { price: 1234.5 } },
    document: {
      elementFromPoint: () => el,
      getElementById: () => ({ textContent: '{"page":"/p"}' }),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
  });
  const out = plain(
    vm.runInContext("(" + source + ")(" + JSON.stringify({ x: 5, y: 6 }) + ")", ctx),
  );
  assert.deepEqual(out.element, {
    value: "$1,234.50",
    tag: "span",
    bounds: { x: 5, y: 6, width: 7, height: 8 },
  });
  assert.deepEqual(out.component, {
    name: "PriceTag",
    framework: "react",
    props: { amount: 1234.5, onClick: "[fn]" },
    file: "src/PriceTag.tsx",
    line: 12,
    column: 3,
  });
  assert.deepEqual(out.hydration, {
    __NEXT_DATA__: { page: "/p" },
    __INITIAL_STATE__: { price: 1234.5 },
  });
});

test("link 4 gains the original file and line when the script has a source map", async () => {
  const { ctx, calls } = realm({
    read: { element, component: { name: "RevenueCard", framework: "react" }, hydration: {} },
    hits: [{ file: "https://a.test/app.js", line: 1, col: 420, code: "function RevenueCard(" }],
    maps: (req) => ({
      positions: [
        { ...req.options.positions[0], original: { source: "src/Revenue.tsx", line: 12, col: 2 } },
      ],
    }),
  });
  const result = plain(await vm.runInContext("__pageWhy({tabId: 1}, '#rev')", ctx));
  assert.deepEqual(result.source, {
    file: "https://a.test/app.js",
    line: 1,
    original: { source: "src/Revenue.tsx", line: 12, col: 2 },
  });
  const request = calls.find((call) => call && call.siteMapper === "sourcemaps");
  assert.deepEqual(plain(request.options.positions), [{ line: 1, col: 420 }]);
});
