import assert from "node:assert/strict";
import test from "node:test";
import { watchStalls } from "../dist/stall-watch.js";

test("a blocked event loop is logged with how long it lasted", async () => {
  const lines = [];
  const stop = watchStalls((line) => lines.push(line));
  await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
  const until = Date.now() + 1400;
  while (Date.now() < until) {
    // Block the loop on purpose.
  }
  await new Promise((resolve) => globalThis.setTimeout(resolve, 400));
  stop();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /event loop blocked \d+ ms/);
});
