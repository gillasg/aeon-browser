import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = (name) =>
  pathToFileURL(fileURLToPath(new URL(`../dist/${name}`, import.meta.url))).href;
const { fiberCollectForTest: fiber, fiberScript } = await import(dist("native-browser-fiber.js"));
const { dataV2CollectForTest: dataV2 } = await import(dist("native-browser-data-v2.js"));
const { modulesCollectForTest: modules, modulesScript } = await import(
  dist("native-browser-modules.js")
);
const { browserPosthocExtractApi } = await import(dist("code-api-posthoc-extract.js"));
const { scrubDeep } = await import(dist("native-browser-framework.js"));

// A fiber tree: root -> List (props.items, hook state) -> App class (stateNode.scene) -> host div.
function fiberDoc(extra = {}) {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: i, price: i * 10 }));
  const hookList = {
    memoizedState: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
    next: { memoizedState: 7, next: null },
  };
  const scene = { elements: [{ type: "rect" }, { type: "ellipse" }], nonce: 1 };
  const host = { type: "div", memoizedProps: { className: "x" } };
  const app = {
    type: { name: "App" },
    memoizedProps: {},
    memoizedState: { open: true },
    stateNode: { scene, props: {}, _reactInternals: {} },
    child: host,
  };
  const twin = { type: { name: "Twin" }, memoizedProps: { rows: items }, sibling: app };
  const list = {
    type: { displayName: "ListCard" },
    memoizedProps: { items, children: [], nested: { more: items.map((x) => ({ ...x })) } },
    memoizedState: hookList,
    sibling: twin,
    ...extra,
  };
  const root = { tag: 3, type: null, child: list };
  for (const node of [list, twin, app, host]) node.return = root;
  list.return = root;
  const el = { __reactFiber$abc: host };
  host.return = app;
  app.return = root;
  return { querySelectorAll: () => [el], root, list, items };
}

test("fiber: props arrays, hook list and class stateNode", () => {
  const doc = fiberDoc();
  const out = fiber({}, doc, { instance: "App" });
  assert.ok(out.componentsScanned >= 3);
  const prop = out.matches.find((m) => m.source === "prop" && m.path === "props.items");
  assert.equal(prop.component, "ListCard");
  assert.equal(prop.len, 5);
  assert.deepEqual(prop.keys, ["id", "price"]);
  assert.equal(prop.sample.length, 3);
  const hook = out.matches.find((m) => m.source === "hook");
  assert.equal(hook.path, "hooks[0]");
  assert.equal(hook.len, 4);
  const scene = out.matches.find((m) => m.source === "stateNode");
  assert.equal(scene.component, "App");
  assert.equal(scene.path, "stateNode.scene");
  assert.ok(!out.matches.some((m) => m.path.includes("_reactInternals")));
  // The same array under Twin is not repeated; the structurally equal copy is deduplicated too.
  assert.equal(out.matches.filter((m) => m.len === 5).length, 1);
});

test("fiber: keys and component filters, regex via the script, cycles and hostile getters", () => {
  const doc = fiberDoc();
  assert.deepEqual(
    fiber({}, doc, { keys: ["name"] }).matches.map((m) => m.source),
    ["hook"],
  );
  assert.equal(fiber({}, doc, { component: "Twin" }).matches[0].component, "Twin");
  const cyc = [{ a: 1 }, { a: 2 }, { a: 3 }];
  cyc[0].self = cyc;
  const hostile = {};
  Object.defineProperty(hostile, "boom", {
    enumerable: true,
    get() {
      throw new Error("no");
    },
  });
  const doc2 = fiberDoc({ memoizedProps: { cyc, hostile, items: [] } });
  doc2.list.child = doc2.list; // a cycle in the tree itself
  const out = fiber({}, doc2, {});
  assert.ok(out.matches.some((m) => m.path === "props.cyc"));
  // Through the page script, with a RegExp the sandbox passes as {source, flags}.
  const ctx = vm.createContext({ window: {}, document: doc, Node: class {} });
  const viaScript = vm.runInContext(
    fiberScript({ component: { source: "^list", flags: "i" } }),
    ctx,
  );
  assert.ok(viaScript.matches.length && viaScript.matches.every((m) => m.component === "ListCard"));
  assert.deepEqual(fiber({}, { querySelectorAll: () => [{}] }, {}).matches, []);
});

function attrDoc(scripts = []) {
  const el = (tag, attrs, extra = {}) => ({
    tagName: tag,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    ...extra,
  });
  const elements = [
    el(
      "DIV",
      { "data-props": JSON.stringify({ appid: 10, items: [1, 2] }), class: "x" },
      { id: "app" },
    ),
    el("SPAN", { "data-blob": '{"tralbum":{"title":"T"}}', "data-x": "not json" }),
    el("P", { "data-n": "[bad" }),
  ];
  return {
    querySelectorAll: (css) => (css === "*" ? elements : scripts),
  };
}

test("data v2: JSON data-* attributes and inline globals, skipping a cross-origin frame", () => {
  const frame = new Proxy(
    {},
    {
      get() {
        throw new Error("SecurityError: cross-origin");
      },
      getPrototypeOf() {
        throw new Error("SecurityError: cross-origin");
      },
    },
  );
  const win = {
    0: frame,
    ytInitialData: { contents: { list: [1] } },
    _preloads: { pub: { id: 3 } },
    fn() {},
  };
  win.window = win;
  const out = dataV2(win, attrDoc(), { attrs: true, globals: true });
  assert.deepEqual(
    out.attrs.map((a) => [a.selector, a.attr]),
    [
      ["div#app", "data-props"],
      ["span", "data-blob"],
    ],
  );
  assert.equal(out.attrs[0].value.appid, 10);
  assert.deepEqual(out.attrs[1].keys, ["tralbum"]);
  assert.deepEqual(
    out.globals.map((g) => g.name),
    ["ytInitialData", "_preloads"],
  );
  assert.equal(out.globals[1].value.pub.id, 3);
});

test("data v2: deep find returns nested arrays and scalars (Airbnb and Goodreads shapes)", () => {
  const next = {
    id: "__NEXT_DATA__",
    type: "application/json",
    textContent: JSON.stringify({
      props: {
        a: {
          b: {
            c: {
              searchResults: [
                { listing: { id: 1 }, price: "$1" },
                { listing: { id: 2 }, price: "$2" },
              ],
            },
          },
        },
      },
    }),
  };
  const ld = {
    id: "",
    type: "application/ld+json",
    textContent: JSON.stringify({ book: { stats: { averageRating: 4.36 } } }),
  };
  const win = { window: null, __BXD_DATA: { deep: { averageRating: 3.1 } } };
  win.window = win;
  const doc = attrDoc([next, ld]);
  const arr = dataV2(win, doc, { find: "searchResults", deep: true });
  const hit = arr.matches.find((m) => m.path.endsWith("/searchResults"));
  assert.equal(hit.kind, "array");
  assert.equal(hit.len, 2);
  assert.equal(hit.source, "nextData");
  const rows = dataV2(win, doc, { find: ["listing", "price"], deep: true });
  assert.ok(rows.matches.some((m) => m.kind === "array" && m.len === 2));
  const rating = dataV2(win, doc, { find: "averageRating", deep: true });
  assert.deepEqual(rating.matches.map((m) => [m.source, m.kind, m.value]).sort(), [
    ["global:__BXD_DATA", "scalar", 3.1],
    ["jsonLd", "scalar", 4.36],
  ]);
  assert.equal(rating.matches.find((m) => m.source === "jsonLd").path, "/book/stats/averageRating");
});

function webpackWindow(factories) {
  const req = { m: factories };
  const arr = [];
  arr.push = function (data) {
    data[2](req);
    return Array.prototype.push.call(this, data);
  };
  return { webpackChunk_N_E: arr, arr };
}

test("modules: API paths, GraphQL, signers, no factory called, scrubbed, graceful without webpack", () => {
  const called = [];
  const factory = (src) => {
    const fn = () => called.push(src);
    fn.toString = () => "/api/tampered";
    return fn;
  };
  // Function.prototype.toString ignores an own toString: sources come from the real function.
  const m = {
    1: function a(e, t) {
      return fetch("/api/v1/community/posts/" + t + "/comments");
    },
    2: function b() {
      return {
        operationName: "GetUser",
        extensions: {
          persistedQuery: {
            sha256Hash: "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12",
          },
        },
      };
    },
    3: function c(e) {
      const signRequest = (x) => x;
      return signRequest(e);
    },
    4: function d() {
      return "Bearer abcdefghijklmnopqrstuvwxyz /api/key";
    },
    5: function quiet() {
      return 1;
    },
    6: factory("x"),
  };
  const { arr, ...win } = webpackWindow(m);
  const out = modules(win, {});
  assert.deepEqual(out.chunks, ["webpackChunk_N_E"]);
  assert.equal(out.modulesScanned, 6);
  assert.deepEqual(called, []);
  assert.equal(arr.length, 0, "the probe entry was removed");
  const byId = Object.fromEntries(out.matches.map((x) => [x.id, x.hits]));
  assert.ok(byId[1].some((h) => h.kind === "url" && h.value === "/api/v1/community/posts/"));
  assert.ok(byId[2].some((h) => h.kind === "operation" && h.value === "GetUser"));
  assert.ok(byId[2].some((h) => h.kind === "hash"));
  assert.ok(byId[3].some((h) => h.kind === "signer" && h.value === "signRequest"));
  assert.ok(!byId[5]);
  const scrubbed = JSON.stringify(scrubDeep(out));
  assert.ok(!scrubbed.includes("abcdefghijklmnopqrstuvwxyz"));
  const custom = modules(webpackWindow(m), { grep: { source: "quiet", flags: "" } });
  assert.deepEqual(
    custom.matches.map((x) => x.id),
    ["5"],
  );
  assert.deepEqual(modules({}, {}), { chunks: [], modulesScanned: 0, matches: [] });
  assert.ok(modules({ webpackJsonp: [] }, {}).notes[0].includes("legacy"));
  const viaScript = vm.runInContext(
    modulesScript({}),
    vm.createContext({ window: webpackWindow(m) }),
  );
  assert.equal(viaScript.matches.length, out.matches.length);
});

test("sandbox wiring: page.state.fiber, page.data v2, page.code.modules and help topics", async () => {
  const doc = fiberDoc();
  const win = { ...webpackWindow({ 1: () => "/api/v2/x" }) };
  win.window = win;
  const pageCtx = vm.createContext({
    window: win,
    document: { ...doc, querySelectorAll: (css) => (css === "*" ? doc.querySelectorAll() : []) },
    Node: class {},
  });
  vm.runInContext("window._preloads = { a: 1 }", pageCtx);
  const realm = vm.createContext({ scrubDeep, __helpTopics: { data: "old" } });
  vm.runInContext(browserPosthocExtractApi, realm);
  const calls = [];
  const state = () => "state";
  const base = {
    state,
    inspect: async (expr) => vm.runInContext(expr, pageCtx),
    data: async (options) => (calls.push(options), { jsonLd: [], metadata: {} }),
    code: Object.freeze({ bundle: () => "bundle" }),
  };
  const page = realm.__extendPagePosthoc("t", base);
  const f = await page.state.fiber({ component: /List/ });
  assert.ok(f.matches.length && f.matches.every((x) => x.component === "ListCard"));
  const d = await page.data({ globals: true, summary: true });
  assert.equal(JSON.stringify(calls), '[{"summary":true}]');
  assert.equal(d.globals[0].name, "_preloads");
  assert.equal(
    JSON.stringify(await page.data({ summary: true })),
    JSON.stringify({ jsonLd: [], metadata: {} }),
  );
  const mods = await page.code.modules({ grep: "/api/v2" });
  assert.equal(mods.matches.length, 1);
  assert.equal(page.code.bundle(), "bundle");
  assert.ok(realm.__helpTopics.fiber.includes("page.state.fiber"));
  assert.ok(realm.__helpTopics.modules.includes("page.code.modules"));
  assert.ok(realm.__helpTopics.data.includes("deep: true"));
});
