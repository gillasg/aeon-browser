import assert from "node:assert/strict";
import test from "node:test";
import { absorbReads, freshAnswer, noteAnswer, seedReads } from "../dist/answer-check.js";
import { freshLoop, noteLoop } from "../dist/loop-detector.js";
import { deliverStop, watchGuards } from "../dist/run-guards.js";
import { noteSteer, rememberTask, taskOf } from "../dist/task-context.js";
import { unaskedIrreversible } from "@browserkit/engine/official-form";

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

test("a claimed order that was never read is steered once", () => {
  const state = freshAnswer();
  absorbReads(state, "the page shows a login wall and nothing else", "step-1");
  const first = noteAnswer(state, 'Your order 88421 for "AirPods Pro" shipped on 10 Nov 2026');
  assert.match(first.steer, /these were not read in this run/);
  assert.match(first.steer, /88421/);
  assert.match(first.steer, /AirPods Pro/);
  const second = noteAnswer(state, "order 88421 still stands");
  assert.equal(second.steer, undefined);
  assert.equal(state.reads.get("login"), undefined);
});

test("the prompt, the clock, and a sum or difference of two read numbers are not flagged", () => {
  const state = freshAnswer();
  seedReads("chat-answer", "order 1200 and fee 340");
  absorbReads(state, "order 1200 and fee 340\n[now] Tue 10 Nov 2026 14:32 IST", "prompt");
  assert.equal(noteAnswer(state, "The total is 1540.").steer, undefined);
  assert.equal(noteAnswer(state, "The gap is 860.").steer, undefined);
  const missed = noteAnswer(state, "Also order 99991.");
  assert.match(missed.steer ?? "", /99991/);
  assert.equal(missed.stop, undefined);
});

test("a mid-run steer updates the remembered task", () => {
  rememberTask("chat-steer", "fill the visa form");
  noteSteer("chat-steer", "file my taxes");
  assert.match(taskOf("chat-steer"), /fill the visa form/);
  assert.match(taskOf("chat-steer"), /file my taxes/);
  noteSteer("chat-steer", "fill the visa form");
  assert.equal(taskOf("chat-steer").split("fill the visa form").length - 1, 1);
  const handlers = [];
  watchGuards(
    {
      subscribe(fn) {
        handlers.push(fn);
      },
      steer() {},
      abort() {},
    },
    "chat-steer",
  );
  handlers[0]({ type: "message_end", message: { role: "user", content: "send my application" } });
  assert.match(taskOf("chat-steer"), /send my application/);
});

test("a sentence-initial word is not a claimed name", () => {
  const state = freshAnswer();
  assert.equal(noteAnswer(state, "Local fixture response is ready.").steer, undefined);
  const named = noteAnswer(state, "The parcel went to Alice yesterday.");
  assert.match(named.steer ?? "", /Alice/);
});

test("the task's own words decide an irreversible step", () => {
  assert.match(unaskedIrreversible("fill the visa form", "Now I'll submit it"), /did not ask/);
  assert.equal(
    unaskedIrreversible("fill the visa form and submit it", "Now I'll submit it"),
    undefined,
  );
  assert.match(unaskedIrreversible("don't submit", "I will pay now"), /did not ask/);
});
