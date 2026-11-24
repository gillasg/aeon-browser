import assert from "node:assert/strict";
import test from "node:test";
import { createTimingKit } from "../dist/native-browser-sniper.js";
import { browserTimingApi } from "../dist/code-api-timing.js";

const kit = createTimingKit();

test("server offset is the median of Date minus each trip's midpoint (RTT/2)", () => {
  const samples = [
    { sentAt: 1000, receivedAt: 1100, serverDate: 6050 }, // offset 5000
    { sentAt: 2000, receivedAt: 2040, serverDate: 7020 }, // offset 5000
    { sentAt: 3000, receivedAt: 3400, serverDate: 8500 }, // offset 5300 (slow trip, outlier)
    { sentAt: 4000, receivedAt: 4060, serverDate: 8980 }, // offset 4950
    { sentAt: 5000, receivedAt: 5000, serverDate: Number.NaN }, // no header: dropped
  ];
  assert.deepEqual(kit.serverOffset(samples, 0), { serverOffsetMs: 5000, rttMs: 80, samples: 4 });
  // A Date header floored to the second is half a second early on average.
  assert.equal(
    kit.serverOffset([{ sentAt: 0, receivedAt: 0, serverDate: 1000 }]).serverOffsetMs,
    1500,
  );
  assert.throws(() => kit.serverOffset([]), /CLOCK_SYNC/);
});

test("syncClock probes sequentially and survives a failed probe", async () => {
  let t = 0;
  let calls = 0;
  const probe = async () => {
    calls++;
    t += 20;
    if (calls === 2) throw new Error("down");
    return t + 990;
  };
  const sync = await kit.syncClock(probe, { probes: 4, precisionMs: 0, now: () => t });
  assert.equal(calls, 4);
  assert.deepEqual(sync, { serverOffsetMs: 1000, rttMs: 20, samples: 3 });
});

test("scheduleAt fires on the server millisecond", async () => {
  const offsetMs = 3000; // the server is 3 s ahead
  for (const delay of [5, 40, 120]) {
    const target = Date.now() + offsetMs + delay;
    const fired = await kit.scheduleAt(target, () => Date.now() + offsetMs, { offsetMs });
    assert.ok(fired.result >= target, "never early");
    // Upper bound is CI-safe: windows-latest has 15.6 ms timer granularity and busy VMs.
    assert.ok(fired.lateMs <= 250, `late by ${fired.lateMs} ms`);
  }
  const lead = Date.now() + 50;
  const early = await kit.scheduleAt(lead, () => Date.now(), { leadMs: 20 });
  assert.ok(
    early.result >= lead - 20 && early.lateMs <= 250,
    `lead fired at ${early.result - lead}`,
  );
});

test("scheduleAt is cancellable and leaves no timer behind", async () => {
  const control = new AbortController();
  let ran = false;
  const pending = kit.scheduleAt(Date.now() + 10_000, () => (ran = true), {
    signal: control.signal,
  });
  setTimeout(() => control.abort(), 5);
  await assert.rejects(pending, /ABORTED/);
  assert.equal(ran, false);
});

test("pool.map bounds concurrency and keeps order", async () => {
  let running = 0;
  let peak = 0;
  const out = await kit.poolMap(
    [...Array(12).keys()],
    async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 3));
      running--;
      if (n === 5) throw new Error("bad item");
      return n * 2;
    },
    { concurrency: 3 },
  );
  assert.equal(peak, 3);
  assert.deepEqual(out.results[0], { ok: true, value: 0 });
  assert.deepEqual(out.results[5], { ok: false, error: "bad item" });
  assert.deepEqual(out.results[11], { ok: true, value: 22 });
});

test("a 429 pauses every lane for Retry-After, then retries", async () => {
  const starts = [];
  let limited = false;
  const t0 = Date.now();
  const out = await kit.poolMap(
    [0, 1, 2, 3],
    async (n) => {
      starts.push([n, Date.now() - t0]);
      if (n === 1 && !limited) {
        limited = true;
        return { status: 429, headers: { "retry-after": "0.06" } };
      }
      await new Promise((r) => setTimeout(r, 5));
      return n;
    },
    { concurrency: 2 },
  );
  assert.equal(out.pauses, 1);
  assert.deepEqual(
    out.results.map((r) => r.value),
    [0, 1, 2, 3],
  );
  const retry = starts.filter(([n]) => n === 1)[1][1];
  assert.ok(retry >= 55, `retried after ${retry} ms`);
  assert.equal(kit.retryAfterMs("2", 0), 2000);
  assert.equal(kit.retryAfterMs(new Date(5000).toUTCString(), 1000), 4000);
});

test("abort and failures still run every lane cleanup", async () => {
  const control = new AbortController();
  const closed = [];
  let calls = 0;
  const out = await kit.poolMap(
    [...Array(20).keys()],
    async (n, i, lane) => {
      calls++;
      lane.onCleanup(() => closed.push(n));
      if (n === 3) control.abort();
      await new Promise((r) => setTimeout(r, 2));
      return n;
    },
    { concurrency: 4, signal: control.signal },
  );
  assert.equal(out.cancelled, true);
  assert.equal(closed.length, calls, "every registered cleanup ran");
  assert.ok(calls < 20, "no new work after abort");
  assert.ok(out.results.some((r) => r.error === "CANCELLED"));
});

test("the sandbox embeds the same kit and the accounts calls", () => {
  assert.match(browserTimingApi, /function createTimingKit\(/);
  assert.match(browserTimingApi, /accountSwitch/);
  // The embedded source must evaluate on its own (no imports).
  const make = new Function(`return (${createTimingKit.toString()})();`);
  assert.equal(typeof make().poolMap, "function");
});
