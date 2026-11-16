import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { RoutineScheduler } from "../dist/routine-scheduler.js";

test(
  "startup is ready while due checks are still waiting on a missing page",
  { timeout: 3_000 },
  async () => {
    const runs = [0, 1, 2, 3].map((index) => ({
      runId: `run-${index}`,
      routineId: `routine-${index}`,
      chatId: `chat-${index}`,
      scheduledSlot: "2020-01-01T00:00:00.000Z",
      state: "due",
    }));
    const routines = runs.map((run) => ({
      routineId: run.routineId,
      chatId: run.chatId,
      enabled: true,
      deletedAt: null,
      title: "watch",
      instruction: "look",
      check: "await page.read()",
      sites: [],
    }));
    let startedChecks = 0;
    let finishedChecks = 0;
    let release = () => undefined;
    const gate = new Promise((done) => {
      release = done;
    });
    const browser = {
      isInstanceAvailable: () => true,
      execute: () => {
        startedChecks += 1;
        return gate.then(() => {
          finishedChecks += 1;
          return '{"value":false}';
        });
      },
    };
    const store = {
      listOpenRoutineRuns: () => [],
      listDueRoutines: () => [],
      listDueRoutineRuns: () => runs,
      getRoutine: (id) => routines.find((routine) => routine.routineId === id),
      listRoutines: () => routines,
      updateRoutineRun: () => undefined,
    };
    const chats = {
      getChat: () => ({ status: "ready" }),
      beginRoutineRun: () => undefined,
      endRoutineRun: () => undefined,
      withSession: async () => undefined,
    };
    const scheduler = new RoutineScheduler(store, chats, browser);
    const startedAt = Date.now();
    try {
      await scheduler.start();
      for (let turn = 0; turn < 5 && startedChecks < 1; turn += 1)
        await new Promise((done) => setImmediate(done));
      process.stdout.write(
        `scheduler ready in ${Date.now() - startedAt} ms with ${startedChecks} of 4 due checks still open\n`,
      );
      assert.ok(startedChecks >= 1);
      assert.equal(finishedChecks, 0);
    } finally {
      release();
      scheduler.close();
    }
  },
);
