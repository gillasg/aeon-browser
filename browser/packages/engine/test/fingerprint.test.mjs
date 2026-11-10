import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async () => ({}),
    onEvent: { addListener() {} },
  },
  runtime: { onInstalled: { addListener() {} } },
};

const { pageFingerprint } = await import("../dist/native-browser-navigation.js");

test("a fingerprint that answers is the page's url, count and text length", async () => {
  calls.length = 0;
  chrome.debugger.sendCommand = async (_debuggee, method) => {
    calls.push(method);
    return { result: { value: "https://example.test/|4|12" } };
  };
  assert.equal(await pageFingerprint({ tabId: 1 }), "https://example.test/|4|12");
  assert.deepEqual(calls, ["Runtime.evaluate"]);
});

test("a hung page returns an unknown fingerprint instead of stalling the step", async () => {
  calls.length = 0;
  chrome.debugger.sendCommand = (_debuggee, method) => {
    calls.push(method);
    if (method === "Runtime.evaluate") return new Promise(() => {});
    return Promise.resolve();
  };
  const started = Date.now();
  assert.equal(await pageFingerprint({ tabId: 2 }, 40), undefined);
  assert.ok(Date.now() - started < 500, String(Date.now() - started));
  assert.ok(calls.includes("Runtime.terminateExecution"));
});

test("a fingerprint the page refuses is unknown", async () => {
  chrome.debugger.sendCommand = async () => {
    throw new Error("inspector detached");
  };
  assert.equal(await pageFingerprint({ tabId: 3 }, 200), undefined);
  chrome.debugger.sendCommand = async () => ({ result: { value: 5 } });
  assert.equal(await pageFingerprint({ tabId: 3 }, 200), undefined);
});
