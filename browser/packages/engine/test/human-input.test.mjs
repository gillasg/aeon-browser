import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (_debuggee, method, params) => {
      calls.push({ method, params });
      return {};
    },
  },
};

const { scrollAt } = await import("../dist/native-browser-debugger.js");
const { executeInteraction } = await import("../dist/native-browser-input.js");

test("page.scroll sends a glide of wheel frames, not one jump", async () => {
  calls.length = 0;
  await scrollAt({ tabId: 1 }, 50, 50, "down", 1200);
  const wheels = calls.filter((call) => call.method === "Input.dispatchMouseEvent");
  assert.ok(wheels.length >= 4, `sent ${wheels.length} wheel frames`);
  const deltas = wheels.map((call) => Number(call.params.deltaY));
  assert.ok(
    deltas.every((delta) => delta >= 0),
    JSON.stringify(deltas),
  );
  assert.ok(deltas.at(-1) < deltas[0], JSON.stringify(deltas));
});

test("keyboard text is typed as real key presses, one character at a time", async () => {
  calls.length = 0;
  await executeInteraction(
    { tabId: 1 },
    { op: "keys", keys: "aB", target: { tabId: 1, clientInstanceId: "x" } },
  );
  const downs = calls.filter(
    (call) => call.method === "Input.dispatchKeyEvent" && call.params.type === "keyDown",
  );
  assert.deepEqual(
    downs.map((call) => call.params.text),
    ["a", "B"],
    JSON.stringify(calls),
  );
  // Shift is held for a capital, as a person types it.
  assert.equal(downs[1].params.modifiers, 8);
  assert.equal(calls.filter((call) => call.params?.type === "keyUp").length, 2);
});
