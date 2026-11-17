import assert from "node:assert/strict";
import test from "node:test";
import { waitForBrowser } from "../dist/browser-wait.js";

test("a browser reconnecting after a restart is picked up, not reported missing", async () => {
  let polls = 0;
  const browsers = await waitForBrowser(
    async () => (++polls >= 3 ? [{ id: "browser-1" }] : []),
    500,
  );
  assert.deepEqual(browsers, [{ id: "browser-1" }]);
  assert.equal(polls, 3);
});

test("the wait is bounded when no browser answers", async () => {
  let polls = 0;
  const browsers = await waitForBrowser(async () => {
    polls++;
    return [];
  }, 120);
  assert.deepEqual(browsers, []);
  assert.ok(polls > 0);
});
