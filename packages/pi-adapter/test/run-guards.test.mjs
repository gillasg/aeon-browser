import assert from "node:assert/strict";
import test from "node:test";
import { freshLoop, noteLoop } from "../dist/loop-detector.js";
import { deliverStop } from "../dist/run-guards.js";

test("three identical calls steer once and the next one stops", () => {
  const state = freshLoop();
  const call = { tool: "browser_code", args: { code: "click()" }, error: false, result: "ok" };
  assert.equal(noteLoop(state, call).steer, undefined);
  assert.equal(noteLoop(state, call).steer, undefined);
  const steered = noteLoop(state, call);
  assert.match(steered.steer, /The last three calls repeated/);
  assert.match(steered.steer, /click\(\)/);
  const stopped = noteLoop(state, call);
  assert.match(stopped.stop, /Stopped: the same call repeated after a steer/);
});

test("a changing poll result does not trip the same-call streak", () => {
  const state = freshLoop();
  for (let index = 0; index < 3; index += 1) {
    const decision = noteLoop(state, {
      tool: "browser_code",
      args: { code: "status()" },
      error: false,
      result: `n=${index}`,
    });
    assert.equal(decision.steer, undefined);
    assert.equal(decision.stop, undefined);
  }
});

test("three errors on the same arguments steer, and different arguments do not", () => {
  const different = freshLoop();
  for (let index = 0; index < 3; index += 1) {
    const decision = noteLoop(different, {
      tool: "browser_code",
      args: { index },
      error: true,
      result: "fail",
    });
    assert.equal(decision.steer, undefined);
  }
  const same = freshLoop();
  const call = { tool: "browser_code", args: { code: "x" }, error: true, result: "fail" };
  assert.equal(noteLoop(same, call).steer, undefined);
  assert.equal(noteLoop(same, { ...call, result: "fail again" }).steer, undefined);
  assert.match(noteLoop(same, { ...call, result: "still fail" }).steer ?? "", /repeated/);
});

test("the stop reason is steered before the run aborts", async () => {
  const order = [];
  await deliverStop(
    {
      steer: async (text) => {
        order.push(`steer:${text}`);
      },
      abort: () => order.push("abort"),
    },
    "Stopped: same call",
  );
  assert.deepEqual(order, ["steer:Stopped: same call", "abort"]);
});
