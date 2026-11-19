import assert from "node:assert/strict";
import test from "node:test";
import { cellSleepMs, cellSleepRefusal, sleepsPastDeadline } from "../dist/cell-sleep-guard.js";

test("a polling loop past the cell deadline is rejected", () => {
  const code = `for (let i = 0; i < 60; i++) await sleep(2000);\nreturn 'done';`;
  const ms = cellSleepMs(code);
  assert.equal(ms, 120_000);
  assert.ok(ms > 60_000);
  const reason = cellSleepRefusal(60_000, ms);
  assert.match(reason, /120 s/);
  assert.match(reason, /60 s deadline/);
  assert.match(reason, /shorter cells/);
  assert.match(reason, /browser\.job/);
});

test("promise and page waits count too", () => {
  assert.equal(cellSleepMs("await new Promise(r => setTimeout(r, 15000));"), 15_000);
  assert.equal(cellSleepMs("await page.waitForTimeout(3000);"), 3_000);
  assert.equal(cellSleepMs("await page.wait(2500);"), 2_500);
  assert.equal(cellSleepMs("await sleep(1000); await sleep(2000);"), 3_000);
});

test("a loop multiplies only the waits inside it", () => {
  assert.equal(
    cellSleepMs("await sleep(1000); for (let i=0;i<3;i++){ await sleep(2000); }"),
    7_000,
  );
  assert.equal(
    cellSleepMs("for (let i=0;i<2;i++){ for (let j=0;j<3;j++){ await sleep(500); } }"),
    3_000,
  );
});

test("real work and waits on conditions are never blocked", () => {
  const allowed = [
    "return await page.read();",
    "await page.waitFor(() => document.readyState === 'complete');",
    "await sleep(500); return 1;",
    "const s = 'sleep(999999)'; return s;",
    "// await sleep(999999)\nreturn 2;",
    "await page.getByRole('button').click();",
  ];
  for (const code of allowed) assert.ok(cellSleepMs(code) <= 60_000, code);
  for (const code of allowed.slice(0, 2).concat(allowed.slice(3)))
    assert.equal(cellSleepMs(code), 0, code);
});

test("waits that fill the deadline are refused; a short wait is not", () => {
  const loop = `for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 6000)); await p.read(); }`;
  assert.equal(cellSleepMs(loop), 60_000);
  assert.ok(sleepsPastDeadline(cellSleepMs(loop), 60_000));
  assert.ok(sleepsPastDeadline(52_000, 60_000));
  assert.ok(!sleepsPastDeadline(30_000, 60_000));
  assert.ok(!sleepsPastDeadline(0, 60_000));
});
