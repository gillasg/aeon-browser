import assert from "node:assert/strict";
import test from "node:test";
import { inputStepEffect, refusedEffect, scrollEffect } from "../dist/native-browser-effect.js";

// What an input step caused, as a closed value: confirmed needs readback, a step that ran
// without evidence is unverifiable, a bounded unchanged state is a suspected no-op.

test("a navigation or a DOM change confirms a click, with the evidence that showed it", () => {
  assert.deepEqual(inputStepEffect("click", { outcome: "navigated", url: "https://b.test/" }), {
    effect: "confirmed",
    evidence: "navigation to https://b.test/",
  });
  assert.deepEqual(inputStepEffect("click", { outcome: "changed", changes: 3 }), {
    effect: "confirmed",
    evidence: "3 DOM changes after click",
  });
  assert.deepEqual(inputStepEffect("click", { outcome: "changed", changes: 1 }), {
    effect: "confirmed",
    evidence: "1 DOM change after click",
  });
  assert.deepEqual(inputStepEffect("click", { outcome: "changed" }), {
    effect: "confirmed",
    evidence: "DOM changed after click",
  });
});

test("a fill with its value read back is confirmed even when nothing else changed", () => {
  assert.deepEqual(inputStepEffect("fill", { outcome: "changed", readback: "query" }, "query"), {
    effect: "confirmed",
    evidence: 'value read back: "query"',
  });
  assert.deepEqual(inputStepEffect("fill", { outcome: "changed", readback: "other" }, "query"), {
    effect: "unverifiable",
    evidence: 'value read back differs: "other"',
  });
});

test("an unchanged click is a suspected no-op; a request without a visible change is not", () => {
  assert.deepEqual(inputStepEffect("click", { outcome: "unchanged" }), {
    effect: "suspected_noop",
    evidence: "no navigation, DOM change or request after click",
  });
  assert.deepEqual(inputStepEffect("click", { outcome: "unchanged", requests: 1 }), {
    effect: "unverifiable",
    evidence: "1 request after click, no visible change",
  });
  assert.deepEqual(inputStepEffect("press", { outcome: "unknown" }), {
    effect: "unverifiable",
    evidence: "the page could not be read after the step",
  });
});

test("a refused step carries its code, and evidence stays short", () => {
  assert.deepEqual(refusedEffect("TARGET_DISABLED"), {
    effect: "refused",
    evidence: "TARGET_DISABLED",
  });
  const long = inputStepEffect("click", {
    outcome: "navigated",
    url: "https://a.test/" + "x".repeat(400),
  });
  assert.ok(long.evidence.length <= 200, String(long.evidence.length));
});

test("a scroll's own offset is its readback", () => {
  assert.deepEqual(scrollEffect({ direction: "down", moved: true, position: 640 }), {
    effect: "confirmed",
    evidence: "scrolled down to 640px",
  });
  assert.deepEqual(scrollEffect({ direction: "up", moved: false, position: 0 }), {
    effect: "suspected_noop",
    evidence: "scroll up did not move the page (at the boundary)",
  });
});
