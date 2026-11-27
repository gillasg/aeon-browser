import assert from "node:assert/strict";
import test from "node:test";
import { blockedPageError } from "../dist/native-browser-load-result.js";

test("a tab showing another extension's block page is a blocked site, not a closed tab", () => {
  const error = blockedPageError("chrome-extension://abcdefgh/blocked.html?url=https://x.test/");
  assert.equal(error.message, "POLICY_BLOCKED");
  assert.match(error.detail, /another extension's block page/);
  assert.match(error.detail, /x\.test/);
  assert.match(blockedPageError("chrome-error://chromewebdata/").detail, /error page/);
  assert.equal(blockedPageError("https://example.com/"), undefined);
});
