import assert from "node:assert/strict";
import test from "node:test";
import {
  lockScope,
  scheduleStep,
  schedulerStatus,
  setLockWaitMs,
  withLock,
} from "../dist/native-browser-scheduler.js";

test("reads run in parallel and writes queue per tab", async () => {
  let active = 0;
  let peak = 0;
  const read = () =>
    scheduleStep({ op: "observe" }, 7, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 10));
      active -= 1;
    });
  await Promise.all([read(), read(), read()]);
  assert.equal(peak, 3);
  active = 0;
  peak = 0;
  const write = () =>
    scheduleStep({ op: "click" }, 7, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 10));
      active -= 1;
    });
  await Promise.all([write(), write(), write()]);
  assert.equal(peak, 1);
});

test("four tabs of clicks run together, and the lock table is tab, window, browser", async () => {
  const started = Date.now();
  const steps = [];
  for (let tab = 1; tab <= 4; tab += 1) {
    for (let n = 0; n < 20; n += 1) {
      const step = n === 0 ? { op: "paste" } : n === 1 ? { op: "upload" } : { op: "click" };
      steps.push(
        scheduleStep(step, tab, () => new Promise((done) => setTimeout(done, 5)), tab + 10),
      );
    }
  }
  await Promise.all(steps);
  const wall = Date.now() - started;
  const aloneStarted = Date.now();
  for (let n = 0; n < 20; n += 1)
    await scheduleStep({ op: "click" }, 99, () => new Promise((done) => setTimeout(done, 5)));
  const alone = Date.now() - aloneStarted;
  assert.ok(wall < alone * 2, `wall ${wall} ms, one agent ${alone} ms`);
  assert.equal(lockScope({ op: "click" }, 3), "tab:3");
  assert.equal(lockScope({ op: "evaluate" }, 3), "tab:3");
  assert.equal(lockScope({ op: "paste" }, 3, 9), "browser");
  assert.equal(lockScope({ op: "paste" }, 3), "browser");
  assert.equal(lockScope({ op: "upload" }, 3), "browser");
  assert.equal(lockScope({ op: "observe" }, 3), undefined);
});

test("a timed-out waiter fails and leaves the holder owning the lock", async () => {
  setLockWaitMs(40);
  try {
    let release = () => undefined;
    const held = withLock(
      "window:4",
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    await new Promise((done) => setTimeout(done, 5));
    let ran = false;
    await assert.rejects(
      withLock("window:4", async () => {
        ran = true;
      }),
      /BUSY_TIMEOUT/,
    );
    assert.equal(ran, false);
    assert.equal(schedulerStatus().scopes.find((row) => row.scope === "window:4")?.busy, true);
    let third = false;
    const next = withLock("window:4", async () => {
      third = true;
    });
    await new Promise((done) => setTimeout(done, 15));
    assert.equal(third, false);
    release();
    await held;
    await next;
    assert.equal(third, true);
  } finally {
    setLockWaitMs(30_000);
  }
});
