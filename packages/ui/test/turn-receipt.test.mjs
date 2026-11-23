import assert from "node:assert/strict";
import test from "node:test";
import { receiptVia } from "../dist/turn-receipt.js";

const notice = (text) => ({ lines: [{ kind: "notice", text }] });

test("receiptVia keeps only known execution phrases", () => {
  assert.equal(receiptVia(notice("1.1 s · from memory (was 38 s)")), "from memory");
  assert.equal(receiptVia(notice("0.4 s · via skill")), "via skill");
  assert.equal(receiptVia(notice("0.4 s · via abilities")), "via skill");
  assert.equal(receiptVia(notice("0.9 s · via site skill")), "via site skill");
  assert.equal(
    receiptVia({ lines: [{ kind: "receipt", receipt: "speed", lead: "x" }] }),
    "via skill",
  );
});

test("receiptVia never turns a daemon notice into a via", () => {
  assert.equal(receiptVia(notice('Not read this run: "**less, but better**"')), "");
  assert.equal(receiptVia(notice("Warning: the page changed while reading")), "");
  assert.equal(receiptVia(notice("Couldn't reach the site")), "");
  assert.equal(receiptVia(undefined), "");
});
