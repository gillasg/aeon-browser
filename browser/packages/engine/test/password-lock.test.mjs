import assert from "node:assert/strict";
import test from "node:test";
import {
  hideSecrets,
  rememberSecrets,
  scrubError,
  scrubSecrets,
} from "../dist/native-browser-secrets.js";
import { documentReplaced, runsPageCode } from "../dist/native-browser-password-lock.js";

const target = { tabId: 1, windowId: 1, documentId: "d" };

test("a remembered password is removed from every string agent code gets back, in any encoding", async () => {
  rememberSecrets(["hunter2 secret!"]);
  const result = await scrubSecrets({
    value: "the field holds hunter2 secret!",
    nested: [{ body: "password=hunter2+secret%21&user=a" }],
    json: '{"password":"hunter2 secret!"}',
    base64: btoa("hunter2 secret!"),
    kept: 42,
  });
  assert.equal(result.value, "the field holds [removed]");
  assert.equal(result.nested[0].body, "password=[removed]&user=a");
  assert.equal(result.json, '{"password":"[removed]"}');
  assert.match(result.base64, /^\[removed\]/);
  assert.equal(result.kept, 42);
  assert.equal(hideSecrets("nothing here"), "nothing here");
  const error = await scrubError(new Error("value was hunter2 secret!"));
  assert.equal(error.message, "value was [removed]");
});

test("code that runs in the page is what a password page refuses; clicks and reads are not", () => {
  assert.equal(runsPageCode({ op: "evaluate", target, expression: "1" }), true);
  assert.equal(runsPageCode({ op: "waitFor", target, expression: "1", timeoutMs: 100 }), true);
  assert.equal(runsPageCode({ op: "cdp", target, method: "Runtime.evaluate", params: {} }), true);
  assert.equal(
    runsPageCode({ op: "cdp", target, method: "Page.captureScreenshot", params: {} }),
    false,
  );
  assert.equal(runsPageCode({ op: "frames", target, action: "evaluate", params: {} }), true);
  assert.equal(runsPageCode({ op: "frames", target, action: "click", params: {} }), false);
  assert.equal(runsPageCode({ op: "click", target }), false);
  assert.equal(runsPageCode({ op: "read", target }), false);
});

test("a page replaced mid-check is told apart from one that could not be checked", () => {
  assert.equal(documentReplaced("Frame with ID 0 was removed."), true);
  assert.equal(documentReplaced("no top frame"), true);
  assert.equal(documentReplaced("Cannot access contents of the page"), false);
});
