// tab.inspect() and other readOnly steps mark themselves {internal: true}. The step schema is
// strict, so the host must strip the marker before validating, or every DOM read fails with
// `evaluate: Unrecognized key: "internal"`.
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserStepSchema } from "@browserkit/protocol";
import { takeInternal } from "../dist/code-runtime-cell.js";

const step = () => ({
  op: "evaluate",
  target: {
    clientInstanceId: "00000000-0000-4000-8000-000000000000",
    browserRunId: "00000000-0000-4000-8000-000000000000",
    tabId: 2,
    tabIncarnation: "00000000-0000-4000-8000-000000000000",
  },
  expression: "innerWidth",
  internal: true,
});

test("the strict step schema rejects the internal marker", () => {
  assert.equal(BrowserStepSchema.safeParse(step()).success, false);
});

test("takeInternal strips the marker so the evaluate validates", () => {
  const value = step();
  assert.equal(takeInternal(value), true);
  assert.equal("internal" in value, false);
  assert.equal(BrowserStepSchema.safeParse(value).success, true);
  const plain = step();
  delete plain.internal;
  assert.equal(takeInternal(plain), false);
});
