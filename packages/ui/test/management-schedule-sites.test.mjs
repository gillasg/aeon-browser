import test from "node:test";
import assert from "node:assert/strict";
import { initialScheduleKind, makeSchedule } from "../dist/management-routine-editor.js";
import { selectedSiteEntry, siteEntries, siteHost } from "../dist/management-site-page.js";

const base = { everyMinutes: "60", daysOfWeek: "1", localTime: "09:00", timeZone: "UTC" };

test("editing a one-time routine keeps it one-time", () => {
  const atUtc = "2026-12-01T10:00:00.000Z";
  const routine = { schedule: { kind: "once", atUtc, timeZone: "UTC" } };
  assert.equal(initialScheduleKind(routine), "once");
  assert.deepEqual(makeSchedule({ ...base, kind: "once", atUtc }), {
    kind: "once",
    atUtc,
    timeZone: "UTC",
  });
  assert.equal(makeSchedule({ ...base, kind: "interval", atUtc: "" }).kind, "interval");
  assert.equal(initialScheduleKind(undefined), "interval");
});

test("site hosts are normalized and deep links to unknown sites get a page", () => {
  assert.equal(siteHost("  WWW.Example.COM "), "example.com");
  const entries = siteEntries(
    [{ site: "www.example.com" }],
    ["Example.com"],
    [{ sites: ["example.com"] }],
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].host, "example.com");
  assert.equal(entries[0].blocked, true);
  assert.equal(entries[0].routines.length, 1);
  assert.ok(entries[0].mapped);
  assert.equal(selectedSiteEntry(entries, "www.example.com"), entries[0]);
  const boostOnly = selectedSiteEntry(entries, "boosted.dev");
  assert.equal(boostOnly?.host, "boosted.dev");
  assert.equal(boostOnly?.mapped, undefined);
  assert.equal(selectedSiteEntry(entries, ""), undefined);
});
