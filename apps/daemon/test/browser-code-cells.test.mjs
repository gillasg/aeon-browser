import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import { WebSocket } from "ws";
import { BrowserCodeCells } from "../dist/browser-code-cells.js";

function socket(messages) {
  return {
    readyState: WebSocket.OPEN,
    send(value) {
      messages.push(JSON.parse(String(value)));
    },
    once() {},
    off() {},
  };
}

function eventSocket(messages) {
  const socket = new EventEmitter();
  socket.readyState = WebSocket.OPEN;
  socket.sent = messages;
  socket.send = (value) => messages.push(JSON.parse(String(value)));
  return socket;
}

test("a browser code deadline resets the realm when the cell never started", async () => {
  const messages = [];
  const cells = new BrowserCodeCells(() => undefined);
  await assert.rejects(
    () =>
      cells.run(socket(messages), randomUUID(), randomUUID(), "call-1", [], {
        code: "while (true) {}",
        timeoutMs: 1000,
        onCall: async () => ({}),
        onProgress: () => undefined,
      }),
    /last stage: sent.*realm was reset/,
  );
  const cancel = messages.find((message) => message.kind === "browser.code.cancel");
  assert.ok(cancel, JSON.stringify(messages));
  assert.equal(cancel.reset, true);
});

test("a deadline names the last stage and keeps a realm that was evaluating", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const messages = [];
    const cells = new BrowserCodeCells(() => undefined);
    const connection = socket(messages);
    const run = cells.run(connection, randomUUID(), randomUUID(), "call-1", [], {
      code: "await page.read()",
      timeoutMs: 1000,
      onCall: async () => ({}),
      onProgress: () => undefined,
    });
    const cellId = messages[0].cellId;
    cells.handle(
      {
        kind: "browser.code.progress",
        cellId,
        steps: [{ action: { op: "observe" } }],
        stage: "evaluating",
      },
      connection,
    );
    mock.timers.tick(6001);
    const cancel = messages.find((message) => message.kind === "browser.code.cancel");
    assert.equal(cancel.reset, false);
    mock.timers.tick(3000);
    await assert.rejects(run, /last stage: evaluating.*partial value was not returned/);
    // A started cell that never posts its partial is stuck: its realm is reset at once, so the
    // session's next cell does not queue behind it.
    const resets = messages.filter((m) => m.kind === "browser.code.cancel" && m.reset === true);
    assert.equal(resets.length, 1);
    assert.equal(resets[0].cellId, cellId);
  } finally {
    mock.timers.reset();
  }
});

test("a cell that times out still hands the tabs it opened to its chat", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const messages = [];
    const adopted = [];
    const cells = new BrowserCodeCells((chatId, target) => adopted.push({ chatId, target }));
    const connection = socket(messages);
    const chatId = randomUUID();
    const run = cells.run(connection, randomUUID(), chatId, "call-1", [], {
      code: "await browser.openTab('https://example.com'); while (true) {}",
      timeoutMs: 1000,
      onCall: async () => ({}),
      onProgress: () => undefined,
    });
    const target = {
      clientInstanceId: randomUUID(),
      browserRunId: randomUUID(),
      tabId: 88,
      tabIncarnation: randomUUID(),
    };
    cells.handle(
      {
        kind: "browser.code.progress",
        cellId: messages[0].cellId,
        steps: [
          { action: { op: "openTab" }, result: { kind: "tab", tab: { target } } },
          // A tab the cell only attached to is the user's: never handed to the chat.
          {
            action: { op: "attachTab" },
            result: { kind: "tab", tab: { target: { ...target, tabId: 99 } } },
          },
        ],
        stage: "evaluating",
      },
      connection,
    );
    mock.timers.tick(6001);
    mock.timers.tick(3000);
    await assert.rejects(run, /TIMEOUT/);
    assert.deepEqual(adopted, [{ chatId, target }]);
  } finally {
    mock.timers.reset();
  }
});

test("a short link drop keeps the cell and it answers on the new socket", async () => {
  const first = [];
  const second = [];
  const cells = new BrowserCodeCells(() => undefined);
  const oldSocket = eventSocket(first);
  const clientInstanceId = randomUUID();
  const running = cells.run(oldSocket, clientInstanceId, randomUUID(), "call-1", [], {
    code: "1 + 1",
    timeoutMs: 5000,
    onCall: async () => ({}),
    onProgress: () => undefined,
  });
  const cellId = first[0].cellId;
  oldSocket.emit("close");
  const newSocket = eventSocket(second);
  cells.rebind(clientInstanceId, newSocket);
  cells.handle(
    { kind: "browser.code.result", cellId, output: "", steps: [], opened: [], value: 2 },
    newSocket,
  );
  const result = await running;
  assert.equal(result.value, 2);
});

test("a result carrying its run time finishes the cell; one the daemon can't read fails fast", async () => {
  const messages = [];
  const cells = new BrowserCodeCells(() => undefined);
  const connection = socket(messages);
  const input = {
    code: "1+1",
    timeoutMs: 60_000,
    onCall: async () => ({}),
    onProgress: () => undefined,
  };
  const ok = cells.run(connection, randomUUID(), randomUUID(), "call-1", [], input);
  const base = { kind: "browser.code.result", output: "", steps: [], opened: [] };
  cells.handle({ ...base, cellId: messages[0].cellId, value: 2, ms: 12 }, connection);
  assert.equal((await ok).value, 2);
  const bad = cells.run(connection, randomUUID(), randomUUID(), "call-2", [], input);
  cells.handle({ ...base, cellId: messages[1].cellId, surprise: true }, connection);
  await assert.rejects(bad, /BROWSER_RESULT_INVALID/);
});

test("a cancelled stalled cell answers at once; its realm resets only if still busy after 1 s", async () => {
  const messages = [];
  const cells = new BrowserCodeCells(() => undefined);
  const connection = socket(messages);
  const session = randomUUID();
  const input = (code) => ({
    code,
    timeoutMs: 60_000,
    onCall: async () => ({}),
    onProgress: () => undefined,
  });
  const controller = new globalThis.AbortController();
  const stalled = cells.run(
    connection,
    randomUUID(),
    session,
    "call-1",
    [],
    input("await new Promise(() => {})"),
    controller.signal,
  );
  const stalledId = messages[0].cellId;
  cells.handle(
    { kind: "browser.code.progress", cellId: stalledId, steps: [], stage: "evaluating" },
    connection,
  );
  const started = Date.now();
  controller.abort();
  await assert.rejects(stalled, /RUN_RESET: browser workflow cancelled/);
  const soft = messages.filter((m) => m.kind === "browser.code.cancel" && m.cellId === stalledId);
  assert.deepEqual(
    soft.map((m) => m.reset),
    [false],
  );
  // The session's next cell runs and answers promptly.
  const next = cells.run(connection, randomUUID(), session, "call-2", [], input("1"));
  const nextId = messages.filter((m) => m.kind === "browser.code.run").at(-1).cellId;
  cells.handle(
    { kind: "browser.code.result", cellId: nextId, output: "1", value: 1, steps: [], opened: [] },
    connection,
  );
  assert.equal((await next).output, "1");
  assert.ok(Date.now() - started < 2_000);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const resets = messages.filter(
    (m) => m.kind === "browser.code.cancel" && m.cellId === stalledId && m.reset,
  );
  assert.equal(resets.length, 1);
});

test("a cancelled cell that answers within 1 s keeps its realm", async () => {
  const messages = [];
  const cells = new BrowserCodeCells(() => undefined);
  const connection = socket(messages);
  const controller = new globalThis.AbortController();
  const run = cells.run(
    connection,
    randomUUID(),
    randomUUID(),
    "call-1",
    [],
    { code: "1", timeoutMs: 60_000, onCall: async () => ({}), onProgress: () => undefined },
    controller.signal,
  );
  const cellId = messages[0].cellId;
  controller.abort();
  await assert.rejects(run);
  cells.handle(
    { kind: "browser.code.result", cellId, output: "", error: "RUN_RESET", steps: [], opened: [] },
    connection,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(messages.filter((m) => m.kind === "browser.code.cancel" && m.reset).length, 0);
});
