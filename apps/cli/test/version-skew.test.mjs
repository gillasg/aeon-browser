import assert from "node:assert/strict";
import test from "node:test";
import { connectionCloseMessage } from "../dist/client.js";

test("a version-skewed daemon names the gap and the exact reconnect step", () => {
  const text = connectionCloseMessage(1008, "UPDATE_REQUIRED:1.5");
  assert.match(text, /daemon speaks 1\.5/);
  assert.match(text, /same build/);
  assert.match(text, /reload the extension in chrome:\/\/extensions and retry/);
});

test("an unversioned skew and an ordinary close keep their own text", () => {
  assert.match(connectionCloseMessage(1008, "UPDATE_REQUIRED"), /same build/);
  assert.equal(connectionCloseMessage(1006, "gone"), "Graft closed the connection (1006 gone).");
});
