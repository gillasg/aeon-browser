import assert from "node:assert/strict";
import test from "node:test";
import { cursorFunctionSource, cursorVisible } from "../dist/cursor-page.js";

// The cursor's host is removed from the page when nothing of it is on screen, so an idle tab
// carries no DOM of ours. The page's own copy of that decision is this function, inlined by source.
test("nothing shown means the cursor leaves the page", () => {
  assert.equal(cursorVisible({}), false);
  assert.equal(cursorVisible({ cursorShown: false, opacity: "1" }), false);
  assert.equal(cursorVisible({ cursorShown: true, opacity: "0" }), false);
});

test("a drawn cursor, a glow, a pill or a hand-off keeps the host", () => {
  assert.equal(cursorVisible({ cursorShown: true, opacity: "1" }), true);
  assert.equal(cursorVisible({ glow: true }), true);
  assert.equal(cursorVisible({ pill: true }), true);
  assert.equal(cursorVisible({ spotlight: true }), true);
  assert.equal(cursorVisible({ callout: true }), true);
  assert.equal(cursorVisible({ keys: true }), true);
  assert.equal(cursorVisible({ needs: true }), true);
});

test("the page painter uses that decision and removes its host", () => {
  const source = cursorFunctionSource();
  assert.match(source, /cursorVisible\(\{/);
  assert.match(source, /host\.remove\(\)/);
  assert.match(source, /restSoon/);
});
