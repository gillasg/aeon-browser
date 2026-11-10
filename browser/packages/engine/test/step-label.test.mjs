import assert from "node:assert/strict";
import test from "node:test";
import { actionLine } from "@browserkit/protocol";
import { labelFor, labelForAction } from "../dist/evidence/label.js";
import {
  ledgerLabels,
  MAX_STEP_EVENTS,
  rememberStep,
  stepEventFrom,
} from "../dist/evidence/step-record.js";

const CELL = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";

test("labels name the field and never the value that was typed", () => {
  assert.equal(
    labelForAction({
      op: "fill",
      element: { role: "textbox", name: "Email" },
      value: "secret@x.com",
    }),
    "Fill “Email”",
  );
  assert.equal(
    labelFor({ kind: "fill", target: { name: "Password" } }),
    "Fill “Password” (sensitive)",
  );
  assert.equal(labelFor({ kind: "ability", target: { name: "orders" } }), "Run “orders”");
  assert.equal(
    labelFor({ kind: "press", key: "Enter", target: { name: "Email" } }),
    "Press Enter in “Email”",
  );
});

test("a finished click's event, model line and ledger label are the same words", () => {
  const event = stepEventFrom({
    cellId: CELL,
    chatId: CHAT,
    index: 0,
    step: {
      op: "click",
      element: { role: "button", name: "Place order", backendNodeId: 4 },
      target: { tabId: 3 },
    },
    entry: {
      tEnd: 10,
      ms: 4,
      result: {
        effect: "confirmed",
        url: "https://shop.test/orders",
        evidence: "ok",
        receipt: {
          requests: [{ method: "POST", url: "https://shop.test/api/profile", status: 200 }],
        },
      },
    },
  });
  assert.ok(event);
  assert.equal(event.label, "Click “Place order”");
  assert.equal(event.write, true);
  assert.equal(actionLine(event), "Click “Place order” → confirmed (POST /api/profile 200)");
  assert.deepEqual(ledgerLabels([event, { ...event, id: "other", write: false }]), [
    "Click “Place order”",
  ]);
});

test("a password fill is marked and its value is not on the event", () => {
  const event = stepEventFrom({
    cellId: CELL,
    chatId: CHAT,
    index: 1,
    step: { op: "fill", element: { role: "textbox", name: "Password" }, value: "s3cret" },
    entry: {
      tEnd: 1,
      ms: 1,
      result: { effect: "confirmed", evidence: "value read back: 's3cret'" },
    },
  });
  assert.equal(event?.label, "Fill “Password” (sensitive)");
  assert.equal(event?.sensitive, true);
  assert.equal(event?.evidence?.valueRead, true);
  assert.equal(JSON.stringify(event).includes("s3cret"), false);
});

test("a click that changed nothing is not a ledger write", () => {
  const event = stepEventFrom({
    cellId: CELL,
    chatId: CHAT,
    index: 2,
    step: { op: "click", element: { role: "button", name: "Next" } },
    entry: { tEnd: 1, ms: 1, result: { effect: "suspected_noop", evidence: "unchanged" } },
  });
  assert.equal(event?.effect, "suspected_noop");
  assert.equal(event?.write, false);
  assert.deepEqual(ledgerLabels(event ? [event] : []), []);
});

test("a scroll does not become a step event", () => {
  assert.equal(
    stepEventFrom({
      cellId: CELL,
      chatId: CHAT,
      index: 3,
      step: { op: "scroll" },
      entry: { tEnd: 1, ms: 1 },
    }),
    undefined,
  );
});

test("the same click folds into one line, and the 501st becomes progress", () => {
  const events = [];
  const click = (name, index) => ({
    id: `c:${index}`,
    cellId: CELL,
    chatId: CHAT,
    tabId: 1,
    at: index,
    ms: 1,
    kind: "click",
    label: `Click “${name}”`,
    target: { role: "button", name },
    site: "shop.test",
    write: false,
    effect: "suspected_noop",
  });
  rememberStep(events, click("Next", 1));
  assert.equal(rememberStep(events, click("Next", 2)), "fold");
  assert.equal(events.length, 1);
  assert.equal(events[0].label, "Click “Next” · 2");

  const many = [];
  for (let index = 0; index < MAX_STEP_EVENTS; index += 1)
    rememberStep(many, click("N" + index, index));
  assert.equal(many.length, MAX_STEP_EVENTS);
  assert.equal(rememberStep(many, click("Extra", MAX_STEP_EVENTS)), "fold");
  assert.equal(many.length, MAX_STEP_EVENTS);
  assert.match(many.at(-1).label, /^Progress · \d+ steps$/);
});
