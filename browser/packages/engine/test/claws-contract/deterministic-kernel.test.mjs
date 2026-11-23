// Layer 2 contract: deterministic execution. The kernel is the one door from browser code to
// Chrome. For the same request it must pick the same effect, run the same checks in the same
// order, and refuse a blocked tab or site before the effect runs, every time.
import assert from "node:assert/strict";
import test from "node:test";
import { runEffect } from "../../dist/kernel.js";

function harness({ blockedSite } = {}) {
  const log = [];
  const checks = {
    authorize: (cell, target) => {
      log.push(["authorize", cell, target?.tabId]);
      if (target?.tabId === undefined) throw new Error("INVALID_TARGET");
      return target.tabId;
    },
    guardTab: async (cell, tabId) => {
      log.push(["guardTab", cell, tabId]);
    },
    guardSite: async (cell, site) => {
      log.push(["guardSite", cell, site]);
      if (blockedSite && String(site).includes(blockedSite)) throw new Error("SITE_BLOCKED");
    },
  };
  const effects = [
    {
      name: "page.read",
      match: (value) => value.op === "read",
      tab: (value) => value.target,
      site: (value) => value.url,
      run: async (cell, value, tabId) => {
        log.push(["run", "page.read", tabId]);
        return { read: value.url, tabId };
      },
    },
    {
      name: "page.read-any",
      match: (value) => value.op === "read",
      run: async () => ({ fallback: true }),
    },
  ];
  return { log, checks, effects };
}

const request = { op: "read", target: { tabId: 7 }, url: "https://shop.test/cart" };

test("the same request produces the same result and the same check order on every run", async () => {
  const first = harness();
  const second = harness();
  const a = await runEffect(first.effects, first.checks, "cell-a", request);
  const b = await runEffect(second.effects, second.checks, "cell-a", request);
  assert.deepEqual(a, b);
  assert.deepEqual(first.log, second.log);
  assert.deepEqual(
    first.log.map(([step]) => step),
    ["authorize", "guardTab", "guardSite", "run"],
  );
});

test("the first matching effect wins, in declaration order", async () => {
  const { log, checks, effects } = harness();
  const result = await runEffect(effects, checks, "cell-a", request);
  assert.deepEqual(result, { value: { read: "https://shop.test/cart", tabId: 7 } });
  assert.equal(log.filter(([step]) => step === "run").length, 1);
});

test("a request that no effect matches returns undefined and touches no check", async () => {
  const { log, checks, effects } = harness();
  const result = await runEffect(effects, checks, "cell-a", { op: "unknown" });
  assert.equal(result, undefined);
  assert.equal(log.length, 0);
});

test("a blocked site is refused before the effect runs, every time", async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { log, checks, effects } = harness({ blockedSite: "shop.test" });
    await assert.rejects(runEffect(effects, checks, "cell-a", request), /SITE_BLOCKED/);
    assert.equal(
      log.some(([step]) => step === "run"),
      false,
      "no effect ran on a refused site",
    );
  }
});

test("a request without a tab is refused by authorize, before any guard", async () => {
  const { log, checks, effects } = harness();
  await assert.rejects(
    runEffect(effects, checks, "cell-a", { op: "read", url: "https://shop.test/" }),
    /INVALID_TARGET/,
  );
  assert.deepEqual(
    log.map(([step]) => step),
    ["authorize"],
    "the refusal stops the call before any later check",
  );
});
