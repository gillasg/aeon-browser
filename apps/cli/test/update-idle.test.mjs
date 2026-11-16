import assert from "node:assert/strict";
import test from "node:test";
import { mergeActivity, runUpdateWhenIdle } from "../src/update-idle.ts";

test("aeon update waits while a chat is running and never starts the rebuild", async () => {
  const lines = [];
  const probes = [
    { idle: false, busy: ["1 chat working"] },
    { idle: false, busy: ["1 chat working"] },
    { idle: true, busy: [] },
  ];
  let updates = 0;
  let seen = 0;
  const code = await runUpdateWhenIdle({
    probe: async () => {
      seen += 1;
      return probes.shift() ?? { idle: true, busy: [] };
    },
    update: async () => {
      updates += 1;
      assert.equal(seen, 3);
      return 0;
    },
    write: (line) => lines.push(line),
    sleep: async () => undefined,
  });
  assert.equal(code, 0);
  assert.equal(updates, 1);
  assert.match(lines.join("\n"), /Waiting/);
  assert.match(lines.join("\n"), /1 chat working/);
  assert.doesNotMatch(lines.join("\n"), /kill/i);
});

test("aeon update proceeds when the daemon is not running", async () => {
  const lines = [];
  let updates = 0;
  const code = await runUpdateWhenIdle({
    probe: async () => null,
    update: async () => {
      updates += 1;
      return 0;
    },
    write: (line) => lines.push(line),
    sleep: async () => {
      throw new Error("must not wait when nothing is running");
    },
  });
  assert.equal(code, 0);
  assert.equal(updates, 1);
  assert.match(lines.join("\n"), /not running/i);
  assert.doesNotMatch(lines.join("\n"), /Waiting/);
});

test("a daemon that cannot report activity still blocks on a working chat", () => {
  const fromChats = mergeActivity(undefined, [{ working: true, asking: null }]);
  assert.equal(fromChats.idle, false);
  assert.match(fromChats.busy.join(" "), /chat working/);
  const idle = mergeActivity(undefined, [{ working: false, asking: null }]);
  assert.equal(idle.idle, true);
  const reported = mergeActivity({ idle: false, busy: ["1 routine running"] }, [
    { working: false },
  ]);
  assert.deepEqual(reported.busy, ["1 routine running"]);
});
