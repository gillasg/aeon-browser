// openTab reports a failed navigation only when the page never committed, and follows Chrome's
// tab swaps (onReplaced) instead of reporting TARGET_LOST.
import assert from "node:assert/strict";
import test from "node:test";

const replacedListeners = [];
const liveTabs = new Map();
globalThis.chrome = {
  tabs: {
    onReplaced: { addListener: (fn) => replacedListeners.push(fn) },
    get: async (id) => {
      if (!liveTabs.has(id)) throw new Error(`No tab with id: ${id}`);
      return liveTabs.get(id);
    },
  },
};
const swap = (added, removed) => replacedListeners.forEach((fn) => fn(added, removed));

const { navigationFailure, stillLoading } = await import("../dist/native-browser-load-result.js");
const { followReplacement, settleOpenedTab, clearReplacements, noteReplacement } =
  await import("../dist/native-browser-tab-replaced.js");

const pending = [{ url: "http://x.test/hang", ageMs: 900 }];

test("pending requests on a loaded page are not a failed navigation", () => {
  const idle = stillLoading(pending);
  assert.equal(navigationFailure({ timedOut: false, ...idle }), undefined);
  assert.equal(navigationFailure({ timedOut: false, idle: true }), undefined);
});

test("a committed page that hit the deadline is not a failure either", () => {
  assert.equal(navigationFailure({ timedOut: true, ...stillLoading(pending) }), undefined);
});

test("an uncommitted timeout reports its real reason, never 'the page is usable'", () => {
  const idle = stillLoading(pending);
  const reason = "still showing about:blank; retry with a longer timeout";
  const failure = navigationFailure({ timedOut: true, ...idle, note: `${reason}; ${idle.note}` });
  assert.equal(failure, reason);
  assert.doesNotMatch(failure, /usable|Still loading/);
});

test("followReplacement chains A -> B -> C and expires old swaps", () => {
  clearReplacements();
  swap(2, 1);
  swap(3, 2);
  assert.equal(followReplacement(1), 3);
  assert.equal(followReplacement(2), 3);
  assert.equal(followReplacement(9), 9);
  noteReplacement(20, 10, Date.now() - 120_000);
  assert.equal(followReplacement(10), 10);
});

test("an opened tab swapped by Chrome resolves under its new id", async () => {
  clearReplacements();
  swap(51, 50);
  const asked = [];
  const result = await settleOpenedTab(50, async (id) => (asked.push(id), { id }));
  assert.deepEqual(result, { id: 51, tab: { id: 51 } });
  assert.deepEqual(asked, [51]);
});

test("an inventory miss checks Chrome, follows a late swap and retries", async () => {
  clearReplacements();
  liveTabs.clear();
  const asked = [];
  let first = true;
  const result = await settleOpenedTab(60, async (id) => {
    asked.push(id);
    if (first) {
      first = false;
      swap(61, 60); // the swap lands while the inventory is being read
      return undefined;
    }
    return { id };
  });
  assert.deepEqual(result, { id: 61, tab: { id: 61 } });
  assert.deepEqual(asked, [60, 61]);
});

test("an inventory miss for a live tab retries the same id", async () => {
  clearReplacements();
  liveTabs.set(70, { id: 70 });
  let calls = 0;
  const result = await settleOpenedTab(70, async (id) => (++calls === 1 ? undefined : { id }));
  assert.deepEqual(result, { id: 70, tab: { id: 70 } });
});

test("a tab that is gone stays missing, so openTab throws TARGET_LOST", async () => {
  clearReplacements();
  liveTabs.clear();
  const result = await settleOpenedTab(80, async () => undefined);
  assert.deepEqual(result, { id: 80, tab: undefined });
});
