// The inventory merges a tab's queued refreshes; a merged one must still count a finished load
// as a new document, while a lone refresh keeps the rule it always had.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome ??= {};
const { shouldAdvanceDocumentEpoch } = await import("../dist/native-inventory-client.js");

const complete = { status: "complete", url: "https://example.test/" };
const loading = { status: "loading", url: "https://example.test/" };

test("a lone navigation refresh advances when the status changed", () => {
  assert.equal(shouldAdvanceDocumentEpoch(true, complete, loading), true);
  assert.equal(shouldAdvanceDocumentEpoch(true, complete, complete), false);
  assert.equal(shouldAdvanceDocumentEpoch(false, complete, loading), false);
});

test("a merged refresh that hid a whole load still advances", () => {
  assert.equal(shouldAdvanceDocumentEpoch(true, complete, complete, true), true);
  assert.equal(shouldAdvanceDocumentEpoch(false, complete, complete, true), false);
  assert.equal(shouldAdvanceDocumentEpoch(true, loading, loading, true), false);
});

test("a new URL always advances", () => {
  assert.equal(
    shouldAdvanceDocumentEpoch(false, complete, {
      status: "complete",
      url: "https://example.test/b",
    }),
    true,
  );
});
