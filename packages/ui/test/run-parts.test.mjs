import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard, ResultCard, StepTimeline } from "../dist/run-cards.js";
import { describeWrites, recentActivityCount } from "../dist/activity-log.js";
import { pauseReason, watcherLine } from "../dist/management-routines.js";
import { HomeDashboard } from "../dist/home-dashboard.js";
import { viewFromRoute } from "../dist/home-top-bar.js";

test("the step timeline shows each step's path and time, dashed when the path was guessed", () => {
  const html = renderToStaticMarkup(
    createElement(StepTimeline, {
      steps: [
        {
          toolCallId: "a",
          toolName: "site_api",
          label: "Price",
          startedAt: 0,
          done: true,
          durationMs: 1200,
          path: "site-api",
          pathMocked: false,
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
  assert.match(html, /data-path="site-api" data-mocked="false"[^>]*>site API</);
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

test("home lists running chats first and routes old links to the new pages", () => {
  const chats = [
    { chatId: "1", title: "Flights", archived: false },
    { chatId: "2", title: "Groceries", archived: false },
  ];
  const html = renderToStaticMarkup(
    createElement(HomeDashboard, {
      chats,
      runningChatIds: new Set(["1"]),
      routines: [
        {
          routineId: "r",
          chatId: "2",
          chatTitle: "Groceries",
          title: "Watch: eggs",
          nextDueAt: null,
          enabled: false,
        },
      ],
      onOpenChat() {},
      onChats() {},
      onWatchers() {},
    }),
  );
  assert.match(html, /Running now.*Flights.*Watch: eggs.*Paused.*Groceries/s);
  assert.deepEqual(viewFromRoute("routines"), { view: "watchers" });
  assert.deepEqual(viewFromRoute("capabilities"), {
    view: "settings",
    settingsSection: "capabilities",
  });
  assert.deepEqual(viewFromRoute(null), { view: "home" });
});
