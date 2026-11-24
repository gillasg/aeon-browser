// A modal over <main inert> (or aria-hidden): the modal's controls are the page, and the
// snapshot says it is scoped to body. Iframes outside main are named by origin.
import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticNodes } from "../dist/native-browser-observation.js";
import { buildSemanticTree } from "../dist/observe/tree.js";
import { renderState } from "../dist/observe/render.js";
import { usableMain, unusableMainIds, mainScopeNote } from "../dist/observe/usable-main.js";

let seq = 0;
function el(role, name, children = [], extra = {}) {
  const nodeId = `n${++seq}`;
  const self = {
    nodeId,
    backendDOMNodeId: 2000 + seq,
    role: { value: role },
    name: { value: name },
  };
  if (extra.properties) self.properties = extra.properties;
  if (extra.frameId) self.frameId = extra.frameId;
  if (extra.frameOwner) self.frameOwner = extra.frameOwner;
  const flat = [self];
  for (const subtree of children) {
    const [head, ...rest] = subtree;
    flat.push({ ...head, parentId: nodeId }, ...rest);
  }
  return flat;
}
const prop = (name, value) => ({ name, value: { value } });

function build(ax, frameUrls) {
  const semantic = createSemanticNodes(ax);
  const clickables = [{ backendNodeId: 9999, text: "Accept cookies", offscreen: false }];
  return buildSemanticTree({
    ax,
    shown: semantic.nodes,
    url: "https://shop.example/",
    clickables,
    ...(frameUrls ? { frameUrls } : {}),
  });
}

function modalPage(mainProps) {
  return el("RootWebArea", "Shop", [
    el("main", "", [el("button", "Buy now")], { properties: mainProps }),
    el("dialog", "Cookies", [el("button", "Accept all")]),
  ]);
}

test("inert-main: clickables are not parented under an inert main; the scope is body", () => {
  const ax = modalPage([prop("inert", true)]);
  const tree = build(ax);
  assert.equal(usableMain(tree.nodes, ax), undefined);
  assert.equal(unusableMainIds(ax).size, 1);
  const clickable = tree.nodes.find((node) => node.role === "clickable");
  assert.equal(clickable.parentAxId, undefined, "not under the inert main");
  assert.equal(tree.scopeNote, "Scoped to body: main is inert or hidden behind a dialog");
  const view = renderState(tree, { budget: 8000 });
  assert.match(view, /Accept all/);
});

test("aria-hidden main is treated like an inert one", () => {
  const ax = modalPage([prop("hidden", true)]);
  const tree = build(ax);
  assert.equal(usableMain(tree.nodes, ax), undefined);
  assert.match(tree.scopeNote, /Scoped to body/);
});

test("a main inside an inert ancestor is not usable either", () => {
  const ax = el("RootWebArea", "Shop", [
    el("generic", "", [el("main", "", [el("button", "Buy")])], {
      properties: [prop("inert", true)],
    }),
  ]);
  assert.equal(unusableMainIds(ax).size, 1);
});

test("a live main still scopes clickables, and outside iframes are named by origin", () => {
  const ax = el(
    "RootWebArea",
    "Shop",
    [
      el("main", "", [el("button", "Buy now")]),
      el("Iframe", "Payment", [], { frameOwner: "F2" }),
      el("Iframe", "", [], { frameOwner: "F3" }),
    ],
    { frameId: "F1" },
  );
  const urls = new Map([
    ["F2", "https://checkout.example.com/pay"],
    ["F3", "https://www.youtube.com/embed/x"],
  ]);
  const tree = build(ax, urls);
  const main = usableMain(tree.nodes, ax);
  assert.ok(main);
  assert.equal(tree.nodes.find((node) => node.role === "clickable").parentAxId, main.axId);
  assert.equal(
    tree.scopeNote,
    'Scoped to main; outside it: 2 iframes (checkout.example.com "Payment", youtube.com)',
  );
});

test("no note when nothing is left out", () => {
  assert.equal(mainScopeNote("main", false, []), undefined);
  assert.equal(mainScopeNote("body", false, []), undefined);
});
