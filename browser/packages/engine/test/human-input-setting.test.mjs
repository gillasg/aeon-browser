// Human-like input is off until a setting turns it on. The test prints the time cost of one
// pointer action and one short type, and never asserts those times.
import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
globalThis.chrome = {
  debugger: {
    sendCommand(_debuggee, method) {
      calls.push(method);
      return Promise.resolve({});
    },
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: async () => [],
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  storage: {
    local: { get: async () => ({}), set: async () => undefined, onChanged: { addListener() {} } },
  },
};

const human = await import("../dist/native-browser-human-input.js");
const { configureEngine } = await import("../dist/engine-config.js");

configureEngine({ cdpLimitFactor: 0.02 });

function reset() {
  calls.length = 0;
  human.setHumanInputEnabled(false);
}

async function timed(run) {
  const started = Date.now();
  await run();
  return Date.now() - started;
}

test("the setting is off by default and a stored true turns real keystrokes on", async () => {
  reset();
  assert.equal(human.humanLikeInputOn(undefined), false);
  assert.equal(human.humanLikeInputOn(false), false);
  await human.humanType({ tabId: 7 }, "ab");
  assert.deepEqual(calls, ["Input.insertText"]);

  reset();
  human.applyHumanLikeInput(human.humanLikeInputOn(true));
  await human.humanType({ tabId: 8 }, "ab");
  assert.equal(calls.includes("Input.insertText"), false);
  assert.ok(calls.filter((method) => method === "Input.dispatchKeyEvent").length >= 4);
});

test("prints the time cost of a move and a short type with human-like input on and off", async () => {
  const move = async (tabId, on) => {
    reset();
    if (on) human.applyHumanLikeInput(true);
    const before = calls.length;
    const ms = await timed(() =>
      human.humanMouse({ tabId }, "mouseMoved", { x: 400, y: 300, button: "none" }),
    );
    return { ms, events: calls.length - before };
  };
  const typed = async (tabId, on) => {
    reset();
    if (on) human.applyHumanLikeInput(true);
    const before = calls.length;
    const ms = await timed(() => human.humanType({ tabId }, "abcd"));
    return { ms, events: calls.length - before };
  };
  const moveOff = await move(11, false);
  const typeOff = await typed(11, false);
  const moveOn = await move(12, true);
  const typeOn = await typed(13, true);
  console.log(
    `human-like off: move ${moveOff.ms} ms (${moveOff.events} events), type-4 ${typeOff.ms} ms (${typeOff.events} events)`,
  );
  console.log(
    `human-like on: move ${moveOn.ms} ms (${moveOn.events} events), type-4 ${typeOn.ms} ms (${typeOn.events} events)`,
  );
  assert.equal(moveOff.events, 0);
  assert.ok(moveOn.events > 1);
  assert.equal(typeOff.events, 1);
  assert.ok(typeOn.events > typeOff.events);
});
