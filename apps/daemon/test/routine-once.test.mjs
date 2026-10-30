import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDueSlots,
  NEVER,
  nextRoutineOccurrence,
  parseRoutineSchedule,
} from "../dist/routine-schedule.js";

test("a one-time schedule runs once at its moment and then never", () => {
  const schedule = parseRoutineSchedule(
    { kind: "once", atUtc: "2026-11-02T04:27:00+05:30", timeZone: "Asia/Kolkata" },
    new Date("2026-11-01T00:00:00Z"),
  );
  assert.equal(schedule.atUtc, "2026-11-01T22:57:00.000Z");
  assert.equal(nextRoutineOccurrence(schedule, "2026-11-01T00:00:00Z"), schedule.atUtc);
  const due = collectDueSlots(schedule, schedule.atUtc, "2026-11-01T23:00:00Z");
  assert.deepEqual(due.slots, [schedule.atUtc]);
  assert.equal(due.nextDueAt, NEVER);
});
