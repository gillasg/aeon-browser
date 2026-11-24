import assert from "node:assert/strict";
import test from "node:test";

const { renewAttach, debuggerBlocked, blockedByExtension, BLOCKED_NOTE } =
  await import("../dist/native-browser-attach-block.js");

test("renew blocked by another extension's popup keeps the tab and retries next step", async () => {
  // A fake extension: the agent's set, and a debugger that fails once then attaches.
  const agentTabs = new Set([42]);
  let calls = 0;
  const attach = async () => {
    calls += 1;
    if (calls === 1)
      throw new Error("Cannot access a chrome-extension:// URL of different extension");
  };
  await assert.rejects(renewAttach(42, attach), (error) => {
    assert.equal(error.message, "DEBUGGER_DETACHED");
    assert.match(error.detail, /blocked by another extension/);
    return true;
  });
  assert.ok(agentTabs.has(42), "the tab id survives");
  assert.equal(debuggerBlocked(42), BLOCKED_NOTE);
  await renewAttach(42, attach);
  assert.equal(calls, 2);
  assert.equal(debuggerBlocked(42), undefined);
});

test("another debugger already attached is a block; other failures are not", async () => {
  assert.equal(blockedByExtension(new Error("Another debugger is already attached")), true);
  await assert.rejects(
    renewAttach(1, async () => {
      throw new Error("No tab with given id 1");
    }),
    /No tab with given id/,
  );
  assert.equal(debuggerBlocked(1), undefined);
});
