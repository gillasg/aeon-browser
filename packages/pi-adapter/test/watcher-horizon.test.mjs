// "Tell me when X changes" is a watcher that polls as fast as the condition being watched can
// change, not a wait in the cell and not a slot fitted to how far off the event is. The rule is in
// the tool the agent calls and in the core line it always sees.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCapabilityTools } from "../dist/capability-tools.js";

test("tell me when sets a watcher whose interval fits how fast the condition changes", () => {
  const routine = createCapabilityTools("chat").find((tool) => tool.name === "create_routine");
  assert.ok(routine, "create_routine is a tool");
  const guidance = readFileSync(
    new URL("../../../browser/docs/agent/guidance.md", import.meta.url),
    "utf8",
  );
  assert.match(routine.description, /tell me when/i);
  assert.match(routine.description, /everyMinutes/);
  assert.match(routine.description, /how fast the watched condition changes/);
  assert.match(routine.description, /minute-level poll/);
  // The old horizon mapping (minutes 1 / a few hours 15 / a day 60 / none 360) is gone.
  assert.doesNotMatch(routine.description, /none named: 360/);
  assert.match(guidance, /Tell me when/);
  assert.match(guidance, /how fast the watched condition changes/);
  assert.match(guidance, /everyMinutes/);
});
