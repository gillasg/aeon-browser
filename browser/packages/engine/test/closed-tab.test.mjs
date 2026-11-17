// A click whose own tab closes during the input call is a success, even when the transport calls
// the missing CDP answer TAB_UNRESPONSIVE instead of a detach.
import assert from "node:assert/strict";
import test from "node:test";

let tabGone = true;
globalThis.chrome = {
  tabs: { get: async () => (tabGone ? undefined : { id: 5 }) },
};

const { closedByAction } = await import("../dist/native-browser-closed-tab.js");

const request = { expectedDocumentEpoch: 2, chatId: "chat-1" };
const step = { op: "click", target: { tabId: 5, clientInstanceId: "c" } };
const tab = { id: 5, url: "http://127.0.0.1/popup", openerTabId: 4 };

function lateInput() {
  return Object.assign(
    new Error("TAB_UNRESPONSIVE: Input.dispatchMouseEvent (clickAt) did not answer in 5.0 s"),
    {
      mayHaveLateEffects: true,
    },
  );
}

test("a late-input error on a tab that closed is reported as the click's success", async () => {
  tabGone = true;
  const result = await closedByAction(request, step, tab, lateInput());
  assert.equal(result.outcome, "changed");
  assert.equal(result.effect, "confirmed");
  assert.match(result.note, /closed this tab itself/);
});

test("the same error on a tab that is still open is not swallowed", async () => {
  tabGone = false;
  await assert.rejects(closedByAction(request, step, tab, lateInput()), /TAB_UNRESPONSIVE/);
});

test("an unrelated error still propagates", async () => {
  tabGone = true;
  await assert.rejects(
    closedByAction(request, step, tab, new Error("SOMETHING_ELSE")),
    /SOMETHING_ELSE/,
  );
});
