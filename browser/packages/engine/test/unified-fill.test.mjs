// The indexed locator fill has one write path (the engine's verified fill) and picks the copy on
// screen. The real-Chrome half lives in browser/test/unified-fill.e2e.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { browserPlaywrightApi } from "../dist/code-api-playwright.js";

function pageFunction(name) {
  const start = browserPlaywrightApi.indexOf(`function ${name}(`);
  const end = browserPlaywrightApi.indexOf("\nasync function ", start);
  return browserPlaywrightApi.slice(start, end);
}

// A page-side pick against fake elements: rect is where scrollIntoView leaves them.
function pick(elements, arg) {
  const source = pageFunction("__pickInPage");
  const run = new Function(
    "getComputedStyle",
    "innerWidth",
    "innerHeight",
    `${source}; return __pickInPage;`,
  )((el) => el.style, 800, 600);
  return run(elements, arg);
}
function el(rect, style = {}) {
  const attrs = {};
  return {
    attrs,
    style: { visibility: "visible", display: "block", ...style },
    getBoundingClientRect: () => ({ ...rect, left: rect.x, top: rect.y }),
    scrollIntoView: () => {},
    setAttribute: (name, value) => (attrs[name] = value),
  };
}

test("indexed fill has no bespoke keyboard path", () => {
  assert.doesNotMatch(browserPlaywrightApi, /keyboard\('ControlOrMeta\+a'\)/);
  assert.match(browserPlaywrightApi, /fill: \(value, options\) => __fillIndexed\(/);
  assert.match(browserPlaywrightApi, /finally \{[^}]*removeAttribute\("data-graft-pick"\)/);
});

test("first() picks the on-screen copy over a transformed duplicate", () => {
  const header = el({ x: 10, y: -713, width: 95, height: 16 });
  const visible = el({ x: 10, y: 208, width: 95, height: 16 });
  const box = pick([header, visible], { index: 0, visibleFirst: true, nonce: "n1" });
  assert.deepEqual(box, { x: 57.5, y: 216 });
  assert.equal(visible.attrs["data-graft-pick"], "n1");
  assert.equal(header.attrs["data-graft-pick"], undefined);
});

test("an element stuck off-screen reports offscreen, a collapsed one hidden", () => {
  const stuck = el({ x: 10, y: -500, width: 95, height: 16 });
  assert.deepEqual(pick([stuck], { index: 0, visibleFirst: true }), {
    hidden: true,
    offscreen: true,
  });
  const collapsed = el({ x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(pick([collapsed], { index: 0, visibleFirst: true }), {
    hidden: true,
    offscreen: false,
  });
  // nth(i) is that match only: an off-screen one is never swapped for another.
  const shown = el({ x: 10, y: 10, width: 10, height: 10 });
  assert.equal(pick([shown, stuck], { index: 1, visibleFirst: false }).offscreen, true);
  assert.throws(() => pick([], { index: 0, visibleFirst: true }), /TARGET_NOT_FOUND/);
});

test("off-screen pick is TARGET_HIDDEN, never a pointer schema error", () => {
  const source = pageFunction("__pickIndexed");
  assert.match(source, /TARGET_HIDDEN: the element stays off-screen/);
});
