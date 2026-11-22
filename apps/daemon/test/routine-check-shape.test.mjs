import assert from "node:assert/strict";
import test from "node:test";
import { onceCheckWarning, withListenDirective } from "../dist/routine-management-tools.js";
import { isListening } from "../dist/routine-listeners.js";

test("a bare use listen line becomes the quoted directive, so the check listens instead of failing", () => {
  const fixed = withListenDirective("use listen; const p = await browser.openTab(url);");
  assert.equal(fixed, '"use listen"; const p = await browser.openTab(url);');
  assert.ok(isListening({ check: fixed }));
  assert.equal(withListenDirective('"use listen"; x'), '"use listen"; x');
  assert.equal(
    withListenDirective("const uselisten = 1; uselisten"),
    "const uselisten = 1; uselisten",
  );
});

test("a once schedule with a plain check is flagged; snipe and polling are not", () => {
  const once = { kind: "once", atUtc: "2026-12-01T09:00:00.000Z", timeZone: "UTC" };
  const interval = { kind: "interval", everyMinutes: 1 };
  assert.match(onceCheckWarning({ check: "x ? {x} : false", schedule: once }), /one time only/);
  assert.equal(
    onceCheckWarning({ check: "return await browser.snipe({at})", schedule: once }),
    null,
  );
  assert.equal(onceCheckWarning({ check: "x ? {x} : false", schedule: interval }), null);
  assert.equal(onceCheckWarning({ check: null, schedule: once }), null);
});
