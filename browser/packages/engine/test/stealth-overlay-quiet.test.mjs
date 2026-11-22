import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const built = readFileSync(
  new URL("../dist/native-browser-navigation.js", import.meta.url),
  "utf8",
);
const probe = built.slice(
  built.indexOf("function domQuietProbe()"),
  built.indexOf("async function showingDocument"),
);

class Node {}
class Element extends Node {
  constructor(attrs = {}, children = 0) {
    super();
    this.attrs = attrs;
    this.childNodes = Array.from({ length: children }, () => new Node());
    this.shadowRoot = null;
  }
  get attributes() {
    return Object.keys(this.attrs);
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  matches(selector) {
    return selector.includes("data-aeon-overlay") && "data-aeon-overlay" in this.attrs;
  }
  closest(selector) {
    return this.matches(selector) ? this : null;
  }
}
class HTMLDivElement extends Element {
  constructor(attrs, style = {}, children) {
    super(attrs, children);
    this.style = { ...style, getPropertyValue: (side) => style[side] ?? "" };
  }
}
class HTMLInputElement extends Element {}
class HTMLTextAreaElement extends Element {}

const HOST_STYLE = {
  position: "fixed",
  top: "0px",
  right: "0px",
  bottom: "0px",
  left: "0px",
  zIndex: "2147483647",
  pointerEvents: "none",
};
const css = "position: fixed; inset: 0px; z-index: 2147483647; pointer-events: none;";

function harness() {
  let callback;
  const html = new Element();
  const context = vm.createContext({
    Node,
    Element,
    HTMLDivElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    WeakMap,
    Math,
    performance: { now: () => 1000 },
    location: { href: "https://example.test/" },
    MutationObserver: class {
      constructor(fn) {
        callback = fn;
      }
      observe() {}
    },
  });
  context.window = context;
  context.document = { readyState: "complete", activeElement: null, addEventListener() {} };
  vm.runInContext(`${probe}; domQuietProbe();`, context);
  const changes = () => vm.runInContext("domQuietProbe().changes", context);
  const added = (node) => ({
    type: "childList",
    target: html,
    addedNodes: [node],
    removedNodes: [],
  });
  const removed = (node) => ({
    type: "childList",
    target: html,
    addedNodes: [],
    removedNodes: [node],
  });
  return { feed: (records) => callback(records), changes, added, removed, html };
}

test("mounting, raising and removing the unmarked cursor-controls host counts no change", () => {
  const h = harness();
  const host = new HTMLDivElement({ style: css }, HOST_STYLE);
  h.feed([h.added(host)]);
  h.feed([h.removed(host), h.added(host)]);
  h.feed([h.removed(host)]);
  assert.equal(h.changes(), 0);
  assert.deepEqual(host.attributes, ["style"]);
});

test("the unmarked agent cursor host (contain:strict) counts no change either", () => {
  const h = harness();
  const host = new HTMLDivElement(
    { style: `${css} contain: strict;` },
    { ...HOST_STYLE, contain: "strict" },
  );
  h.feed([h.added(host), h.removed(host)]);
  assert.equal(h.changes(), 0);
});

test("real page mutations still count", () => {
  const h = harness();
  h.feed([h.added(new HTMLDivElement({ class: "modal" }, { position: "fixed" }, 2))]);
  h.feed([h.added(new HTMLDivElement({ style: css, id: "toast" }, HOST_STYLE))]);
  h.feed([h.added(new HTMLDivElement({ style: css }, HOST_STYLE, 1))]);
  h.feed([h.added(new HTMLDivElement({ style: "position: fixed;" }, { position: "fixed" }))]);
  h.feed([{ type: "characterData", target: new Node(), addedNodes: [], removedNodes: [] }]);
  const toggled = new Element({ class: "open" });
  h.feed([
    {
      type: "attributes",
      target: toggled,
      attributeName: "class",
      oldValue: "",
      addedNodes: [],
      removedNodes: [],
    },
  ]);
  assert.equal(h.changes(), 6);
});
