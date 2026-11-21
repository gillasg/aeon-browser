import assert from "node:assert/strict";
import test from "node:test";

// Challenge tabs route through human-paced pointer and typing; every other tab keeps the fast path.
const calls = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (_debuggee, method, params) => {
      calls.push({ method, params });
      return {};
    },
  },
};

const human = await import("../dist/native-browser-human-input.js");
const { executeInteraction } = await import("../dist/native-browser-input.js");

let clock = 0;
const slept = [];
let seed = 7;
human.setHumanInputTiming({
  // A tiny deterministic generator and a virtual clock: no real waiting in tests.
  random: () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  },
  now: () => clock,
  sleep: async (ms) => {
    slept.push(ms);
    clock += ms;
  },
});

const target = (tabId) => ({ tabId, clientInstanceId: "x" });
const mouse = () => calls.filter((call) => call.method === "Input.dispatchMouseEvent");
const reset = () => {
  calls.length = 0;
  slept.length = 0;
};

test("a normal tab clicks with exactly press and release and never waits", async () => {
  reset();
  await executeInteraction(
    { tabId: 11 },
    { op: "pointer", action: "click", x: 300, y: 200, target: target(11) },
  );
  assert.equal(human.humanOn(11), false);
  const types = mouse().map((call) => call.params.type);
  assert.ok(types.length <= 3, JSON.stringify(types));
  assert.deepEqual(
    types.filter((type) => type !== "mouseMoved"),
    ["mousePressed", "mouseReleased"],
  );
  assert.equal(slept.length, 0);
  assert.equal(mouse().at(-1).params.x, 300);
});

test("a normal tab types text with no added delay", async () => {
  reset();
  await human.humanType({ tabId: 11 }, "hello world");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["Input.insertText"],
  );
  assert.equal(slept.length, 0);
});

test("a challenge tab moves along a curve and holds the press before releasing", async () => {
  human.noteChallengeSeen(12);
  assert.equal(human.humanOn(12), true);
  reset();
  await executeInteraction(
    { tabId: 12 },
    { op: "pointer", action: "click", x: 600, y: 420, target: target(12) },
  );
  const moves = mouse().filter((call) => call.params.type === "mouseMoved");
  assert.ok(moves.length >= 5, `only ${moves.length} moves`);
  const press = mouse().find((call) => call.params.type === "mousePressed");
  // Lands a little off centre, like a hand, but on the target.
  assert.ok(Math.abs(press.params.x - 600) < 5 && Math.abs(press.params.y - 420) < 5);
  assert.ok(slept.length > moves.length / 2, "pointer path is paced");
  human.forgetHumanInput(12);
  assert.equal(human.humanOn(12), false);
});

test("a challenge tab types every character as a key press at a person's cadence", async () => {
  human.noteChallengeSeen(13);
  reset();
  // keys: false is what a plain fill asks for; the challenge tab overrides it.
  await human.humanType({ tabId: 13 }, "Hi there", { keys: false });
  const downs = calls.filter((call) => call.params?.type === "keyDown");
  assert.equal(downs.length, 8);
  assert.equal(
    calls.filter((call) => call.method === "Input.insertText").length,
    0,
    "no bulk insert",
  );
  assert.equal(slept.length, 7, "one gap between each pair of characters");
  assert.ok(
    slept.every((ms) => ms >= 45 && ms < 800),
    JSON.stringify(slept),
  );
  // The gap after a space is longer than the floor of an in-word gap.
  assert.ok(human.keyGap(" ", "t") >= 65);
  human.forgetHumanInput(13);
});

test("the global setting turns pacing on everywhere and off again", async () => {
  human.setHumanInputEnabled(true);
  try {
    assert.equal(human.humanOn(99), true);
  } finally {
    human.setHumanInputEnabled(false);
  }
  assert.equal(human.humanOn(99), false);
});
