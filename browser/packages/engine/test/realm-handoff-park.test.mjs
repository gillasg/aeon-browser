// A cell parked on a human hand-off keeps its deadline paused, so a passkey or fingerprint pause
// never times the cell out.
import assert from "node:assert/strict";
import test from "node:test";
import { HANDOFF_PARK_MAX_MS, cellExpired, parksOnHuman } from "../dist/code-realm-host.js";

test("only a blocking hand-off parks the cell", () => {
  assert.equal(parksOnHuman({ handoff: { message: "Touch ID", target: "t1" } }), true);
  assert.equal(parksOnHuman({ handoff: { message: "x", start: true } }), false);
  assert.equal(parksOnHuman({ handoff: { cancel: true } }), false);
  assert.equal(parksOnHuman({ step: { op: "click" } }), false);
  assert.equal(parksOnHuman(undefined), false);
});

test("a parked cell outlives CELL_MAX_MS and expires only after the hand-off window", () => {
  const start = 0;
  const elevenMinutes = 11 * 60_000;
  assert.equal(cellExpired({ startedAt: start }, elevenMinutes), true);
  assert.equal(cellExpired({ startedAt: start, parkedAt: 60_000 }, elevenMinutes), false);
  assert.equal(cellExpired({ startedAt: start, parkedAt: 0 }, HANDOFF_PARK_MAX_MS), true);
});
