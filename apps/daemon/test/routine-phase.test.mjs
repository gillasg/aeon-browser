// I-5: recurring routines get a seeded phase offset; one-time routines keep their exact time.
import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDueSlots,
  nextRoutineOccurrence,
  routinePhaseMs,
} from "../dist/routine-schedule.js";

const hourly = {
  kind: "interval",
  everyMinutes: 60,
  anchorUtc: "2026-01-01T00:00:00.000Z",
  timeZone: "UTC",
};
const daily = {
  kind: "calendar",
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  localTime: "09:00",
  timeZone: "UTC",
};
const once = { kind: "once", atUtc: "2026-06-01T09:00:00.000Z", timeZone: "UTC" };
const seeds = Array.from({ length: 200 }, (_, index) => `routine-${index}`);

test("the phase is deterministic per seed and bounded by 10% of the interval", () => {
  for (const seed of seeds) {
    const phase = routinePhaseMs(hourly, seed);
    assert.equal(phase, routinePhaseMs(hourly, seed));
    assert.ok(Math.abs(phase) <= 6 * 60_000);
    assert.ok(Math.abs(routinePhaseMs(daily, seed)) <= 10 * 60_000, "calendar capped at 10 min");
  }
  assert.ok(new Set(seeds.map((seed) => routinePhaseMs(hourly, seed))).size > 150, "phases spread");
});

test("exact-time routines and unseeded calls are exempt", () => {
  assert.equal(routinePhaseMs(once, "routine-1"), 0);
  assert.equal(nextRoutineOccurrence(once, "2026-05-01T00:00:00Z", "routine-1"), once.atUtc);
  assert.equal(nextRoutineOccurrence(hourly, "2026-01-01T00:30:00Z"), "2026-01-01T01:00:00.000Z");
});

test("the whole series shifts by the same offset and keeps its interval", () => {
  const seed = seeds.find((value) => routinePhaseMs(hourly, value) !== 0);
  const phase = routinePhaseMs(hourly, seed);
  const first = nextRoutineOccurrence(hourly, "2026-01-01T00:30:00Z", seed);
  assert.equal(Date.parse(first), Date.parse("2026-01-01T01:00:00Z") + phase);
  const { slots, nextDueAt } = collectDueSlots(hourly, first, "2026-01-01T04:30:00Z", seed);
  for (let index = 1; index < slots.length; index += 1)
    assert.equal(Date.parse(slots[index]) - Date.parse(slots[index - 1]), 3_600_000);
  assert.ok(Date.parse(nextDueAt) > Date.parse("2026-01-01T04:30:00Z"));
  const morning = nextRoutineOccurrence(daily, "2026-03-01T00:00:00Z", seed);
  assert.equal(
    Date.parse(morning),
    Date.parse("2026-03-01T09:00:00Z") + routinePhaseMs(daily, seed),
  );
});
