import assert from "node:assert/strict";
import test from "node:test";

// Split View pairs a chat with the agent's tab and takes that tab out of its group (Chrome pairs
// tabs in one group). When the chat pairs with the next tab, a tab the agent opened goes back to
// the agent group instead of staying loose among the user's tabs; the user's own tab does not.
const tabs = new Map();
const groups = new Map();
const splits = new Map();
const store = new Map();
let nextGroup = 100;
let nextSplit = 1;
const tab = (id, extra = {}) =>
  tabs.set(id, {
    id,
    windowId: 1,
    index: tabs.size,
    groupId: -1,
    splitViewId: -1,
    active: false,
    pinned: false,
    ...extra,
  });
const storage = {
  get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
  set: async (values) => {
    for (const [key, value] of Object.entries(values)) store.set(key, value);
  },
  remove: async () => undefined,
};
globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://aeon/${path}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    id: "aeon",
  },
  alarms: { create() {}, onAlarm: { addListener() {} }, clear: async () => true },
  storage: { session: storage, local: storage, onChanged: { addListener() {} } },
  action: { onClicked: { addListener() {} } },
  windows: {
    getAll: async () => [{ id: 1, type: "normal" }],
    getLastFocused: async () => ({ id: 99 }),
  },
  tabs: {
    get: async (id) => {
      const found = tabs.get(id);
      if (!found) throw new Error("no tab");
      return { ...found };
    },
    query: async (filter = {}) =>
      [...tabs.values()].filter(
        (item) =>
          (filter.active === undefined || item.active === filter.active) &&
          (filter.windowId === undefined || item.windowId === filter.windowId) &&
          (filter.groupId === undefined || item.groupId === filter.groupId),
      ),
    update: async (id, patch) => Object.assign(tabs.get(id), patch),
    move: async (id, { index }) => Object.assign(tabs.get(id), { index }),
    ungroup: async (id) => {
      for (const item of [id].flat()) tabs.get(item).groupId = -1;
    },
    group: async (options) => {
      const groupId = options.groupId ?? nextGroup++;
      if (!groups.has(groupId))
        groups.set(groupId, { id: groupId, windowId: options.createProperties?.windowId ?? 1 });
      for (const item of [options.tabIds].flat()) tabs.get(item).groupId = groupId;
      return groupId;
    },
    createSplit: async (ids) => {
      const splitId = nextSplit++;
      splits.set(splitId, ids);
      for (const item of ids) tabs.get(item).splitViewId = splitId;
      return splitId;
    },
    unsplit: async (splitId) => {
      for (const item of splits.get(splitId) ?? []) {
        const found = tabs.get(item);
        if (found) found.splitViewId = -1;
      }
      splits.delete(splitId);
    },
  },
  tabGroups: {
    get: async (id) => groups.get(id),
    query: async ({ windowId }) =>
      [...groups.values()].filter((item) => item.windowId === windowId),
    update: async (id, patch) => Object.assign(groups.get(id), patch),
  },
};

// Every Chrome event the engine listens to: missing ones are stubbed, and onActivated is kept so
// the test can fire the user's (or Aeon's) tab switches.
const activated = [];
const stubEvents = (node) => {
  for (const value of Object.values(node))
    if (value && typeof value === "object" && !Array.isArray(value)) stubEvents(value);
};
stubEvents(globalThis.chrome);
globalThis.chrome.tabs.onActivated = { addListener: (listener) => activated.push(listener) };
globalThis.chrome = new Proxy(globalThis.chrome, {
  get: (target, key) => target[key] ?? eventSpace(),
});
function eventSpace() {
  return new Proxy(
    {},
    {
      get: (_, key) =>
        String(key).startsWith("on") ? { addListener() {} } : async () => undefined,
    },
  );
}
for (const name of [
  "onRemoved",
  "onUpdated",
  "onCreated",
  "onAttached",
  "onDetached",
  "onReplaced",
])
  globalThis.chrome.tabs[name] ??= { addListener() {} };
const userSwitches = (tabId) => {
  for (const listener of activated) listener({ tabId, windowId: 1 });
};
const { configureEngine } = await import("../packages/engine/dist/engine-config.js");
configureEngine({ tabGroupTitle: () => "Aeon" });
const { trackAgentTab } = await import("../packages/engine/dist/native-browser-tab-cleanup.js");
const { groupAgentTab, isAgentGroupId } =
  await import("../packages/engine/dist/native-browser-groups.js");
const { presentBrowserTask } = await import("../packages/engine/dist/native-browser-layout.js");
const { installEngineListeners } = await import("../packages/engine/dist/native-engine-install.js");
try {
  installEngineListeners();
} catch {
  // Listeners for APIs this fake lacks; the tab ones are what the test needs.
}

test("a split-paired agent tab returns to the agent group when the chat moves on", async () => {
  const chatId = "chat-1";
  tab(1, { url: `chrome-extension://aeon/chat.html?chatId=${chatId}`, active: true });
  tab(2, { url: "https://widgets.example/" });
  tab(3, { url: "https://digital.example/" });
  tab(4, { url: "https://user.example/" });
  for (const id of [2, 3]) {
    trackAgentTab(id, chatId);
    await groupAgentTab(id, 1, chatId);
  }
  assert.ok(isAgentGroupId(tabs.get(2).groupId), "the agent's tab starts in the agent group");

  await presentBrowserTask(chatId, 2);
  assert.ok(tabs.get(2).splitViewId > 0, "the first agent tab is paired with the chat");
  assert.equal(tabs.get(2).groupId, -1, "pairing takes it out of its group");

  await presentBrowserTask(chatId, 3);
  assert.ok(tabs.get(3).splitViewId > 0, "the chat now pairs with the second tab");
  assert.equal(tabs.get(2).splitViewId, -1);
  assert.ok(isAgentGroupId(tabs.get(2).groupId), "the first tab went back to the agent group");

  // The user's own tab, once paired and unpaired, stays wherever it was.
  await presentBrowserTask(chatId, 4);
  await presentBrowserTask(chatId, 3);
  assert.equal(tabs.get(4).groupId, -1, "a tab the agent did not open is never grouped");
});

test("a tab only Aeon showed is not the user's: the run's tidy-up still closes it", async () => {
  const { tidyChatTabs } = await import("../packages/engine/dist/native-browser-tab-cleanup.js");
  const closed = [];
  globalThis.chrome.tabs.remove = async (id) => {
    closed.push(id);
    tabs.delete(id);
  };
  const chatId = "chat-2";
  tab(11, { url: `chrome-extension://aeon/chat.html?chatId=${chatId}`, active: true });
  for (const id of [12, 13, 14]) {
    tab(id, { url: `https://store-${id}.example/` });
    trackAgentTab(id, chatId);
  }
  // Aeon pairs each tab with the chat in turn; Chrome reports each as activated.
  for (const id of [12, 13, 14]) {
    await presentBrowserTask(chatId, id);
    userSwitches(id);
  }
  // The user really switches to 13 a while later, so 13 is theirs to keep.
  await new Promise((done) => setTimeout(done, 2100));
  userSwitches(13);
  await tidyChatTabs(chatId);
  assert.ok(closed.includes(12) || closed.includes(14), "an Aeon-only tab was closed");
  assert.ok(!closed.includes(13), "the tab the user switched to stays");
});
