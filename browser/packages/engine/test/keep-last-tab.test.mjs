import assert from "node:assert/strict";
import { test } from "node:test";

const { closeTabsKeepingBrowser, installLastTabGuard } = await import("../dist/keep-last-tab.js");

test("removing the only tab opens a blank tab first", async () => {
  const world = fake([{ id: 1, url: "https://example.test/" }]);
  await closeTabsKeepingBrowser(1, world.api);
  assert.deepEqual(world.created, [{ url: "about:blank", active: false }]);
  assert.deepEqual(world.removed, [1]);
  assert.deepEqual(
    world.tabs.map((tab) => tab.url),
    ["about:blank"],
  );
});

test("removing one of two tabs does not open a blank tab", async () => {
  const world = fake([
    { id: 1, url: "https://a.test/" },
    { id: 2, url: "https://b.test/" },
  ]);
  await closeTabsKeepingBrowser(1, world.api);
  assert.deepEqual(world.created, []);
  assert.deepEqual(
    world.tabs.map((tab) => tab.id),
    [2],
  );
});

test("removing every tab in one call leaves a single blank tab", async () => {
  const world = fake([
    { id: 1, url: "https://a.test/" },
    { id: 2, url: "https://b.test/" },
  ]);
  await closeTabsKeepingBrowser([1, 2], world.api);
  assert.equal(world.created.length, 1);
  assert.deepEqual(world.removed, [[1, 2]]);
  assert.deepEqual(
    world.tabs.map((tab) => tab.url),
    ["about:blank"],
  );
});

test("parallel closes of the last two tabs still leave a blank tab", async () => {
  const world = fake([
    { id: 1, url: "https://a.test/" },
    { id: 2, url: "https://b.test/" },
  ]);
  await Promise.all([closeTabsKeepingBrowser(1, world.api), closeTabsKeepingBrowser(2, world.api)]);
  assert.equal(world.created.length, 1);
  assert.deepEqual(
    world.tabs.map((tab) => tab.url),
    ["about:blank"],
  );
});

test("a failed tab query still attempts the remove and does not invent a tab", async () => {
  const removed = [];
  const api = {
    query: async () => {
      throw new Error("tabs unavailable");
    },
    create: async () => {
      throw new Error("should not create");
    },
    remove: async (ids) => {
      removed.push(ids);
    },
  };
  await closeTabsKeepingBrowser(4, api);
  assert.deepEqual(removed, [4]);
});

test("an empty id list does not query or remove", async () => {
  let calls = 0;
  const api = {
    query: async () => {
      calls += 1;
      return [];
    },
    create: async () => {
      calls += 1;
    },
    remove: async () => {
      calls += 1;
    },
  };
  await closeTabsKeepingBrowser([], api);
  assert.equal(calls, 0);
});

test("Page.close and tabs.remove keep a blank tab and other commands stay native", async () => {
  const sent = [];
  const world = fake([{ id: 7, url: "https://example.test/" }]);
  const bare = { debugger: { sendCommand: async () => ({ from: "cdp" }) } };
  const untouched = bare.debugger.sendCommand;
  globalThis.chrome = bare;
  installLastTabGuard();
  assert.equal(bare.debugger.sendCommand, untouched);

  globalThis.chrome = {
    tabs: world.api,
    debugger: {
      async sendCommand(_debuggee, method) {
        sent.push(method);
        return { from: "cdp" };
      },
    },
  };
  installLastTabGuard();
  const closed = await globalThis.chrome.debugger.sendCommand({ tabId: 7 }, "Page.close");
  assert.deepEqual(closed, {});
  assert.deepEqual(sent, []);
  assert.deepEqual(
    world.tabs.map((tab) => tab.url),
    ["about:blank"],
  );
  const evaluated = await globalThis.chrome.debugger.sendCommand({ tabId: 8 }, "Runtime.evaluate");
  assert.deepEqual(evaluated, { from: "cdp" });
  assert.deepEqual(sent, ["Runtime.evaluate"]);

  world.tabs.push({ id: 9, url: "https://kept.test/" });
  await globalThis.chrome.tabs.remove(9);
  assert.equal(world.created.length, 1);
  assert.equal(
    world.tabs.some((tab) => tab.id === 9),
    false,
  );
});

function fake(initial) {
  const tabs = initial.map((tab) => ({ ...tab }));
  const created = [];
  const removed = [];
  let nextId = 100;
  const api = {
    query: async () => tabs.map((tab) => ({ ...tab })),
    create: async (tab) => {
      created.push({ ...tab });
      const opened = { id: nextId, url: tab.url };
      nextId += 1;
      tabs.push(opened);
      return opened;
    },
    remove: async (ids) => {
      removed.push(ids);
      const list = Array.isArray(ids) ? ids : [ids];
      for (const id of list) {
        const index = tabs.findIndex((tab) => tab.id === id);
        if (index >= 0) tabs.splice(index, 1);
      }
    },
  };
  return { tabs, created, removed, api };
}

test("on macOS the last agent tab of the only window keeps a blank tab in that window", async () => {
  const saved = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const world = fake([{ id: 7, windowId: 3, url: "https://agent.test/" }]);
    const order = [];
    const api = {
      query: world.api.query,
      create: async (tab) => {
        order.push("create");
        return world.api.create(tab);
      },
      remove: async (ids) => {
        order.push("remove");
        return world.api.remove(ids);
      },
    };
    await closeTabsKeepingBrowser(7, api);
    assert.deepEqual(order, ["create", "remove"]);
    assert.deepEqual(world.created, [{ url: "about:blank", active: false, windowId: 3 }]);
  } finally {
    if (saved) Object.defineProperty(process, "platform", saved);
  }
});
