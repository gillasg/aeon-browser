// The hand-off ask sits beside the cursor but never leaves the viewport: near the right or bottom
// edge it flips to the cursor's left or above it, inside a 12px margin.
import assert from "node:assert/strict";
import test from "node:test";
import { showAsk } from "../dist/native-browser-ask.js";

function node() {
  return {
    style: {},
    children: [],
    setAttribute() {},
    addEventListener() {},
    dispatchEvent() {},
    remove() {},
    append(...kids) {
      this.children.push(...kids);
    },
    attachShadow() {
      return node();
    },
    getBoundingClientRect: () => ({ width: 340, height: 40 }),
  };
}

function place(point, width = 1280, height = 720) {
  let host;
  globalThis.window = { innerWidth: width, innerHeight: height, addEventListener() {} };
  globalThis.document = {
    getElementById: () => null,
    createElement: () => {
      const made = node();
      host ??= made;
      return made;
    },
    documentElement: node(),
  };
  showAsk({ style: "", tabId: 1, point });
  return { left: parseFloat(host.style.left), top: parseFloat(host.style.top) };
}

test("beside the cursor when there is room", () => {
  assert.deepEqual(place({ x: 100, y: 100 }), { left: 114, top: 144 });
});

test("flips left of the cursor at the right edge and stays inside the margin", () => {
  const { left } = place({ x: 1270, y: 100 });
  assert.equal(left, 1270 - 14 - 340);
  assert.ok(left + 340 <= 1280 - 12);
});

test("flips above the cursor at the bottom edge", () => {
  const { top } = place({ x: 100, y: 700 });
  assert.equal(top, 700 - 20 - 40);
  assert.ok(top + 40 <= 720 - 12);
});

test("a viewport narrower than the card still keeps the 12px margin", () => {
  const { left, top } = place({ x: 5, y: 5 }, 300, 50);
  assert.equal(left, 12);
  assert.equal(top, 12);
});
