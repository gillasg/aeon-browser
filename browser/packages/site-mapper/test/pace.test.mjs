import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPaceNotes,
  exportPaced,
  formatPace,
  notePaceLimit,
  paceExpectedMs,
  paceLimited,
  resetPace,
  setBatchRate,
  setPaceClock,
  setPaceJitter,
  takePace,
} from "../dist/pace.js";

let now = 0;
const waits = [];

setPaceClock({
  now: () => now,
  wait: async (ms) => {
    waits.push(ms);
    now += ms;
  },
});
setPaceJitter(() => 1);

test("a site bursts five calls, then waits about a second", async () => {
  resetPace();
  now = 0;
  waits.length = 0;
  for (let n = 0; n < 5; n += 1) await takePace("shop.test");
  assert.deepEqual(waits, []);
  await takePace("shop.test");
  assert.equal(waits.at(-1), 1000);
  assert.match(formatPace("shop.test", 8), /\[pace\] 8 calls on shop\.test, about 3\.0s/);
  assert.equal(paceExpectedMs("shop.test", 8), 3000);
});

test("a 429 halves the rate for the next take", async () => {
  resetPace();
  now = 0;
  waits.length = 0;
  for (let n = 0; n < 5; n += 1) await takePace("shop.test");
  notePaceLimit("shop.test");
  await takePace("shop.test");
  assert.equal(waits.at(-1), 2000);
  assert.equal(paceLimited("shop.test"), true);
  now = 10 * 60 * 1000 - 1;
  assert.equal(paceLimited("shop.test"), true);
  now = 10 * 60 * 1000;
  assert.equal(paceLimited("shop.test"), false);
});

test("a batch rate replaces the site rate until it is cleared", () => {
  resetPace();
  now = 0;
  setBatchRate("batch.test", 2);
  assert.equal(paceExpectedMs("batch.test", 7), 1000);
  setBatchRate("batch.test");
  assert.equal(paceExpectedMs("batch.test", 7), 2000);
});

test("overlapping takes reserve a token before they wait", async () => {
  resetPace();
  now = 0;
  waits.length = 0;
  for (let n = 0; n < 5; n += 1) await takePace("overlap.test");
  let release = () => undefined;
  const gate = new Promise((done) => {
    release = done;
  });
  let waiting = 0;
  setPaceClock({
    now: () => now,
    wait: async (ms) => {
      waiting += 1;
      waits.push(ms);
      await gate;
      now += ms;
    },
  });
  const first = takePace("overlap.test");
  const second = takePace("overlap.test");
  await Promise.resolve();
  assert.equal(waiting, 2);
  assert.deepEqual(
    [...waits].sort((left, right) => left - right),
    [1000, 2000],
  );
  release();
  await Promise.all([first, second]);
  setPaceClock({
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
});

test("a pace note sets the rate and the burst", async () => {
  resetPace();
  applyPaceNotes("notes.test", [
    { kind: "quirk", key: "x", value: "no" },
    { kind: "pace", key: "rate", value: "2 per second, burst 2" },
  ]);
  assert.equal(paceExpectedMs("notes.test", 4), 1000);
});

test("an export retries one 429 and then keeps the pace", async () => {
  resetPace();
  now = 0;
  let calls = 0;
  const result = await exportPaced("export.test", [1, 2, 3], async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("429"), { status: 429 });
    return calls;
  });
  assert.deepEqual(result.rows, [2, 3, 4]);
  assert.match(result.note, /\[pace\] 3 calls/);
});
