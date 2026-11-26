import assert from "node:assert/strict";
import test from "node:test";

// Chrome often resolves tabs.remove while a debugger is attached and leaves the tab open.
// closeChatTab detaches and leaves the group first, retries once, and counts the close only
// when the tab is gone. A replaced tab id closes the tab that replaced it.

const tabs = new Map();
const order = [];
let detached = new Set();

function tab(id, extra = {}) {
  return { id, groupId: -1, url: "https://example.test/", ...extra };
}

globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
  },
  debugger: {
    detach: async ({ tabId }) => {
      order.push(["detach", tabId]);
      detached.add(tabId);
    },
  },
  tabs: {
    get: async (id) => tabs.get(id),
    remove: async (id) => {
      order.push(["remove", id]);
      if (!detached.has(id)) return;
      tabs.delete(id);
    },
    ungroup: async (id) => {
      order.push(["ungroup", id]);
      const current = tabs.get(id);
      if (current) current.groupId = -1;
    },
  },
  runtime: { onStartup: { addListener() {} } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  windows: { getLastFocused: async () => undefined },
  tabGroups: { TAB_GROUP_ID_NONE: -1 },
};

const { closeChatTab, agentTabSummary, isClosing } =
  await import("../dist/native-browser-tab-cleanup.js");
const { recordReplacement } = await import("../dist/native-browser-replaced.js");

test("close detaches a grouped tab before remove and counts it", async () => {
  tabs.clear();
  order.length = 0;
  detached = new Set();
  tabs.set(4, tab(4, { groupId: 9 }));
  const result = await closeChatTab("chat-a", 4);
  assert.deepEqual(result, { closed: 4 });
  assert.equal(tabs.has(4), false);
  assert.equal(agentTabSummary("chat-a").closed, 1);
  // The first remove runs attached (so a beforeunload reaches the dialog handler); this mock
  // ignores it, like Chrome often does, so the close detaches before the remove that lands.
  const firstRemove = order.findIndex((entry) => entry[0] === "remove" && entry[1] === 4);
  const detachAt = order.findIndex((entry) => entry[0] === "detach" && entry[1] === 4);
  const lastRemove = order.findLastIndex((entry) => entry[0] === "remove" && entry[1] === 4);
  assert.ok(firstRemove !== -1 && firstRemove < detachAt, JSON.stringify(order));
  assert.ok(detachAt < lastRemove, JSON.stringify(order));
  const ungroupAt = order.findIndex((entry) => entry[0] === "ungroup" && entry[1] === 4);
  assert.ok(ungroupAt !== -1 && ungroupAt < firstRemove, JSON.stringify(order));
  assert.ok(order.some((entry) => entry[0] === "ungroup" && entry[1] === 4));
});

test("a remove that leaves the tab is retried after another detach", async () => {
  tabs.clear();
  order.length = 0;
  detached = new Set();
  tabs.set(6, tab(6));
  let removes = 0;
  const original = chrome.tabs.remove;
  chrome.tabs.remove = async (id) => {
    removes += 1;
    order.push(["remove", id]);
    if (removes < 2) return;
    tabs.delete(id);
  };
  try {
    const result = await closeChatTab("chat-b", 6);
    assert.deepEqual(result, { closed: 6 });
    assert.equal(removes, 2);
    assert.equal(agentTabSummary("chat-b").closed, 1);
  } finally {
    chrome.tabs.remove = original;
  }
});

test("a close that never removes the tab throws and does not count", async () => {
  tabs.clear();
  tabs.set(8, tab(8));
  const original = chrome.tabs.remove;
  chrome.tabs.remove = async () => undefined;
  try {
    await assert.rejects(closeChatTab("chat-c", 8), /TAB_CLOSE_FAILED/);
    assert.equal(tabs.has(8), true);
    assert.equal(agentTabSummary("chat-c").closed, 0);
  } finally {
    chrome.tabs.remove = original;
  }
});

test("closing a replaced id closes the tab that replaced it", async () => {
  tabs.clear();
  order.length = 0;
  detached = new Set();
  recordReplacement(5, 9);
  tabs.set(9, tab(9));
  const result = await closeChatTab("chat-d", 5);
  assert.deepEqual(result, { closed: 9 });
  assert.equal(tabs.has(9), false);
  assert.equal(agentTabSummary("chat-d").closed, 1);
});

test("a tab is marked closing and still attached at the first remove, so its beforeunload is accepted", async () => {
  tabs.clear();
  order.length = 0;
  detached = new Set();
  tabs.set(12, tab(12));
  const original = chrome.tabs.remove;
  const seen = [];
  chrome.tabs.remove = async (id) => {
    // Chrome raises beforeunload here; the dialog handler asks isClosing.
    seen.push([isClosing(id), detached.has(id)]);
    tabs.delete(id);
  };
  try {
    const started = Date.now();
    assert.deepEqual(await closeChatTab("chat-c", 12), { closed: 12 });
    assert.ok(Date.now() - started < 1_000);
    assert.deepEqual(seen, [[true, false]]);
    tabs.set(13, tab(13));
    assert.deepEqual(await closeChatTab("chat-c", 13), { closed: 13 });
  } finally {
    chrome.tabs.remove = original;
  }
});
