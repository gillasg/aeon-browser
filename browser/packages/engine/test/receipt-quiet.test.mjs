import assert from "node:assert/strict";
import test from "node:test";
import {
  CAP_MS,
  CAUSAL_MS,
  LONG_CAP_MS,
  QUIET_MS,
  chooseReceipt,
  closeWhenQuiet,
  createOpenReceipt,
  noteDialogClose,
  noteDialogOpen,
  noteDownload,
  noteNavigationDone,
  noteNavigationStart,
  noteRequestEnd,
  noteRequestStart,
  overlapText,
  settledRequests,
} from "../dist/evidence/receipt.js";

test("a plain click with nothing in flight closes without waiting", async () => {
  const started = Date.now();
  let slept = 0;
  const receipt = createOpenReceipt("a1", 1);
  const closed = await closeWhenQuiet(receipt, {
    sleep: async () => {
      slept += 1;
    },
  });
  assert.equal(slept, 0);
  assert.equal(closed.open, undefined);
  assert.ok(Date.now() - started < 20);
});

test("a request that already finished stays quiet and adds no wait", async () => {
  const clock = manualClock();
  const receipt = createOpenReceipt("a1", 1, 0);
  noteRequestStart(receipt, { id: "r", method: "GET", url: "https://shop.test/ok", at: 0 });
  noteRequestEnd(receipt, { id: "r", at: 10, status: 204 });
  clock.set(10 + QUIET_MS);
  let slept = 0;
  const closed = await closeWhenQuiet(receipt, {
    now: clock.now,
    sleep: async () => {
      slept += 1;
    },
  });
  assert.equal(slept, 0);
  assert.equal(closed.open, undefined);
  assert.equal(settledRequests(receipt)[0]?.status, 204);
});

test("a submit that answers at 2s closes with the final status", async () => {
  const clock = manualClock();
  const receipt = createOpenReceipt("a1", 1, 0);
  assert.equal(
    noteRequestStart(receipt, {
      id: "r",
      method: "POST",
      url: "https://shop.test/api/export",
      at: 0,
    }),
    true,
  );
  const closed = closeWhenQuiet(receipt, { now: clock.now, sleep: clock.sleep });
  const waiting = await clock.take();
  assert.equal(waiting.ms, CAP_MS);
  noteRequestEnd(receipt, { id: "r", at: 2000, status: 201 });
  const quiet = await clock.take();
  clock.set(2000 + QUIET_MS);
  quiet.resolve();
  const result = await closed;
  assert.equal(result.open, undefined);
  assert.equal(settledRequests(receipt)[0]?.method, "POST");
  assert.equal(settledRequests(receipt)[0]?.status, 201);
});

test("a request still running at the cap is named in open", async () => {
  const clock = manualClock();
  const receipt = createOpenReceipt("a1", 1, 0);
  noteRequestStart(receipt, { id: "r", method: "GET", url: "https://shop.test/api/export", at: 0 });
  const closed = closeWhenQuiet(receipt, { now: clock.now, sleep: clock.sleep });
  await clock.advance(await clock.take());
  assert.deepEqual(await closed, { open: ["request:/api/export"] });
});

test("a download during the post-dialog hold is seen, and one after close is not", async () => {
  const clock = manualClock();
  const receipt = createOpenReceipt("a1", 1, 0);
  noteDialogOpen(receipt, 0);
  noteDialogClose(receipt, 0);
  const closed = closeWhenQuiet(receipt, { now: clock.now, sleep: clock.sleep });
  await clock.take();
  noteDownload(receipt, 100);
  const rest = await clock.take();
  clock.set(CAUSAL_MS);
  rest.resolve();
  const result = await closed;
  assert.equal(receipt.sawDownload, true);
  assert.equal(result.open, undefined);

  const late = createOpenReceipt("a2", 1, 0);
  noteDialogOpen(late, 0);
  noteDialogClose(late, 0);
  const lateClock = manualClock();
  const done = closeWhenQuiet(late, { now: lateClock.now, sleep: lateClock.sleep });
  const hold = await lateClock.take();
  lateClock.set(CAUSAL_MS + QUIET_MS);
  hold.resolve();
  await done;
  assert.equal(late.sawDownload, false);
  noteDownload(late, CAUSAL_MS + QUIET_MS + 1);
  assert.equal(late.sawDownload, true);
});

test("constant polling outside the causal window does not join", () => {
  const receipt = createOpenReceipt("a1", 1, 0);
  assert.equal(
    noteRequestStart(receipt, { id: "poll", method: "GET", url: "https://x.test/poll", at: 5000 }),
    false,
  );
  assert.equal(receipt.pending.size, 0);
  noteDialogClose(receipt, 1000);
  assert.equal(
    noteRequestStart(receipt, {
      id: "ok",
      method: "POST",
      url: "https://x.test/api/save",
      at: 1400,
    }),
    true,
  );
});

test("a request while two receipts are open is attributed to the latest", () => {
  const first = createOpenReceipt("a1", 3, 0);
  const second = createOpenReceipt("a2", 3, 10);
  const chosen = chooseReceipt([first, second], 3, true);
  assert.equal(chosen?.actionId, "a2");
  assert.equal(second.overlap, true);
  assert.equal(first.overlap, false);
  assert.equal(overlapText([first, second], second), "also open: a1");
  assert.equal(chooseReceipt([first], 3, true)?.overlap, false);
});

test("a navigation stretches the cap to 15s and closes when the load finishes", async () => {
  const clock = manualClock();
  const receipt = createOpenReceipt("a1", 1, 0);
  noteNavigationStart(receipt, 0);
  const closed = closeWhenQuiet(receipt, { now: clock.now, sleep: clock.sleep, capMs: CAP_MS });
  const holding = await clock.take();
  assert.equal(holding.ms, LONG_CAP_MS);
  noteNavigationDone(receipt, 50);
  const quiet = await clock.take();
  clock.set(50 + QUIET_MS);
  quiet.resolve();
  assert.equal((await closed).open, undefined);
  assert.equal(receipt.extended, true);
});

function manualClock() {
  let now = 0;
  const pending = [];
  return {
    now: () => now,
    set(at) {
      now = at;
    },
    sleep(ms) {
      return new Promise((resolve) => {
        pending.push({ ms, resolve });
      });
    },
    async take() {
      await Promise.resolve();
      const next = pending.shift();
      if (!next) throw new Error("no sleep queued");
      return next;
    },
    async advance(step) {
      now += step.ms;
      step.resolve();
      await Promise.resolve();
    },
  };
}
