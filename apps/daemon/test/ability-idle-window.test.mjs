import assert from "node:assert/strict";
import test from "node:test";
import { IDLE_SESSION, idleCodeCell } from "../dist/ability-idle-worker.js";

test("idle ability checks run in their own background window, never the user's", () => {
  const onCall = () => undefined;
  const cell = idleCodeCell("return 1;", onCall);
  assert.equal(cell.space, "window");
  assert.equal(cell.onCall, onCall);
  assert.equal(cell.code, "return 1;");
  assert.equal(IDLE_SESSION, "ability-idle");
});
