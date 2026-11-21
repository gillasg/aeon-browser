import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserDataApi } from "../dist/code-api-data.js";
import { browserSitesApi } from "../dist/code-api-sites.js";
import { createSemanticNodes, filterVisibleTextNodes } from "../dist/native-browser-observation.js";
import { renderState } from "../dist/observe/render.js";
import { buildSemanticTree } from "../dist/observe/tree.js";

let seq = 0;
function el(role, name, children = [], extra = {}) {
  const nodeId = `n${++seq}`;
  return {
    nodeId,
    backendDOMNodeId: extra.backend ?? 1000 + seq,
    role: { value: role },
    name: { value: name },
    childIds: children.map((child) => child.nodeId),
    _children: children,
  };
}

function flatten(root) {
  const out = [];
  const walk = (node) => {
    const { _children, ...rest } = node;
    out.push(rest);
    for (const child of _children ?? []) walk(child);
  };
  walk(root);
  return out;
}

function render(root, options = {}) {
  const ax = flatten(root);
  const visible = ax
    .map((node) => node.name?.value)
    .filter(Boolean)
    .join("\n");
  const filtered = filterVisibleTextNodes(ax, visible);
  const semantic = createSemanticNodes(filtered, options.query ? { query: options.query } : {});
  const tree = buildSemanticTree({
    ax,
    shown: semantic.nodes,
    url: "http://127.0.0.1:3773/settings",
    title: "Settings",
  });
  const view = renderState(tree, {
    budget: 8000,
    ...(options.query ? { focus: options.query } : {}),
  });
  return { view, nodes: semantic.nodes };
}

test("space-separated query words fall back to OR when no exact phrase matches", () => {
  seq = 0;
  const ax = el("RootWebArea", "Settings", [
    el("main", "", [
      el("button", "Models", [], { backend: 1 }),
      el("button", "Providers", [], { backend: 2 }),
      el("button", "Billing", [], { backend: 3 }),
    ]),
  ]);
  const { view } = render(ax, { query: "model provider" });
  assert.match(view, /button "Models"/);
  assert.match(view, /button "Providers"/);
  assert.doesNotMatch(view, /button "Billing"/);
  assert.doesNotMatch(view, /0 of \d+ elements match/);
});

test("exact phrase match still wins before word-split fallback", () => {
  seq = 0;
  const ax = el("RootWebArea", "Auth", [
    el("main", "", [
      el("button", "Sign in", [], { backend: 1 }),
      el("button", "Inbox", [], { backend: 2 }),
      el("button", "Sign up", [], { backend: 3 }),
    ]),
  ]);
  const { view } = render(ax, { query: "Sign in" });
  assert.match(view, /button "Sign in"/);
  assert.doesNotMatch(view, /button "Inbox"/);
  assert.doesNotMatch(view, /button "Sign up"/);
});

test("__siteHost keeps host:port for loopback and strips www for web hosts", () => {
  const ctx = vm.createContext({
    URL,
    __call: () => Promise.resolve({}),
    console: { warn() {}, log() {}, error() {}, info() {}, debug() {} },
  });
  vm.runInContext(browserSitesApi, ctx);
  assert.equal(vm.runInContext(`__siteHost("http://127.0.0.1:3773/app")`, ctx), "127.0.0.1:3773");
  assert.equal(
    vm.runInContext(`__siteHost("http://127.0.0.1:41234/shop")`, ctx),
    "127.0.0.1:41234",
  );
  assert.equal(vm.runInContext(`__siteHost("http://localhost:3000/x")`, ctx), "localhost:3000");
  assert.equal(vm.runInContext(`__siteHost("https://www.example.com/a")`, ctx), "example.com");
});

test("page.read falls back to accessibility state text when SPA dialog markdown is near empty", async () => {
  const ctx = vm.createContext({
    URL,
    Map,
    __key: () => "t1",
    __tabs: new Map([["t1", { url: "http://127.0.0.1:3773/settings" }]]),
    __noteRead: () => undefined,
    __call: () => Promise.resolve(null),
    __throttlePage: () => "",
    __readScrollers: () => Promise.resolve([]),
    __readEmbedded: () => Promise.resolve([]),
    __collectList: () => Promise.resolve(null),
    artifact: () => Promise.resolve(null),
    console: { warn() {}, log() {}, error() {}, info() {}, debug() {} },
  });
  vm.runInContext(browserDataApi, ctx);
  const dialogState =
    '127.0.0.1:3773/settings · Settings\ndialog "Provider Settings"\n  [1] textbox "API Key"\n  [2] button "Save settings"';
  const base = {
    inspect: async (fn) => {
      const text = String(fn);
      if (text.includes("document.title")) return "Settings";
      if (text.includes("location.href")) return "http://127.0.0.1:3773/settings";
      if (text.includes("__expandRead")) return { clicked: [], skipped: [] };
      if (text.includes("__waitRead")) return { settled: true };
      if (text.includes("__readMarkdown"))
        return { markdown: "# Settings", partial: false, notes: [], chars: 10 };
      if (text.includes("__readPageData")) return { notes: [], partial: false };
      return null;
    },
    state: async () => dialogState,
  };
  ctx.__testBase = base;
  const result = await vm.runInContext(
    `__extendPageData({tabId: 1}, __testBase).read({expand: false, scrollers: false, frames: false})`,
    ctx,
  );
  assert.match(result.text, /Provider Settings/);
  assert.match(result.text, /Save settings/);
  assert.ok(result.notes.some((note) => /accessibility text/.test(note)));
});
