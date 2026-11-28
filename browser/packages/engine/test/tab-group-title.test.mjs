// The shared agent tab group shows a clean title ("Graft", "Graft · 2"): no owner marker and
// never the raw "shared--" key.
import assert from "node:assert/strict";
import test from "node:test";

const groups = new Map();
let nextGroup = 100;
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => undefined },
    session: { get: async () => ({}), set: async () => undefined },
    onChanged: { addListener() {} },
  },
  tabs: {
    get: async (id) => ({ id, windowId: 1, groupId: -1 }),
    query: async () => [],
    group: async ({ groupId }) => {
      const id = groupId ?? nextGroup++;
      if (!groups.has(id)) groups.set(id, { id, windowId: 1, title: "" });
      return id;
    },
    ungroup: async () => undefined,
    onRemoved: { addListener() {} },
  },
  tabGroups: {
    get: async (id) => groups.get(id) ?? Promise.reject(new Error("no group")),
    query: async () => [...groups.values()],
    update: async (id, props) => Object.assign(groups.get(id), props),
    onRemoved: { addListener() {} },
  },
};

const { engineConfig } = await import("../dist/engine-config.js");
engineConfig.tabGroupTitle = (_owner, title) => title ?? "Graft";
const { groupAgentTab } = await import("../dist/native-browser-groups.js");

test("the shared group title carries no marker and no shared-- key", async () => {
  await groupAgentTab(1, 1, "chat-aaaaaaaa", "Chat A");
  await groupAgentTab(2, 1, "chat-bbbbbbbb", "Chat B");
  const titles = [...groups.values()].map((group) => group.title);
  assert.equal(groups.size, 1, "both chats share one group");
  for (const title of titles) {
    assert.doesNotMatch(title, /shared--/);
    assert.doesNotMatch(title, /⁣/);
    assert.match(title, /^Graft( · \d)?$/);
  }
  assert.equal(titles[0], "Graft · 2");
});
