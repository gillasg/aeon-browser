import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import { BrowserCodeCells } from "../dist/browser-code-cells.js";

const chatId = "968c135b-a48f-4f5e-9223-dff7f9a10a07";
const toolCallId = "call-1";

function fakeSocket() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.sent = [];
  socket.send = (data) => socket.sent.push(JSON.parse(data));
  return socket;
}

test("a hand-off pauses the cell deadline until the user returns", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const cells = new BrowserCodeCells(() => undefined);
    const socket = fakeSocket();
    const progress = [];
    let settled = false;
    const run = cells
      .run(socket, chatId, chatId, toolCallId, [], {
        code: "await bu.handoff('Sign in')",
        timeoutMs: 1000,
        onCall: async () => undefined,
        onProgress: (steps) => progress.push(steps),
      })
      .finally(() => (settled = true));
    const cellId = socket.sent[0].cellId;
    const update = (waitingForUser) =>
      cells.handle({ kind: "browser.code.progress", cellId, steps: [], waitingForUser }, socket);

    update(true);
    mock.timers.tick(10 * 60_000);
    await Promise.resolve();
    assert.equal(settled, false, "a waiting cell must not hit its deadline");
    assert.equal(socket.sent.length, 1, "no cancel while the user is busy");

    update(false);
    cells.handle(
      { kind: "browser.code.result", cellId, output: "", steps: [], opened: [] },
      socket,
    );
    const result = await run;
    assert.equal(result.cellId, cellId);
    assert.equal(progress.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("the deadline restarts in full once the hand-off ends", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const cells = new BrowserCodeCells(() => undefined);
    const socket = fakeSocket();
    const run = cells.run(socket, chatId, chatId, toolCallId, [], {
      code: "1",
      timeoutMs: 1000,
      onCall: async () => undefined,
      onProgress: () => undefined,
    });
    const cellId = socket.sent[0].cellId;
    cells.handle(
      { kind: "browser.code.progress", cellId, steps: [], waitingForUser: true },
      socket,
    );
    mock.timers.tick(60_000);
    cells.handle(
      { kind: "browser.code.progress", cellId, steps: [], waitingForUser: false },
      socket,
    );
    mock.timers.tick(6001);
    await assert.rejects(run, /exceeded its deadline/);
    assert.equal(socket.sent.at(-1).kind, "browser.code.cancel");
  } finally {
    mock.timers.reset();
  }
});

test("a run the browser never picks up fails in seconds and drops the stalled link", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const cells = new BrowserCodeCells(() => undefined);
    const socket = fakeSocket();
    let terminated = false;
    socket.terminate = () => (terminated = true);
    const run = cells.run(socket, chatId, chatId, toolCallId, [], {
      code: "1+1",
      timeoutMs: 60_000,
      onCall: async () => undefined,
      onProgress: () => undefined,
    });
    mock.timers.tick(10_001);
    await assert.rejects(run, /^Error: INTERNAL: the browser did not pick up this code/);
    assert.equal(terminated, true);
  } finally {
    mock.timers.reset();
  }
});

test("a run the browser acknowledged keeps its full deadline", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const cells = new BrowserCodeCells(() => undefined);
    const socket = fakeSocket();
    socket.terminate = () => assert.fail("an answered link must stay");
    let settled = false;
    const run = cells
      .run(socket, chatId, chatId, toolCallId, [], {
        code: "1+1",
        timeoutMs: 60_000,
        onCall: async () => undefined,
        onProgress: () => undefined,
      })
      .finally(() => (settled = true));
    const cellId = socket.sent[0].cellId;
    cells.handle({ kind: "browser.code.progress", cellId, steps: [], stage: "received" }, socket);
    mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(settled, false);
    cells.handle(
      { kind: "browser.code.result", cellId, output: "", steps: [], opened: [] },
      socket,
    );
    await run;
  } finally {
    mock.timers.reset();
  }
});
