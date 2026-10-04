import assert from "node:assert/strict";
import test from "node:test";
import { readEffectiveResources } from "../dist/chat-effective-resources.js";
import { RoutineScheduler } from "../dist/routine-scheduler.js";

test("a required browser instance is checked before a routine opens Pi", async () => {
  const run = {
    runId: "run-smoke",
    routineId: "routine-smoke",
    chatId: "chat-smoke",
    scheduledSlot: "2030-01-01T00:00:00.000Z",
    state: "due",
  };
  const routine = {
    routineId: run.routineId,
    chatId: run.chatId,
    enabled: true,
    deletedAt: null,
    requiredBrowserInstanceId: "browser-instance-smoke",
  };
  let update;
  const store = {
    listOpenRoutineRuns: () => [],
    listDueRoutines: () => [],
    listDueRoutineRuns: () => [run],
    getRoutine: () => routine,
    updateRoutineRun: (_runId, patch) => {
      update = patch;
    },
  };
  let sessionOpened = false;
  const chats = {
    getChat: () => ({ status: "ready" }),
    withSession: async () => {
      sessionOpened = true;
    },
  };
  const browser = { isInstanceAvailable: () => false };
  const scheduler = new RoutineScheduler(store, chats, browser);
  try {
    await scheduler.start();
  } finally {
    scheduler.close();
  }
  assert.equal(sessionOpened, false);
  assert.equal(update.state, "unavailable");
  assert.equal(update.lastError, "REQUIRED_BROWSER_INSTANCE_UNAVAILABLE");
});

test("resource state reports drafts as not started and failed sessions as unavailable", async () => {
  const draftChats = { getChat: () => ({ status: "draft" }) };
  const draft = await readEffectiveResources(draftChats, "chat-smoke");
  assert.equal(draft.sessionState, "not_started");

  for (const status of ["failed", "unavailable"]) {
    const chats = { getChat: () => ({ status }) };
    assert.throws(() => readEffectiveResources(chats, "chat-smoke"), {
      message: "This Chat's Pi session is unavailable.",
    });
  }
});
