// The demo claws: page.graft over boosts (and nothing on a page at rest), browser.join and its
// delta, site.pipe with no model, page.cache.read, page.download.parse with path confinement,
// page.feed.collect and page.editor, against plain rows, a fake DOM and a fake sandbox.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserDemoClawsApi } from "../dist/code-api-demo-claws.js";
import { joinRows, pipeTransform } from "../dist/native-browser-join.js";
import {
  confineFilePath,
  parseDelimited,
  parseFileText,
} from "../dist/native-browser-file-parse.js";
import { cacheRead, editorDetect, feedStep } from "../dist/native-browser-feed-editor.js";
import { graftBoost, graftMatch } from "../dist/native-browser-graft.js";

const plain = (value) => JSON.parse(JSON.stringify(value));
const users = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Lin" },
  { id: 3, name: "Kim" },
];
const orders = [
  { userId: 1, total: 10 },
  { userId: 1, total: 5 },
  { userId: 4, total: 7 },
];

test("join: inner, left, right and full over [leftKey, rightKey]", () => {
  const on = ["id", "userId"];
  assert.equal(joinRows(users, orders, { on }).length, 2);
  const left = joinRows(users, orders, { on, type: "left" });
  assert.deepEqual(
    left.map((row) => [row.name, row.total ?? null]),
    [
      ["Ada", 10],
      ["Ada", 5],
      ["Lin", null],
      ["Kim", null],
    ],
  );
  assert.deepEqual(
    joinRows(users, orders, { on, type: "right" }).map((r) => r.total),
    [10, 5, 7],
  );
  assert.equal(joinRows(users, orders, { on, type: "full" }).length, 5);
});

test("join: key functions, select and clashing fields", () => {
  const rows = joinRows([{ k: "A", v: 1 }], [{ k: "a", v: 2 }], {
    on: (row) => row.k.toLowerCase(),
  });
  assert.deepEqual(plain(rows), [{ k: "A", v: 1, right_k: "a", right_v: 2 }]);
  assert.deepEqual(plain(joinRows(users, orders, { on: ["id", "userId"], select: ["name"] })), [
    { name: "Ada" },
    { name: "Ada" },
  ]);
  assert.throws(() => joinRows(users, orders, {}), /INVALID_INPUT/);
  assert.throws(() => joinRows(users, orders, { on: "id", type: "cross" }), /INVALID_INPUT/);
});

test("join delta: added, removed, changed (with fields) and unchanged", () => {
  const before = [
    { id: 1, p: 10 },
    { id: 2, p: 20 },
    { id: 3, p: { a: 1, b: 2 } },
  ];
  const after = [
    { id: 2, p: 25 },
    { id: 3, p: { b: 2, a: 1 } },
    { id: 4, p: 40 },
  ];
  const delta = joinRows(before, after, { on: "id", delta: true });
  assert.deepEqual(delta.summary, { added: 1, removed: 1, changed: 1, unchanged: 1 });
  assert.deepEqual(delta.changed[0].fields, ["p"]);
  assert.equal(delta.removed[0].id, 1);
});

test("pipe transforms: filter by fields, dedupe, sort desc, limit, pick", () => {
  const rows = [
    { id: 1, s: "open", n: 2 },
    { id: 1, s: "open", n: 2 },
    { id: 2, s: "closed", n: 9 },
    { id: 3, s: "open", n: 5 },
  ];
  let out = pipeTransform(rows, { filter: { s: "open" } }, joinRows);
  out = pipeTransform(out, { dedupe: "id" }, joinRows);
  out = pipeTransform(out, { sort: { by: "n", desc: true } }, joinRows);
  out = pipeTransform(out, { limit: 1 }, joinRows);
  assert.deepEqual(plain(pipeTransform(out, { pick: ["id"] }, joinRows)), [{ id: 3 }]);
  assert.throws(() => pipeTransform(rows, { explode: 1 }, joinRows), /INVALID_INPUT/);
});

test("parse: CSV with quotes, newlines and BOM, typed cells and duplicate headers", () => {
  const text = '\ufeffname,qty,name\r\n"Smith, J",3,"a ""b"""\n"multi\nline",x,\n';
  assert.deepEqual(parseDelimited(text)[1], ["Smith, J", "3", 'a "b"']);
  const { format, rows } = parseFileText("orders.csv", text);
  assert.equal(format, "csv");
  assert.deepEqual(plain(rows), [
    { name: "Smith, J", qty: 3, name_2: 'a "b"' },
    { name: "multi\nline", qty: "x", name_2: null },
  ]);
});

test("parse: TSV, JSON, NDJSON, HTML tables and a clear error for XLSX/PDF", () => {
  assert.deepEqual(plain(parseFileText("a.tsv", "a\tb\n1\ttrue\n").rows), [{ a: 1, b: true }]);
  assert.deepEqual(parseFileText("a.json", '[{"x":1}]').rows, [{ x: 1 }]);
  assert.equal(parseFileText("a.ndjson", '{"x":1}\n\n{"x":2}\n').rows.length, 2);
  assert.throws(() => parseFileText("a.ndjson", '{"x":1}\nnope'), /line 2/);
  const html =
    "<script>x</script><table><tr><th>Name</th><th>Age</th></tr><tr><td>A &amp; B</td><td>4</td></tr></table>";
  assert.deepEqual(plain(parseFileText("t.html", html)), {
    format: "html",
    rows: [{ Name: "A & B", Age: 4 }],
    tables: 1,
  });
  assert.equal(parseFileText("guess", "k,v\n1,2").format, "csv");
  assert.throws(() => parseFileText("book.xlsx", ""), /UNSUPPORTED/);
  assert.throws(() => parseFileText("doc.pdf", ""), /UNSUPPORTED/);
});

test("parse paths: .. traversal, NUL and absolute paths outside the roots are refused", () => {
  assert.equal(confineFilePath("./data//a.csv"), "data/a.csv");
  for (const bad of [
    "../a.csv",
    "data/../../a",
    "a\\..\\..\\b",
    "/etc/passwd",
    "C:\\Windows\\x",
    "a\0b",
  ])
    assert.throws(() => confineFilePath(bad), /PATH_OUTSIDE_ROOT/, bad);
  assert.equal(
    confineFilePath("/home/u/Downloads/a.csv", ["/home/u/Downloads/"]),
    "/home/u/Downloads/a.csv",
  );
  assert.throws(
    () => confineFilePath("/home/u/Downloads2/a.csv", ["/home/u/Downloads"]),
    /PATH_OUTSIDE_ROOT/,
  );
  assert.equal(
    confineFilePath("c:\\Users\\u\\Downloads\\a.csv", ["C:\\Users\\u\\Downloads"]),
    "c:/Users/u/Downloads/a.csv",
  );
});

test("graft: match validation and the boost it saves as", () => {
  assert.equal(graftMatch(undefined, "https://news.example.com/x?y"), "news.example.com");
  assert.equal(graftMatch("*.Example.com", ""), "*.example.com");
  assert.equal(graftMatch("https://a.example.org/path", ""), "a.example.org");
  for (const bad of [
    "chrome://settings",
    "file:///etc",
    "javascript:alert(1)",
    "localhost",
    "a b.com",
  ])
    assert.throws(() => graftMatch(bad, ""), /INVALID_INPUT/, bad);
  assert.throws(() => graftMatch(undefined, "chrome://newtab/"), /INVALID_INPUT/);
  const boost = graftBoost({ id: "stars", js: "badge(data.n)", data: { n: 3 } }, "github.com");
  assert.equal(boost.id, "graft-stars");
  assert.deepEqual(boost.sites, ["github.com"]);
  assert.match(boost.js, /var data=Object\.freeze\(\{"n":3\}\)/);
  assert.throws(() => graftBoost({}, "a.com"), /needs css, js or widgets/);
  assert.throws(() => graftBoost({ id: "../x", css: "a{}" }, "a.com"), /graft id/);
});

function sandbox({ downloads = [], files = {}, boosts = [] } = {}) {
  const calls = [];
  const inspected = [];
  const saved = new Map(boosts.map((boost) => [boost.id, boost]));
  const page = {
    url: () => "https://shop.example.com/cart",
    inspect: async (fn, arg) => (
      inspected.push(fn.name || "fn"),
      { applied: true, removed: false, arg }
    ),
    evaluate: async (fn, arg) => ({ evaluated: arg }),
    downloads: { list: async () => downloads },
    download: async (target) => ({ downloaded: target }),
  };
  const context = vm.createContext({
    setTimeout,
    URL,
    __helpTopics: {},
    ringScrub: (text) => text.replace(/sk_live_\w+/g, "[redacted]"),
    __siteBase: { run: async (name) => "ran " + name },
    __siteL2: {
      call: async (host, op, params) => (
        calls.push([host, op, params]),
        op === "users" ? users : orders
      ),
    },
    site: {},
    browser: {
      page: () => page,
      boosts: {
        save: async (boost) => (saved.set(boost.id, boost), boost),
        list: async () => [...saved.values()],
        remove: async (id) => saved.delete(id),
      },
    },
    __call: async (request) => {
      calls.push(request);
      if (request.workspace === "read") return { data: { text: files[request.name] } };
      return {};
    },
    artifact: async (name, value) => calls.push({ artifact: name, value }),
  });
  vm.runInContext(browserDemoClawsApi, context);
  const extended = vm.runInContext("__extendPageDemoClaws", context)("t1", page);
  return { page: extended, context, calls, inspected, saved };
}

test("extending the page touches nothing: ST-6 clean at rest", () => {
  const { page, calls, inspected } = sandbox();
  for (const name of ["graft", "cache", "download", "feed", "editor"]) assert.ok(page[name]);
  assert.equal(typeof page.downloads.parse, "function");
  assert.equal(typeof page.download, "function", "page.download(target) still works");
  assert.deepEqual(calls, []);
  assert.deepEqual(inspected, []);
});

test("page.graft persists through boosts, lists only grafts and removes by id", async () => {
  const { page, saved, inspected } = sandbox({ boosts: [{ id: "dark", name: "dark" }] });
  const out = await page.graft.apply({ id: "price", css: ".price{color:red}" });
  assert.deepEqual(plain(out), { id: "graft-price", host: "shop.example.com", persisted: true });
  assert.deepEqual(
    inspected,
    ["graftLive"],
    "a css graft for this site shows now, not after a reload",
  );
  assert.deepEqual(plain(saved.get("graft-price").sites), ["shop.example.com"]);
  assert.deepEqual(
    plain(await page.graft.list({})).map((g) => g.id),
    ["graft-price"],
  );
  assert.equal((await page.graft.remove("price")).removed, true);
  assert.equal(saved.has("graft-price"), false);
  const live = await page.graft.apply({ id: "tmp", css: "a{}", persist: false });
  assert.equal(live.persisted, false);
  await assert.rejects(page.graft.apply({ js: "x()", persist: false }), /must persist/);
});

test("site.pipe runs site calls and transforms with zero model calls, then a sink", async () => {
  const { context, calls } = sandbox();
  const result = await vm.runInContext(
    `site.pipe([
      {call: ['ex.com', 'users']},
      {join: {with: {call: ['ex.com', 'orders']}, on: ['id', 'userId'], type: 'left'}},
      {map: (r) => ({name: r.name, total: r.total ?? 0})},
      {sort: {by: 'total', desc: true}},
      {to: 'out.json'},
    ])`,
    context,
  );
  assert.equal(result.models, 0);
  assert.deepEqual(plain(result.rows)[0], { name: "Ada", total: 10 });
  assert.deepEqual(plain(result.steps.map((s) => s.step)), ["call", "join", "map", "sort", "to"]);
  assert.equal(calls.filter((c) => Array.isArray(c)).length, 2);
  assert.equal(calls.at(-1).artifact, "out.json");
  assert.equal(await vm.runInContext("site.myAbility()", context), "ran myAbility");
  assert.equal(vm.runInContext("browser.join([{a:1}], [{a:1, b:2}], {on: 'a'})[0].b", context), 2);
  await assert.rejects(vm.runInContext("site.pipe([])", context), /INVALID_INPUT/);
});

test("page.download.parse confines paths before reading and parses the latest download", async () => {
  const { page, calls } = sandbox({
    downloads: [{ filename: "/dl/a.csv", state: "complete" }],
    files: { "/dl/a.csv": "a,b\n1,2\n", "data/x.json": "[1,2]" },
  });
  await assert.rejects(page.download.parse("../../etc/passwd"), /PATH_OUTSIDE_ROOT/);
  await assert.rejects(page.download.parse(), /PATH_OUTSIDE_ROOT/, "a download outside the roots");
  assert.equal(calls.length, 0, "nothing is read before the path is confined");
  assert.deepEqual(plain((await page.download.parse(undefined, { roots: ["/dl"] })).rows), [
    { a: 1, b: 2 },
  ]);
  assert.deepEqual(plain((await page.download.parse("data/x.json")).rows), [1, 2]);
  assert.deepEqual(plain((await page.download.parse({ text: "k\n7", name: "n.csv" })).rows), [
    { k: 7 },
  ]);
});

// A fake virtualized list: 25 items, 10 drawn at a time, a window that moves by 4 rows a scroll.
function fakeFeed(total = 25, rowsPerView = 10, dupes = false) {
  const state = { top: 0 };
  const el = (index) => ({
    innerText: "item " + (dupes ? index % 12 : index),
    getAttribute: (name) => (name === "data-id" && !dupes ? "i" + index : null),
    querySelector: () => null,
    contains: (other) => other === null,
    id: "",
  });
  const container = {
    get scrollTop() {
      return state.top;
    },
    set scrollTop(value) {
      state.top = Math.min(value, (total - rowsPerView) * 40);
    },
    clientHeight: 200,
    scrollHeight: total * 40,
    dispatchEvent: () => true,
    querySelectorAll: () => {
      const first = Math.floor(state.top / 40);
      return Array.from({ length: Math.min(rowsPerView, total - first) }, (_, i) => el(first + i));
    },
  };
  const document = { querySelector: (sel) => (sel === "#feed" ? container : null) };
  return vm.createContext({ document, Event: class {}, globalThis: {} });
}
const runIn = (context, fn, arg) =>
  vm.runInContext("(" + fn.toString() + ")(" + JSON.stringify(arg) + ")", context);

test("feed collect: dedupes by id, stops on the end plateau, limit and until", async () => {
  const feed = fakeFeed();
  const { page } = sandbox();
  page.inspect = async (fn, arg) => runIn(feed, fn, arg);
  const all = await page.feed.collect({ container: "#feed", waitMs: 0, plateau: 2 });
  assert.equal(all.items.length, 25);
  assert.equal(new Set(all.items.map((i) => i.key)).size, 25);
  assert.equal(all.exhausted, true);
  assert.ok(all.totalSeen > 25);
  const page2 = sandbox().page;
  const feed2 = fakeFeed();
  page2.inspect = async (fn, arg) => runIn(feed2, fn, arg);
  const limited = await page2.feed.collect({ container: "#feed", limit: 12, waitMs: 0 });
  assert.equal(limited.items.length, 12);
  assert.equal(limited.stopped, "limit");
  const page3 = sandbox().page;
  const feed3 = fakeFeed(25, 10, true);
  page3.inspect = async (fn, arg) => runIn(feed3, fn, arg);
  const hashed = await page3.feed.collect({
    container: "#feed",
    waitMs: 0,
    until: (items) => items.length >= 5,
  });
  assert.equal(hashed.stopped, "until");
  assert.ok(hashed.items.every((i) => i.key.startsWith("h:")));
  const page4 = sandbox().page;
  page4.inspect = async (fn, arg) => runIn(fakeFeed(), fn, arg);
  await assert.rejects(page4.feed.collect({ container: "#nope" }), /NOT_FOUND/);
  assert.equal(typeof feedStep, "function");
});

function editorDom(kind) {
  const events = [];
  const node = {
    tagName: "DIV",
    id: "ed",
    className: "",
    value: "hello",
    textContent: "hello",
    innerText: "hello",
    dispatchEvent: (event) => events.push(event.type),
    focus: () => {},
    closest: () => null,
    contains: () => true,
    matches: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  let doc = "hello";
  if (kind === "codemirror") {
    node.cmView = {
      view: {
        state: {
          doc: {
            toString: () => doc,
            get length() {
              return doc.length;
            },
          },
        },
        dispatch: ({ changes }) => {
          doc = doc.slice(0, changes.from) + changes.insert + doc.slice(changes.to ?? changes.from);
        },
      },
    };
  }
  const selectors = {
    codemirror: ".cm-editor",
    prosemirror: ".ProseMirror",
    textarea: "textarea,input[type=text],input:not([type])",
  };
  const document = {
    activeElement: null,
    body: {},
    querySelector: (sel) => (sel === selectors[kind] ? node : null),
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: (cmd, _ui, text) => {
      node.innerText = node.textContent = node.textContent + text;
      return cmd === "insertText";
    },
  };
  class InputEvent {
    constructor(type) {
      this.type = type;
    }
  }
  const context = vm.createContext({
    document,
    InputEvent,
    Event: InputEvent,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  });
  context.globalThis = context;
  return { context, node, events, read: () => doc };
}

test("editor: detects, reads and writes CodeMirror, ProseMirror and textarea", () => {
  const cm = editorDom("codemirror");
  assert.equal(runIn(cm.context, editorDetect, {}).kind, "codemirror");
  assert.equal(runIn(cm.context, editorDetect, { op: "insert", text: "!" }).length, 6);
  assert.equal(cm.read(), "hello!");
  runIn(cm.context, editorDetect, { op: "replace", text: "new" });
  assert.deepEqual(plain(runIn(cm.context, editorDetect, { op: "read" }).lines), ["new"]);

  const pm = editorDom("prosemirror");
  assert.equal(
    runIn(pm.context, editorDetect, { op: "insert", text: " world" }).kind,
    "prosemirror",
  );
  assert.equal(pm.node.textContent, "hello world");

  const ta = editorDom("textarea");
  runIn(ta.context, editorDetect, { op: "replace", text: "typed" });
  assert.equal(ta.node.value, "typed");
  assert.deepEqual(ta.events, ["input", "change"]);
  assert.equal(runIn(editorDom("none").context, editorDetect, {}).kind, null);
});

test("cache read: filters by name, url regex and type, parses JSON, bounds size", async () => {
  const entry = (url, type, body) => ({
    request: { url, method: "GET" },
    response: {
      status: 200,
      headers: { get: (name) => (name === "content-type" ? type : null) },
      clone: () => ({ text: async () => body }),
    },
  });
  const stores = {
    "api-v1": [
      entry("https://x.test/api/a", "application/json", '{"a":1}'),
      entry("https://x.test/api/big", "application/json", "[" + "1,".repeat(500) + "1]"),
      entry("https://x.test/app.css", "text/css", "body{}"),
    ],
    fonts: [entry("https://x.test/f.woff2", "font/woff2", "")],
  };
  const caches = {
    keys: async () => Object.keys(stores),
    open: async (name) => ({
      keys: async () => stores[name].map((e) => e.request),
      match: async (request) => stores[name].find((e) => e.request === request).response,
    }),
  };
  const context = vm.createContext({ caches, location: { origin: "https://x.test" } });
  context.globalThis = context;
  const read = (arg) => runIn(context, cacheRead, arg);
  const json = await read({ cacheName: "api", url: ["/api/", ""], maxBytes: 100 });
  assert.deepEqual(json.caches, ["api-v1", "fonts"]);
  assert.deepEqual(plain(json.entries[0].json), { a: 1 });
  assert.equal(json.entries[1].truncated, true);
  assert.equal(json.entries[1].json, undefined);
  assert.equal((await read({ contentType: "css" })).entries[0].text, "body{}");
  assert.equal((await read({ limit: 1 })).entries.length, 1);
  const none = vm.createContext({ location: { origin: "o" } });
  none.globalThis = none;
  assert.match((await runIn(none, cacheRead, {})).error, /UNSUPPORTED/);
});

test("page.cache.read passes RegExp urls through and scrubs secrets", async () => {
  const { page } = sandbox();
  let seen;
  page.inspect = async (_fn, arg) => (
    (seen = arg),
    { entries: [{ url: "u", json: { token: "abc", note: "key sk_live_123" } }] }
  );
  const out = await page.cache.read({ url: /api\/v\d/i });
  assert.deepEqual(plain(seen.url), ["api\\/v\\d", "i"]);
  assert.deepEqual(plain(out.entries[0].json), { token: "[redacted]", note: "key [redacted]" });
});
