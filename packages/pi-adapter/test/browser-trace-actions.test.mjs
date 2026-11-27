import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ChatEventMessageSchema, PiSessionEventSchema } from "@graft/protocol";
import { inputStepEffect } from "@browserkit/engine/native-browser-effect";
import { stepEventFrom } from "@browserkit/engine/evidence/step-record";
import { storedTraceActions, traceActions } from "../dist/browser-trace-actions.js";

// The trace a chat keeps (and `graft trace --json` prints) carries each input step's closed
// effect and its evidence, so an eval row can tell a suspected no-op from a confirmed change.

test("an input step's effect and evidence reach its trace row", () => {
  const [action] = traceActions([
    {
      action: { op: "click", target: { tabId: 41 } },
      disposition: "completed",
      tStart: 100,
      tEnd: 180,
      result: {
        kind: "action",
        outcome: "unchanged",
        effect: "suspected_noop",
        evidence: "no navigation, DOM change or request after click",
      },
    },
  ]);
  assert.equal(action.kind, "click");
  assert.equal(action.effect, "suspected_noop");
  assert.equal(action.evidence, "no navigation, DOM change or request after click");
});

test("a refused step's own effect reaches its row, and a read has none", () => {
  const [refused] = traceActions([
    {
      action: { op: "fill", target: { tabId: 41 } },
      disposition: "failed",
      code: "TARGET_DISABLED",
      effect: "refused",
      evidence: "TARGET_DISABLED",
      tStart: 100,
      tEnd: 120,
    },
  ]);
  assert.equal(refused.failed, true);
  assert.equal(refused.effect, "refused");
  assert.equal(refused.evidence, "TARGET_DISABLED");
  const [read] = traceActions([
    { action: { op: "observe" }, disposition: "completed", tStart: 1, tEnd: 2 },
  ]);
  assert.equal(read.effect, undefined);
});

test("stored trace actions keep the fields they were saved with", () => {
  const [action] = storedTraceActions({
    actions: [
      {
        kind: "click",
        tStart: 100,
        tEnd: 180,
        effect: "confirmed",
        evidence: "navigation to https://b.test/",
      },
    ],
  });
  assert.equal(action.effect, "confirmed");
  assert.equal(action.evidence, "navigation to https://b.test/");
});

// The daemon parses every published chat event with ChatEventMessageSchema in
// dev-chat-subscriptions.ts. This is a real click and fill as the engine records them: the
// effect and its evidence come from the engine's own inputStepEffect, and the rows go through
// the adapter exactly as a browser_code result does.
test("a browser_code tool message with a real click and fill parses on the daemon's schema", () => {
  const click = inputStepEffect("click", {
    outcome: "changed",
    changes: 2,
    url: "https://shop.test/orders",
  });
  const fill = inputStepEffect(
    "fill",
    { outcome: "unchanged", readback: "Ada Lovelace" },
    "Ada Lovelace",
  );
  const actions = traceActions([
    {
      index: 0,
      action: {
        op: "click",
        element: { role: "button", name: "Buy", backendNodeId: 12 },
        target: { tabId: 41 },
      },
      disposition: "completed",
      tStart: 100,
      tEnd: 180,
      ms: 80,
      result: {
        kind: "action",
        outcome: "changed",
        url: "https://shop.test/orders",
        effect: click.effect,
        evidence: click.evidence,
      },
    },
    {
      index: 1,
      action: {
        op: "fill",
        element: { role: "textbox", name: "Full name", backendNodeId: 14 },
        target: { tabId: 41 },
        value: "Ada Lovelace",
      },
      disposition: "completed",
      tStart: 200,
      tEnd: 260,
      ms: 60,
      result: {
        kind: "action",
        outcome: "unchanged",
        url: "https://shop.test/orders",
        effect: fill.effect,
        evidence: fill.evidence,
      },
    },
  ]);
  assert.deepEqual(
    actions.map((action) => action.effect),
    ["confirmed", "confirmed"],
  );
  assert.match(actions[0].evidence, /2 DOM changes after click/);
  assert.match(actions[1].evidence, /value read back/);

  const message = ChatEventMessageSchema.parse({
    kind: "chat.event",
    subscriptionId: randomUUID(),
    chatId: randomUUID(),
    event: {
      cursor: { epoch: randomUUID(), revision: 1 },
      event: {
        kind: "message-end",
        message: {
          role: "tool",
          content: [{ type: "text", text: "Filled the order form." }],
          toolCallId: "call-1",
          toolName: "browser_code",
          actions,
        },
      },
    },
  });
  const parsed = message.event.event;
  assert.equal(parsed.kind, "message-end");
  assert.deepEqual(
    parsed.message.actions.map((action) => ({
      kind: action.kind,
      effect: action.effect,
      evidence: action.evidence,
    })),
    [
      {
        kind: "click",
        effect: "confirmed",
        evidence: actions[0].evidence,
      },
      {
        kind: "fill",
        effect: "confirmed",
        evidence: actions[1].evidence,
      },
    ],
  );
});

// A finished step the engine records, carried on a tool-update. stepEventFrom validates with
// StepEventSchema itself; this pins the chat event that carries it.
test("a real engine step event survives a tool-update on the daemon's schema", () => {
  const element = { role: "button", name: "Buy", backendNodeId: 12 };
  const step = stepEventFrom({
    cellId: "cell-1",
    chatId: "chat-1",
    index: 0,
    step: { op: "click", element, target: { tabId: 41 } },
    entry: {
      index: 0,
      action: { op: "click", element, target: { tabId: 41 } },
      disposition: "completed",
      tStart: 100,
      tEnd: 180,
      ms: 80,
      result: {
        kind: "action",
        outcome: "navigated",
        url: "https://shop.test/orders",
        effect: "confirmed",
        evidence: "navigation to https://shop.test/orders",
        receipt: {
          popups: [],
          navigated: true,
          requests: [{ method: "POST", url: "https://shop.test/api/orders", status: 200 }],
        },
      },
    },
  });
  assert.ok(step, "the engine records a step event");
  assert.equal(step.effect, "confirmed");
  assert.deepEqual(step.evidence, {
    request: { method: "POST", path: "/api/orders", status: 200 },
  });

  const event = PiSessionEventSchema.parse({
    kind: "tool-update",
    toolCallId: "call-1",
    toolName: "browser_code",
    arguments: {},
    partialResult: "Running.",
    steps: [step],
  });
  assert.equal(event.steps?.[0]?.evidence?.request?.status, 200);
});

test("an openTab step keeps the tab it opened when its timing has no tab id", () => {
  const [opened] = traceActions([
    {
      action: { op: "openTab", url: "https://example.test/" },
      disposition: "completed",
      tStart: 100,
      tEnd: 900,
      result: { kind: "tab", tab: { target: { tabId: 77 } } },
    },
  ]);
  assert.equal(opened.kind, "openTab");
  assert.equal(opened.tabId, 77);
});

test("a step in a known tab keeps that tab when its timing has no tab id", () => {
  const [read] = traceActions([
    {
      action: { op: "evaluate", target: { tabId: 12 } },
      disposition: "running",
      tStart: 1,
      tEnd: 2,
    },
  ]);
  assert.equal(read.tabId, 12);
});
