// The stealth bench's own pieces, offline: its cells print one RESULT line, detectors are unique,
// and a probe report turns into summary lines. The bench itself opens real sites and runs by hand.
import assert from "node:assert/strict";
import test from "node:test";
import { DETECTORS, SWEEP, detectorCode, probeCode, probeLines, sweepCode } from "./stealth/run.mjs";

test("every stealth cell prints one RESULT line and closes its tab", () => {
  for (const code of [probeCode("http://127.0.0.1:1/"), detectorCode(DETECTORS[0]), sweepCode(SWEEP[0])]) {
    assert.equal(code.match(/console\.log\("RESULT "/g)?.length, 1, code);
    assert.match(code, /await page\.close\(\);$/);
    new Function(`return async () => { let page; ${code} }`);
  }
});

test("detectors and sweep sites are unique", () => {
  assert.equal(new Set(DETECTORS.map((site) => site.id)).size, DETECTORS.length);
  assert.equal(new Set(SWEEP).size, SWEEP.length);
});

test("a probe report names its tells, and a missing one says so", () => {
  const lines = probeLines({
    input: { screenEqualsClient: 3, mousemoves: 40, coalescedEmpty: 0, pointermoves: 40, untrusted: 0 },
    native: { "window.fetch": "patched", "history.pushState": "native" },
    artifacts: { automationGlobals: [], foreignNodes: [], consoleSerializedStack: false },
    window: { visibilityState: "visible", hasFocus: true },
  });
  assert.match(lines[0], /screen==client on 3 of 40/);
  assert.match(lines.join("\n"), /patched natives \["window.fetch"\]/);
  assert.deepEqual(probeLines(undefined), ["probe failed: no report"]);
});
