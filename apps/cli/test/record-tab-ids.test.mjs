import assert from "node:assert/strict";
import test from "node:test";
import { recordedTabIds } from "../dist/record-cmd.js";

test("--tabs without --chat still lists the takes that started during the recording", async () => {
  const codes = [];
  const run = async (code) => {
    codes.push(code);
    return [{ tabId: 1, startedAt: 500 }, { tabId: 2, startedAt: 1500 }, { tabId: 3 }];
  };
  assert.deepEqual(await recordedTabIds(run, undefined, 1000), [2, 3]);
  assert.equal(codes[0], "return await browser.takes()");
});

test("--chat lists that chat's takes whenever they started", async () => {
  const codes = [];
  const run = async (code) => {
    codes.push(code);
    return [{ tabId: 7, startedAt: 1 }];
  };
  assert.deepEqual(await recordedTabIds(run, "chat-1", 1000), [7]);
  assert.equal(codes[0], 'return await browser.takes("chat-1")');
});

test("a missing daemon yields no tab ids", async () => {
  assert.deepEqual(
    await recordedTabIds(
      async () => {
        throw new Error("down");
      },
      undefined,
      0,
    ),
    [],
  );
});
