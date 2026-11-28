import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const block = (css, selector) => css.slice(css.indexOf(selector + " {")).split("}")[0];

test("the box keeps one 18px shape and no background dots", () => {
  const orb = read("orb.css");
  const ink = read("orb-ink.css");
  assert.match(block(orb, ".island"), /border-radius: 18px;/);
  assert.doesNotMatch(block(orb, ".island"), /r-full|999px/);
  assert.doesNotMatch(ink, /\.island::before/);
  assert.doesNotMatch(ink, /border-radius: 24px/);
});

test("the typing row has no dots and the panel button is ☰", () => {
  const view = read("src/orb/orb-view.tsx");
  assert.doesNotMatch(view, /<InkDots/);
  assert.match(view, /panel: "M3 4\.5h10M3 8h10M3 11\.5h10"/);
});

test("the working pill uses the 2x2 ink wave and no grab hand or tooltip", () => {
  const overlay = read("src/orb/orb-overlay.ts");
  const style = read("src/orb/orb-overlay-style.ts");
  assert.doesNotMatch(overlay, /this\.hit\.title/);
  assert.match(overlay, /spin ink-dots/);
  assert.match(style, /grid-template-columns: 3px 3px; gap: 3px/);
  assert.match(style, /@keyframes ink-wave/);
  assert.doesNotMatch(style, /cursor: grab|ink-breathe/);
  assert.match(
    style,
    /:host\(\[data-run\]\) \.hit, :host\(\[data-open\]\) \.hit \{ display: none; \}/,
  );
});

test("working hides context chips and finished runs re-expand the box in place", () => {
  const ink = read("orb-ink.css");
  const overlay = read("src/orb/orb-overlay.ts");
  assert.match(ink, /\.island\[data-state="working"\] \.isl-context/);
  assert.match(
    overlay,
    /const expandAnswer = \(state === "done" \|\| state === "error"\) && wasRunning;/,
  );
  assert.match(
    overlay,
    /if \(\(state === "needs" \|\| expandAnswer\) && !this\.open\) this\.showBubble\(false\);/,
  );
  const cursorPage = read("../../browser/packages/engine/src/cursor-page.ts");
  assert.match(
    cursorPage,
    /function applySummon[\s\S]*state\.cursorShown = true;\s*state\.cursor\.style\.opacity = "1";/,
  );
});
