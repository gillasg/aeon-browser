import assert from "node:assert/strict";
import test from "node:test";
import { evaluateStealthSnapshot } from "./known-tells.mjs";

const CLEAN_SNAPSHOT = {
  webdriver: false,
  chromeRuntimeIdExposed: false,
  cdpGlobals: [],
  runtimeEnableTrap: false,
  stackLeakMarkers: [],
  domExpandos: [],
  languagesCount: 2,
  permissionsOk: true,
  clickCount: 1,
  allClicksTrusted: true,
  clicksHaveCoords: true,
  inputValue: "hello graft",
  allInputsTrusted: true,
};

test("evaluateStealthSnapshot passes a clean snapshot with zero failures", () => {
  const verdict = evaluateStealthSnapshot(CLEAN_SNAPSHOT, []);
  assert.deepEqual(verdict.unpinnedFailures, []);
  assert.deepEqual(verdict.pinnedFailures, []);
  assert.deepEqual(verdict.stalePins, []);
  assert.equal(verdict.passed.length, 10);
});

test("evaluateStealthSnapshot catches unpinned tells and stale pins", () => {
  const dirty = { ...CLEAN_SNAPSHOT, runtimeEnableTrap: true, webdriver: true };
  const pins = [
    { id: "no-runtime-enable-trap", note: "pinned tell" },
    { id: "no-cdp-globals", note: "stale pin" },
  ];
  const verdict = evaluateStealthSnapshot(dirty, pins);
  assert.equal(verdict.pinnedFailures.length, 1);
  assert.equal(verdict.pinnedFailures[0].id, "no-runtime-enable-trap");
  assert.equal(verdict.unpinnedFailures.length, 1);
  assert.equal(verdict.unpinnedFailures[0].id, "navigator-webdriver");
  assert.equal(verdict.stalePins.length, 1);
  assert.equal(verdict.stalePins[0].id, "no-cdp-globals");
});
