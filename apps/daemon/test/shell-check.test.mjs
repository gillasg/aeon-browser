import assert from "node:assert/strict";
import test from "node:test";
import { runShellCheck } from "../dist/routine-scheduler.js";

// The local, opt-in routine check: a command's exit code decides whether the routine wakes.

test("a shell check is met when the command exits 0 and carries its output", async () => {
  const result = await runShellCheck(`"${process.execPath}" -e "console.log('ready')"`, 5000);
  assert.equal(result.met, true);
  assert.match(String(result.value), /ready/);
});

test("a failing shell check reports the exit and stderr", async () => {
  const result = await runShellCheck(
    `"${process.execPath}" -e "console.error('nope'); process.exit(2)"`,
    5000,
  );
  assert.equal(result.met, false);
  assert.match(String(result.error), /CHECK_FAILED|nope/);
});
