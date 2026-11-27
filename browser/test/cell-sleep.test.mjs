import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserSleepApi } from "../packages/engine/dist/code-api-sleep.js";

// A cell's blind sleep after an action ends when the page settles; the runtime's own timers and
// sleeps with no recent action keep their full time, and clearTimeout still cancels.
function realm(settleMs) {
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    console,
    __step: async () => {
      await new Promise((done) => setTimeout(done, settleMs));
      return { data: { settled: true } };
    },
  });
  vm.runInContext(browserSleepApi, context, { filename: "graft-api.js" });
  return {
    cell: (code) =>
      vm.runInContext(`(async () => { ${code} })()`, context, { filename: "graft-cell.js" }),
    api: (code) =>
      vm.runInContext(`(async () => { ${code} })()`, context, { filename: "graft-api.js" }),
    report: () => vm.runInContext("__sleepReport()", context),
  };
}

const timed = async (run) => {
  const started = Date.now();
  await run();
  return Date.now() - started;
};

test("a cell's sleep right after an action ends once the page settles", async () => {
  const page = realm(100);
  await page.cell("__noteActed({tabId: 1});");
  const took = await timed(() => page.cell("await new Promise((r) => setTimeout(r, 4000));"));
  assert.ok(took < 1000, `took ${took} ms`);
  assert.ok(took >= 280, "never before 300 ms");
  assert.match(page.report(), /^\[sleep\] 1 wait ended \d+\.\d s early/);
  assert.equal(page.report(), "", "the report is per cell");
});

test("the runtime's timers and sleeps with no recent action keep their full time", async () => {
  const idle = realm(50);
  assert.ok((await timed(() => idle.cell("await new Promise((r) => setTimeout(r, 900));"))) >= 880);
  const busy = realm(50);
  await busy.cell("__noteActed({tabId: 1});");
  assert.ok((await timed(() => busy.api("await new Promise((r) => setTimeout(r, 900));"))) >= 880);
});

test("sleep(ms) waits the full time and never longer than 60s", async () => {
  const delays = [];
  const context = vm.createContext({
    setTimeout: (fn, ms) => {
      delays.push(ms);
      fn();
      return 1;
    },
    clearTimeout,
    console,
    __step: async () => ({ data: { settled: false } }),
  });
  vm.runInContext(browserSleepApi, context, { filename: "graft-api.js" });
  await vm.runInContext(
    `(async () => { await sleep(3000); await sleep(120000); await sleep(-5); await sleep("20"); })()`,
    context,
    { filename: "graft-cell.js" },
  );
  assert.deepEqual(delays, [3000, 60000, 0, 20]);
});

test("clearTimeout still cancels a shortened sleep", async () => {
  const page = realm(50);
  await page.cell("__noteActed({tabId: 1});");
  const fired = await page.cell(
    "let hit = false; const id = setTimeout(() => { hit = true; }, 2000); clearTimeout(id); await new Promise((r) => setTimeout(r, 900)); return hit;",
  );
  assert.equal(fired, false);
});
