import assert from "node:assert/strict";
import test from "node:test";
import { CoreActivityResultSchema } from "@graft/protocol";
import { activityBusy, countBusyRoutines, handleCoreActivity } from "../src/daemon-activity.ts";

const requestId = "11111111-1111-4111-8111-111111111111";

test("a working chat, a running routine, or a browser cell is not idle", () => {
  assert.deepEqual(
    activityBusy({ workingChats: 0, askingChats: 0, routines: 0, cells: 0, abilities: 0 }),
    [],
  );
  assert.match(
    activityBusy({ workingChats: 1, askingChats: 0, routines: 0, cells: 0, abilities: 0 }).join(
      " ",
    ),
    /chat working/,
  );
  assert.match(
    activityBusy({ workingChats: 0, askingChats: 1, routines: 0, cells: 0, abilities: 0 }).join(
      " ",
    ),
    /waiting/,
  );
  assert.match(
    activityBusy({ workingChats: 0, askingChats: 0, routines: 2, cells: 0, abilities: 0 }).join(
      " ",
    ),
    /routines running/,
  );
  assert.match(
    activityBusy({ workingChats: 0, askingChats: 0, routines: 0, cells: 1, abilities: 0 }).join(
      " ",
    ),
    /browser action/,
  );
  assert.match(
    activityBusy({ workingChats: 0, askingChats: 0, routines: 0, cells: 0, abilities: 1 }).join(
      " ",
    ),
    /ability running/,
  );
});

test("a due routine is queued, not running", () => {
  assert.equal(countBusyRoutines([{ state: "due" }, { state: "completed" }]), 0);
  assert.equal(
    countBusyRoutines([{ state: "pending" }, { state: "accepted" }, { state: "running" }]),
    3,
  );
});

test("core.activity reports the cause and does not stop anything", () => {
  const sent = [];
  const stopped = [];
  const socket = {
    readyState: 1,
    send: (body) => sent.push(body),
    stop: () => stopped.push("stop"),
  };
  assert.equal(
    handleCoreActivity(socket, { kind: "core.activity", requestId }, () => ({
      workingChats: 1,
      askingChats: 0,
      routines: 0,
      cells: 0,
      abilities: 0,
    })),
    true,
  );
  const reply = CoreActivityResultSchema.parse(JSON.parse(sent[0]));
  assert.equal(reply.idle, false);
  assert.match(reply.busy.join(" "), /chat working/);
  assert.deepEqual(stopped, []);
  assert.equal(
    handleCoreActivity(socket, { kind: "core.ping", requestId }, () => ({
      workingChats: 1,
      askingChats: 0,
      routines: 0,
      cells: 0,
      abilities: 0,
    })),
    false,
  );
});

test("a pending hand-off adds a Waiting on you line with its elapsed time", () => {
  const lines = activityBusy(
    {
      workingChats: 0,
      askingChats: 1,
      routines: 0,
      cells: 0,
      abilities: 0,
      handoffs: [{ message: "Sign in to your bank", startedAt: 1_000 }],
    },
    131_000,
  );
  assert.deepEqual(lines, [
    "1 chat waiting on you",
    "Waiting on you: Sign in to your bank (2m 10s)",
  ]);
});
