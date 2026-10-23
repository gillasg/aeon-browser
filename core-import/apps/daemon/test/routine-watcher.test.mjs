import assert from "node:assert/strict";
import test from "node:test";
import { RoutineScheduler } from "../dist/routine-scheduler.js";

// One due run of a watcher routine against a fake browser that answers its check.
async function runWatcher(checkResult) {
  const run = {
    runId: "run-watch",
    routineId: "routine-watch",
    chatId: "chat-watch",
    scheduledSlot: "2030-01-01T00:00:00.000Z",
    state: "due",
  };
  const routine = {
    routineId: run.routineId,
    chatId: run.chatId,
    title: "Flight price",
    instruction: "Tell me the price dropped.",
    check: "const p = await browser.openTab(url); 380 < 400 ? {price: 380} : false",
    enabled: true,
    deletedAt: null,
    requiredBrowserInstanceId: null,
  };
  const updates = [];
  const store = {
    listOpenRoutineRuns: () => [],
    listDueRoutines: () => [],
    listDueRoutineRuns: () => (updates.length ? [] : [run]),
    getRoutine: () => routine,
    listRoutines: () => [routine],
    updateRoutineRun: (_runId, patch) => updates.push(patch),
  };
  const checks = [];
  const browser = {
    isInstanceAvailable: () => true,
    execute: async (chatId, toolCallId, raw) => {
      checks.push({ chatId, toolCallId, code: raw.codeCell.code });
      return JSON.stringify(checkResult);
    },
  };
  const invoked = [];
  const chats = {
    getChat: () => ({ status: "ready" }),
    withSession: async (_chatId, action) =>
      action({
        subscribeRoutineRuns: () => () => undefined,
        findRoutineRun: () => ({ state: "not-found" }),
        invokeRoutine: async (invocation) => {
          invoked.push(invocation);
          return { piEntryId: "entry-1" };
        },
      }),
  };
  const scheduler = new RoutineScheduler(store, chats, browser);
  try {
    await scheduler.start();
  } finally {
    scheduler.close();
  }
  return { updates, checks, invoked, routine };
}

test("a watcher whose check is falsy is skipped without opening Pi", async () => {
  const { updates, checks, invoked } = await runWatcher({ value: false, output: "" });
  assert.equal(checks.length, 1);
  assert.match(
    checks[0].chatId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(checks[0].chatId, "chat-watch", "checks run in their own realm");
  assert.equal(invoked.length, 0);
  assert.equal(updates.at(-1).state, "skipped");
});

test("a failing check is recorded as failed, not run", async () => {
  const { updates, invoked } = await runWatcher({ error: "BROWSER_OFFLINE" });
  assert.equal(invoked.length, 0);
  assert.equal(updates.at(-1).state, "failed");
  assert.match(updates.at(-1).lastError, /CHECK_FAILED: BROWSER_OFFLINE/);
});

test("a truthy check wakes the agent with the value it found", async () => {
  const { updates, invoked } = await runWatcher({ value: { price: 380 }, output: "" });
  assert.equal(invoked.length, 1);
  assert.match(invoked[0].instruction, /^Tell me the price dropped\./);
  assert.match(invoked[0].instruction, /check passed with: \{"price":380\}/);
  assert.equal(updates.at(-1).state, "accepted");
});
