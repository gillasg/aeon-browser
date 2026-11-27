// openTab({window}) overrides the viewport only when the page's inner size differs from the ask.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = { tabs: {}, debugger: {}, runtime: {} };
const { matchWindowViewport, viewportMatches } =
  await import("../dist/native-browser-window-viewport.js");

function fakeSend(inner) {
  const calls = [];
  const fn = async (_target, method, params) => {
    calls.push({ method, params });
    return method === "Runtime.evaluate" ? { result: { value: inner } } : {};
  };
  return { calls, fn };
}

test("a matching viewport is left alone", async () => {
  const { calls, fn } = fakeSend({ width: 800, height: 600 });
  assert.equal(await matchWindowViewport(1, { width: 800, height: 600 }, fn), false);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["Runtime.evaluate"],
  );
});

test("a smaller inner size gets the asked-for metrics override", async () => {
  const { calls, fn } = fakeSend({ width: 800, height: 513 });
  assert.equal(await matchWindowViewport(2, { width: 800, height: 600 }, fn), true);
  const set = calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
  assert.deepEqual(set.params, { width: 800, height: 600, deviceScaleFactor: 0, mobile: false });
});

test("viewportMatches tolerates a one-pixel rounding gap", () => {
  assert.equal(viewportMatches({ width: 801, height: 600 }, { width: 800, height: 600 }), true);
  assert.equal(viewportMatches({ width: 790, height: 600 }, { width: 800, height: 600 }), false);
});
