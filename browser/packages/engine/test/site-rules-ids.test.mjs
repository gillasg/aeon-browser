// The site block list is a set of session network rules. Chrome keeps them when the service
// worker restarts, so a fresh worker's ids must not collide with the survivors, and two cells
// guarding one tab at the same moment must add its rules once.
import assert from "node:assert/strict";
import test from "node:test";

function installChrome(preexisting = []) {
  const rules = new Map(preexisting.map((rule) => [rule.id, rule]));
  const calls = [];
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url: "https://example.test/" }),
      remove: async (id) => calls.push({ removed: id }),
      onRemoved: { addListener() {} },
      onCreated: { addListener() {} },
    },
    webNavigation: { onCreatedNavigationTarget: { addListener() {} } },
    storage: { local: { get: async () => ({}) } },
    declarativeNetRequest: {
      getSessionRules: async () => [...rules.values()],
      updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
        calls.push({ addRules, removeRuleIds });
        // Chrome's own check: an add may not reuse an id that is still in place afterwards.
        for (const id of removeRuleIds) rules.delete(id);
        for (const rule of addRules) {
          if (rules.has(rule.id))
            throw new Error(`Rule with id ${rule.id} does not have a unique ID`);
          rules.set(rule.id, rule);
        }
      },
    },
  };
  return { rules, calls };
}

// Each import is a fresh worker life: the module's own memory starts empty.
let lives = 0;
async function freshWorker() {
  lives += 1;
  return import(`../dist/native-browser-site-rules.js?life=${lives}`);
}

const RULES = { blocked: ["blocked.test"], only: [] };

test("a restarted worker clears the rules the last one left, so ids never collide", async () => {
  const survivors = [700000, 700001, 700002].map((id) => ({ id, priority: 3 }));
  const { rules, calls } = installChrome(survivors);
  const { guardTab } = await freshWorker();
  await guardTab(1, RULES);
  await guardTab(2, RULES);
  assert.deepEqual(calls[0].removeRuleIds.sort(), [700000, 700001, 700002]);
  assert.equal(rules.size, 2);
  assert.ok([...rules.values()].every((rule) => rule.condition));
});

test("rules outside the block list's id range are left alone", async () => {
  const { rules } = installChrome([{ id: 5, priority: 1 }]);
  const { guardTab } = await freshWorker();
  await guardTab(1, RULES);
  assert.ok(rules.has(5));
});

test("concurrent guards of one tab add its rules once", async () => {
  const { rules } = installChrome();
  const { guardTab } = await freshWorker();
  await Promise.all([guardTab(7, RULES), guardTab(7, RULES), guardTab(7, RULES)]);
  assert.equal(rules.size, 1);
});

test("concurrent guards of different tabs get different ids", async () => {
  const { rules } = installChrome();
  const { guardTab } = await freshWorker();
  await Promise.all([1, 2, 3, 4].map((tab) => guardTab(tab, RULES)));
  assert.equal(rules.size, 4);
});

test("releasing a tab removes its rules and frees the guard for another cell", async () => {
  const { rules } = installChrome();
  const { guardTab, releaseTabs } = await freshWorker();
  await guardTab(3, RULES);
  assert.equal(rules.size, 1);
  await releaseTabs([3]);
  assert.equal(rules.size, 0);
  await guardTab(3, RULES);
  assert.equal(rules.size, 1);
});

test("a failed rule update leaves the tab free to be guarded again", async () => {
  const { rules } = installChrome();
  const { guardTab } = await freshWorker();
  const original = chrome.declarativeNetRequest.updateSessionRules;
  chrome.declarativeNetRequest.updateSessionRules = async () => {
    throw new Error("quota");
  };
  await assert.rejects(guardTab(9, RULES), /quota/);
  chrome.declarativeNetRequest.updateSessionRules = original;
  await guardTab(9, RULES);
  assert.equal(rules.size, 1);
});

test("a popup from a guarded tab takes its rules before loading, or closes if headed to a blocked site", async () => {
  const { rules, calls } = installChrome();
  const { guardTab, guardPopup, releaseTabs } = await freshWorker();
  // An unguarded opener's popups are not this module's business.
  assert.equal(await guardPopup(20, 99, "https://blocked.test/"), false);
  await guardTab(10, RULES);
  assert.equal(await guardPopup(11, 10, "https://blocked.test/x"), true);
  assert.ok(calls.some((call) => call.removed === 11));
  assert.equal(await guardPopup(12, 10, "about:blank"), false);
  assert.equal(rules.size, 2);
  assert.ok([...rules.values()].some((rule) => rule.condition.tabIds[0] === 12));
  // Releasing the opener lifts the popup's inherited rules too.
  await releaseTabs([10]);
  assert.equal(rules.size, 0);
});
