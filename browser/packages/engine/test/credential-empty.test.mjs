// A credential field the page refilled must be empty before Graft types into it: a letterless mask
// still counts as empty, a value with letters does not.
import assert from "node:assert/strict";
import test from "node:test";
import { credentialFieldEmpty } from "../dist/native-browser-input.js";

test("an empty or letterless-mask credential field may be filled", () => {
  assert.equal(credentialFieldEmpty(undefined), true);
  assert.equal(credentialFieldEmpty(""), true);
  assert.equal(credentialFieldEmpty("   "), true);
  assert.equal(credentialFieldEmpty("••••••"), true);
  assert.equal(credentialFieldEmpty("**** ****"), true);
});

test("a credential field holding a real value is refused", () => {
  assert.equal(credentialFieldEmpty("hunter2"), false);
  assert.equal(credentialFieldEmpty("482913"), false);
  assert.equal(credentialFieldEmpty("mm/yy"), false, "a mask with letters is a value");
  assert.equal(credentialFieldEmpty("•••• •••• 1234"), false);
});
