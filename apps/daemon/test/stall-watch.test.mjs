import assert from "node:assert/strict";
import test from "node:test";
import { watchStalls } from "../dist/stall-watch.js";

function blockFor(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Block the loop on purpose.
  }
}

test("a blocked event loop is logged with how long it lasted and where it was", async () => {
  const lines = [];
  const stop = watchStalls((line) => lines.push(line));
  await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  blockFor(4500);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 600));
  stop();
  assert.ok(
    lines.some((line) => /event loop blocked \d+ ms \(heap/.test(line)),
    lines.join("\n"),
  );
  assert.ok(
    lines.some((line) => /so far, main thread is at:[\s\S]*blockFor/.test(line)),
    lines.join("\n"),
  );
});
