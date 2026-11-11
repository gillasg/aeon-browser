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
const { humanType, setPointerGenerator } = await import("../dist/native-browser-human-input.js");

test("page.scroll sends one wheel event unless the recorder's pointer is on", async () => {
  calls.length = 0;
  await scrollAt({ tabId: 1 }, 50, 50, "down", 1200);
  const one = calls.filter((call) => call.method === "Input.dispatchMouseEvent");
  assert.equal(one.length, 1);
  calls.length = 0;
  setPointerGenerator(true);
  try {
    await scrollAt({ tabId: 1 }, 50, 50, "down", 1200);
  } finally {
    setPointerGenerator(false);
  }
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

test("a long value asked for as keys is real key events, never insertText", async () => {
  calls.length = 0;
  const text = "a".repeat(121);
  await humanType({ tabId: 1 }, text, { keys: true });
  assert.equal(
    calls.some((call) => call.method === "Input.insertText"),
    false,
  );
  assert.equal(
    calls.filter(
      (call) => call.method === "Input.dispatchKeyEvent" && call.params.type === "keyDown",
    ).length,
    text.length,
  );
});
