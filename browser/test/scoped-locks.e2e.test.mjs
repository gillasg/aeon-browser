// Four agents, four tabs, twenty steps each, including paste and upload.
// Drives the scheduler. No Chrome. Not run by the implementer.
import assert from "node:assert/strict";
import test from "node:test";
import { scheduleStep } from "../packages/engine/dist/native-browser-scheduler.js";

test("four agents on four tabs finish near the slowest one, with no BUSY_TIMEOUT", async () => {
  const started = Date.now();
  const runs = [];
  for (let agent = 1; agent <= 4; agent += 1) {
    for (let step = 0; step < 20; step += 1) {
      const op = step === 3 ? "paste" : step === 7 ? "upload" : "click";
      runs.push(
        scheduleStep({ op }, agent, () => new Promise((done) => setTimeout(done, 5)), 100 + agent),
      );
    }
  }
  const results = await Promise.allSettled(runs);
  const busy = results.filter(
    (result) => result.status === "rejected" && /BUSY_TIMEOUT/.test(String(result.reason)),
  );
  assert.equal(busy.length, 0);
  assert.equal(
    results.every((result) => result.status === "fulfilled"),
    true,
  );
  const wall = Date.now() - started;
  const aloneStarted = Date.now();
  for (let step = 0; step < 20; step += 1)
    await scheduleStep({ op: "click" }, 99, () => new Promise((done) => setTimeout(done, 5)));
  const alone = Date.now() - aloneStarted;
  assert.ok(wall < alone * 2.5, `wall ${wall} ms, one agent ${alone} ms`);
});
