import assert from "node:assert/strict";
import test from "node:test";
import { createPiRoutineSupport, PI_ROUTINE_INVOCATION_TYPE } from "../dist/pi-routine.js";
import { wrapPiSession } from "../dist/session-projection.js";

// The session handle is assembled by spreading the ports; a class instance would contribute only
// its fields, so these methods must be own properties or every scheduled routine fails before Pi.
test("a wrapped Pi session carries the routine port", () => {
  const session = { subscribe: () => () => undefined, isIdle: true, isStreaming: false };
  const manager = {
    getEntries: () => [],
    getBranch: () => [],
    getCwd: () => "/",
    getEntry: () => undefined,
  };
  const extensionUi = {
    snapshot: () => ({ dialogs: [] }),
    subscribe: () => () => undefined,
    close: () => undefined,
  };
  const handle = wrapPiSession(
    session,
    manager,
    { sessionFile: "/tmp/aeon-routine-support-test.jsonl" },
    "chat-routine",
    extensionUi,
    () => [],
  );
  for (const name of ["invokeRoutine", "findRoutineRun", "subscribeRoutineRuns"])
    assert.equal(typeof handle[name], "function", name);
});

// Pi emits message_start and message_end before it writes the custom entry, so acceptance has to
// look again after the stack drains; otherwise the run stays accepted and never settles.
test("a routine run settles when its invocation entry is persisted after message_start", async () => {
  const entries = [];
  const listeners = new Set();
  const emit = (event) => {
    for (const listener of [...listeners]) listener(event);
  };
  const manager = {
    getEntries: () => entries,
    getBranch: () => entries,
    appendCustomEntry: (type, data) => {
      const entry = { type: "custom", id: `settlement-${entries.length}`, customType: type, data };
      entries.push(entry);
      return entry.id;
    },
  };
  const session = {
    isIdle: true,
    isStreaming: false,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendCustomMessage: async (message) => {
      const appMessage = { role: "custom", content: message.content, details: message.details };
      emit({ type: "turn_start" });
      emit({ type: "message_start", message: appMessage });
      emit({ type: "message_end", message: appMessage });
      // Pi persists after notifying the message_end listeners.
      entries.push({
        type: "custom_message",
        id: "entry-1",
        customType: message.customType,
        content: message.content,
        details: message.details,
      });
      await Promise.resolve();
      emit({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
    },
  };
  const support = createPiRoutineSupport(session, manager, "chat-routine");
  await support.invokeRoutine({
    runId: "run-1",
    routineId: "routine-1",
    title: "Price watch",
    scheduledSlot: "2030-01-01T00:00:00.000Z",
    instruction: "Tell me when it drops.",
  });
  assert.equal(support.findRoutineRun("run-1").state, "completed");
  assert.ok(entries.some((entry) => entry.customType === PI_ROUTINE_INVOCATION_TYPE));
});
