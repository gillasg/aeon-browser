// A frame that reloads between making an execution context and using it answers "Cannot find
// context with specified id". The engine makes a fresh context and tries again, a bounded number
// of times, and never retries a script that threw on its own.
import assert from "node:assert/strict";
import test from "node:test";

let script = () => ({});
const calls = [];

globalThis.chrome = {
  debugger: {
    sendCommand: async (debuggee, method, params) => {
      calls.push({ method, params });
      const out = script(method, params, calls.length);
      if (out instanceof Error) throw out;
      return out;
    },
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: async () => [],
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  tabs: {
    get: async (id) => ({ id, active: true, discarded: false, status: "complete" }),
    onRemoved: { addListener() {} },
    onReplaced: { addListener() {} },
    onActivated: { addListener() {} },
  },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  },
  storage: {
    session: { get: async () => ({}), set: async () => undefined },
    local: { get: async () => ({}) },
  },
  downloads: { onCreated: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} } },
  scripting: { executeScript: async () => [] },
  windows: { get: async () => ({ focused: true, state: "normal" }) },
};

const { isContextGone, withContextRetry } = await import("../dist/cdp/context-retry.js");
const { evaluateFrame } = await import("../dist/native-browser-frames.js");
const { readPageScan } = await import("../dist/observe/scan.js");

const gone = () => new Error("Cannot find context with specified id");
const at = { tabId: 41 };

function reset(next) {
  calls.length = 0;
  script = next;
}

test("the transient context errors are recognized, and a script's own error is not", () => {
  assert.ok(isContextGone(new Error("Cannot find context with specified id")));
  assert.ok(
    isContextGone(
      new Error("Execution context was destroyed, most likely because of a navigation"),
    ),
  );
  assert.ok(!isContextGone(new Error("TypeError: x is not a function")));
  assert.ok(!isContextGone(new Error("Expected exactly one element")));
});

test("withContextRetry retries twice at most and invalidates before each retry", async () => {
  let runs = 0;
  let invalidated = 0;
  await assert.rejects(
    withContextRetry(
      async () => {
        runs += 1;
        throw gone();
      },
      { backoffMs: 1, invalidate: () => (invalidated += 1) },
    ),
    /Cannot find context/,
  );
  assert.equal(runs, 3);
  assert.equal(invalidated, 2);
});

test("withContextRetry lets any other error through at once", async () => {
  let runs = 0;
  await assert.rejects(
    withContextRetry(async () => {
      runs += 1;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(runs, 1);
});

test("evaluateFrame makes a new world and answers after the old one vanished", async () => {
  let evaluated = 0;
  reset((method) => {
    if (method === "Page.createIsolatedWorld") return { executionContextId: calls.length };
    if (method === "Runtime.evaluate") {
      evaluated += 1;
      return evaluated === 1 ? gone() : { result: { value: "ok" } };
    }
    return {};
  });
  assert.equal(await evaluateFrame(at, "frame-1", "1"), "ok");
  assert.equal(calls.filter((call) => call.method === "Page.createIsolatedWorld").length, 2);
});

test("evaluateFrame still reports a script that threw, without a retry", async () => {
  reset((method) => {
    if (method === "Page.createIsolatedWorld") return { executionContextId: 5 };
    if (method === "Runtime.evaluate")
      return {
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "Error: Cannot find context" },
        },
      };
    return {};
  });
  await assert.rejects(evaluateFrame(at, "frame-1", "boom()"), /CHROME_ERROR/);
  assert.equal(calls.filter((call) => call.method === "Runtime.evaluate").length, 1);
});

test("a page scan whose world vanished is run again in a new one", async () => {
  let evaluated = 0;
  reset((method) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
    if (method === "Runtime.evaluate") {
      evaluated += 1;
      return evaluated === 1
        ? gone()
        : { result: { value: { text: "hello", clickables: [], offscreen: [] } } };
    }
    return {};
  });
  const scan = await readPageScan(at);
  assert.equal(scan.text, "hello");
  assert.equal(evaluated, 2);
});
