// A failure keeps its own code on the wire, with that code's hint and next step. Only a code no
// catalog knows becomes CHROME_ERROR.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { describeError, ERROR_CODES } from "@browserkit/protocol";
import { errorCode } from "../dist/native-browser-common.js";
import { sendFailure } from "../dist/native-browser-result.js";

function sent(code, detail) {
  const frames = [];
  globalThis.WebSocket ??= { OPEN: 1 };
  const socket = { readyState: WebSocket.OPEN, send: (raw) => frames.push(JSON.parse(raw)) };
  const request = { requestId: randomUUID(), operationId: randomUUID() };
  sendFailure(socket, request, code, detail);
  assert.equal(frames.length, 1);
  return frames[0];
}

test("every catalog code passes through sendFailure unchanged", () => {
  for (const code of ERROR_CODES) assert.equal(sent(code).code, code, code);
});

test("site-mapper and ability codes keep their own code, hint and next step", () => {
  for (const code of [
    "ABILITY_FAILED",
    "ABILITY_INPUT",
    "ABILITY_DRIFT",
    "SIGNED_OUT",
    "WRITE_UNCERTAIN",
    "PERSISTED_QUERY_MISS",
    "NOT_PROVEN",
    "NO_PAGINATION",
  ]) {
    const frame = sent(code, `${code}: example`);
    assert.equal(frame.code, code);
    assert.doesNotMatch(describeError(code, "example"), /Chrome refused/);
  }
  assert.equal(sent("ABILITY_INPUT").next, "await help()");
  assert.equal(
    sent("WRITE_UNCERTAIN").next,
    undefined,
    "a write that may have applied names no repeat",
  );
});

test("a thrown ability message is named by its code, not CHROME_ERROR", () => {
  assert.equal(errorCode(new Error("ABILITY_INPUT: qty is required (number)")), "ABILITY_INPUT");
  assert.equal(
    errorCode(new Error("ABILITY_FAILED: shop.example add (steps: x)")),
    "ABILITY_FAILED",
  );
  assert.equal(
    errorCode(new Error("ABILITY_UNKNOWN: shop.example has no ability x")),
    "NOT_MAPPED",
  );
  assert.equal(
    errorCode(new Error("WRITE_UNCERTAIN: shop.example add under key k")),
    "WRITE_UNCERTAIN",
  );
});

test("a narrower code goes out as its shared one; an unknown one as CHROME_ERROR", () => {
  assert.equal(sent("ACT_NOT_FOUND").code, "TARGET_NOT_FOUND");
  assert.equal(sent("SOMETHING_NEW").code, "CHROME_ERROR");
});

test("chrome:// pages get their own PROTECTED_UI hint and question", () => {
  assert.equal(errorCode(new Error("Cannot access a chrome:// URL")), "PROTECTED_UI");
  const text = describeError("PROTECTED_UI", "Cannot access a chrome:// URL");
  assert.match(text, /Chrome's own pages/);
  assert.match(
    sent("PROTECTED_UI", "Cannot access a chrome:// URL").next,
    /^ask_user: That is a Chrome settings page/,
  );
  assert.match(describeError("PROTECTED_UI", "a password manager menu"), /password manager/);
});
