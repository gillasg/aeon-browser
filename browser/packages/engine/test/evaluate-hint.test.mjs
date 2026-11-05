import assert from "node:assert/strict";
import test from "node:test";
import { hintEvaluateError, pageExceptionCode } from "../dist/native-browser-navigation.js";

test("page globals in a ReferenceError get the sandbox hint", () => {
  assert.match(hintEvaluateError("ReferenceError: document is not defined"), /sandbox/);
  assert.doesNotMatch(hintEvaluateError("ReferenceError: foo is not defined"), /sandbox/);
  assert.match(
    hintEvaluateError("TypeError: Cannot read properties of undefined (reading 'querySelector')"),
    /sandbox/,
  );
});

test("an exception in page code keeps its own code, else it is the code's error", () => {
  assert.equal(
    pageExceptionCode("Error: TARGET_NOT_FOUND: no element matches"),
    "TARGET_NOT_FOUND",
  );
  assert.equal(pageExceptionCode("TARGET_HIDDEN: not visible"), "TARGET_HIDDEN");
  assert.equal(pageExceptionCode("TypeError: x is not a function"), "CODE_ERROR");
  assert.equal(pageExceptionCode("Error: NOT_A_CODE: whatever"), "CODE_ERROR");
});
