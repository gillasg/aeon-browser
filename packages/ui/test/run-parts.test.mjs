import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard, ResultCard, StepTimeline } from "../dist/run-cards.js";
import { describeWrites, recentActivityCount } from "../dist/activity-log.js";
import { pauseReason, watcherLine } from "../dist/management-routines.js";
import { viewFromRoute } from "../dist/manage-nav.js";

test("the step timeline shows each step's path and time", () => {
  const html = renderToStaticMarkup(
    createElement(StepTimeline, {
      steps: [
        {
          toolCallId: "a",
          toolName: "site_mapper",
          label: "Price",
          startedAt: 0,
          done: true,
          durationMs: 1200,
          path: "site-mapper",
        },
        {
          toolCallId: "b",
          toolName: "browser_code",
          label: "Open cart",
          startedAt: 0,
          done: false,
        },
      ],
    }),
  );
  assert.match(html, /data-path="site-mapper"[^>]*>site API</);
  assert.match(html, />1\.2s</);
  assert.match(html, /data-state="running"/);
});

test("approval and result cards carry the count and the note", () => {
  const approval = renderToStaticMarkup(
    createElement(ApprovalCard, { title: "Pay $39.99?", message: "On kayak.com", count: 2 }),
  );
  assert.match(approval, /Needs you/);
  assert.match(approval, /aria-label="2 waiting"/);
  const result = renderToStaticMarkup(
    createElement(ResultCard, { answer: "It's $39.99.", summary: "2 steps", note: "Why" }),
  );
  assert.match(result, /data-tone="done"/);
  assert.match(result, /class="run-note">Why</);
});

test("Activity describes what a run changed and counts today's entries", () => {
  assert.equal(
    describeWrites(["fill", "type", "submit", "click"]),
    "typed into 2 fields, submitted 1 form",
  );
  assert.equal(describeWrites(["click", "scroll"]), "");
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.equal(
    recentActivityCount([{ at: "2026-10-21T08:00:00Z" }, { at: "2026-10-19T08:00:00Z" }], now),
    1,
  );
});

test("a paused watcher says why when its last checks failed", () => {
  const run = (state, lastError = null) => ({
    runId: state + Math.random(),
    state,
    createdAt: "2026-10-21T08:00:00Z",
    lastError,
  });
  const routine = (enabled, recentRuns) => ({ enabled, recentRuns, nextDueAt: null });
  assert.equal(
    pauseReason(routine(false, [run("failed", "Site changed"), run("failed"), run("completed")])),
    "Paused after 2 failed checks: Site changed",
  );
  assert.equal(pauseReason(routine(false, [run("completed")])), "Paused");
  assert.match(watcherLine(routine(true, [run("completed")])), /^Next not scheduled · Last check /);
});

test("old Manage links land on the new pages", () => {
  assert.equal(viewFromRoute("routines"), "automations");
  assert.equal(viewFromRoute("sessions"), "sites");
  assert.equal(viewFromRoute("blocked"), "sites");
  assert.equal(viewFromRoute("forms"), "details");
  assert.equal(viewFromRoute("models"), "settings");
  assert.equal(viewFromRoute("capabilities"), "advanced");
  assert.equal(viewFromRoute(null), "sites");
});
