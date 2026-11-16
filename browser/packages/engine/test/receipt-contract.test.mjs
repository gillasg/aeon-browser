import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BrowserExecutorResultSchema } from "@browserkit/protocol";

// beginReceipt reads the tab's URL; nothing else in these receipt writers touches Chrome.
globalThis.chrome = {
  tabs: { get: async (id) => ({ id, url: "https://shop.test/orders" }) },
};

const receipt = await import("../dist/native-browser-receipts.js");

// What an action result carries after a click: the receipt the engine built while the action ran.
// The daemon and the trace read it, so the protocol schema must accept every field the writers set.
test("a receipt the engine records parses as an action result", () => {
  receipt.noteLateInput(7, "Input.dispatchMouseEvent (clickAt)");
  receipt.beginReceipt(7);
  receipt.noteReceiptPopup(7, 9, "https://shop.test/popup");
  receipt.noteReceiptDialog(7, {
    type: "confirm",
    message: "Delete this order?",
    accepted: true,
  });
  const built = receipt.takeReceipt(7);
  assert.deepEqual(built.popups, [{ tabId: 9, url: "https://shop.test/popup" }]);
  assert.deepEqual(built.dialog, {
    type: "confirm",
    message: "Delete this order?",
    accepted: true,
  });
  assert.match(built.lateReply ?? "", /Input\.dispatchMouseEvent/);

  const target = {
    clientInstanceId: randomUUID(),
    browserRunId: randomUUID(),
    tabId: 7,
    tabIncarnation: randomUUID(),
  };
  const parsed = BrowserExecutorResultSchema.parse({
    kind: "action",
    target,
    documentEpoch: 3,
    url: "https://shop.test/orders",
    outcome: "navigated",
    effect: "confirmed",
    evidence: "navigation to https://shop.test/orders",
    receipt: built,
  });
  assert.equal(parsed.kind, "action");
  assert.deepEqual(parsed.receipt, built);
});
