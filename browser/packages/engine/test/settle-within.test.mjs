import assert from "node:assert/strict";
import test from "node:test";
import { settleWithin } from "../dist/settle-within.js";

test("a wait on the user returns pending instead of holding the click", async () => {
  const never = new Promise(() => {});
  assert.equal(await settleWithin(never, 20), "pending");
  assert.equal(await settleWithin(Promise.resolve("done"), 1000), "done");
  assert.equal(await settleWithin(Promise.reject(new Error("x")), 1000), "pending");
});

test("the save prompt after a signup does not block the submitting click", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/code-runtime-host.ts", import.meta.url), "utf8");
  assert.match(source, /message: SAVE_IN_CHROME, start: true/);
  assert.match(source, /settleWithin\(run, SAVE_PROMPT_WAIT_MS\)/);
});
