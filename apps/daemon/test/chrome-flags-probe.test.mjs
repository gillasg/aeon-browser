import assert from "node:assert/strict";
import test from "node:test";
import { CHROME_FLAGS } from "@graft/protocol";
import {
  createChromeFlagsProbe,
  missingFromChromeCommandLines,
} from "../dist/chrome-flags-probe.js";

test("missingFromChromeCommandLines reports nothing when no Chrome process is observed", () => {
  assert.deepEqual(missingFromChromeCommandLines([]), []);
});

test("missingFromChromeCommandLines reports missing flags when Chrome lacks them", () => {
  assert.deepEqual(missingFromChromeCommandLines(["google-chrome --profile-directory=Default"]), [
    ...CHROME_FLAGS,
  ]);
});

test("missingFromChromeCommandLines reports empty when Chrome carries all flags", () => {
  assert.deepEqual(missingFromChromeCommandLines([`google-chrome ${CHROME_FLAGS.join(" ")}`]), []);
});

test("createChromeFlagsProbe caches results and refreshes once stale", async () => {
  let clock = 1_000;
  let calls = 0;
  const responses = [
    ["google-chrome --profile-directory=Default"],
    [`google-chrome ${CHROME_FLAGS.join(" ")}`],
  ];
  const probe = createChromeFlagsProbe(
    async () => {
      calls += 1;
      return responses.shift() ?? [];
    },
    () => clock,
  );
  assert.deepEqual(await probe.refresh(), [...CHROME_FLAGS]);
  assert.deepEqual(probe.current(), [...CHROME_FLAGS]);
  assert.equal(calls, 1);

  clock += 31_000;
  // Stale current() returns last cached value immediately without blocking and triggers refresh.
  assert.deepEqual(probe.current(), [...CHROME_FLAGS]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
  assert.deepEqual(probe.current(), []);
});
