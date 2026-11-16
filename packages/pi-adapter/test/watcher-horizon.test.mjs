// "Tell me when X changes" is a watcher whose interval fits the horizon the user named, not a
// wait in the cell and not an arbitrary slot. The rule is in the tool the agent calls and in the
// core line it always sees.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCapabilityTools } from "../dist/capability-tools.js";

test("tell me when sets a watcher whose interval fits the horizon", () => {
  const routine = createCapabilityTools("chat").find((tool) => tool.name === "create_routine");
  assert.ok(routine, "create_routine is a tool");
  const text = `${routine.description}\n${readFileSync(
    new URL("../../../browser/docs/agent/guidance.md", import.meta.url),
    "utf8",
  )}`;
  assert.match(text, /tell me when/i);
  assert.match(routine.description, /horizon/);
  assert.match(routine.description, /everyMinutes/);
  assert.match(routine.description, /minutes: 1/);
  assert.match(routine.description, /few hours: 15/);
  assert.match(routine.description, /a day: 60/);
  assert.match(routine.description, /none named: 360/);
  const guidance = readFileSync(
    new URL("../../../browser/docs/agent/guidance.md", import.meta.url),
    "utf8",
  );
  assert.match(guidance, /Tell me when/);
  assert.match(guidance, /horizon/);
  assert.match(guidance, /everyMinutes/);
});
