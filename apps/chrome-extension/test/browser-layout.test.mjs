import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
test("regular-chat browser work pairs tabs automatically and side-panel work keeps its layout", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aeon-layout-")),
    old = globalThis.chrome;
  try {
    const outfile = join(folder, "layout.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/native-browser-layout.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const api = await import(pathToFileURL(outfile).href);
    const mock = layoutChrome();
    globalThis.chrome = mock.chrome;
    await api.presentBrowserTask("test", 20);
    assert.equal(mock.splits(), 1);
    assert.equal(mock.rows.get(20).groupId, 7);
    assert.equal(mock.rows.get(20).pinned, true);
    assert.equal(mock.rows.get(10).active, true);
    await api.presentBrowserTask("test", 20);
    assert.equal(mock.splits(), 1, "Existing pairing should be reused");
    await api.presentBrowserTask("panel-only", 20);
    assert.equal(mock.splits(), 1, "No regular chat tab means no automatic layout change");
    delete mock.chrome.tabs.createSplit;
    await api.presentBrowserTask("test", 20);
    assert.equal(mock.splits(), 1);
  } finally {
    globalThis.chrome = old;
    await rm(folder, { recursive: true, force: true });
  }
});
function layoutChrome() {
  const rows = initialTabs();
  let count = 0;
  const tabs = {
    get: async (id) => ({ ...rows.get(id) }),
    query: async () => [...rows.values()],
    update: async (id, value) => Object.assign(rows.get(id), value),
    move: async (id, value) => {
      const ordered = [...rows.values()]
        .sort((a, b) => a.index - b.index)
        .filter((row) => row.id !== id);
      ordered.splice(value.index, 0, rows.get(id));
      ordered.forEach((row, index) => {
        row.index = index;
      });
    },
    group: async ({ tabIds, groupId }) => {
      for (const id of tabIds) rows.get(id).groupId = groupId;
    },
    ungroup: async (id) => {
      rows.get(id).groupId = -1;
    },
    unsplit: async () => {},
    createSplit: async ([left, right]) => {
      assert.equal(rows.get(right).index, rows.get(left).index + 1);
      assert.equal(rows.get(left).groupId, rows.get(right).groupId);
      assert.equal(rows.get(left).pinned, rows.get(right).pinned);
      rows.get(left).splitViewId = rows.get(right).splitViewId = ++count;
      return count;
    },
  };
  return {
    rows,
    splits: () => count,
    chrome: { tabs, runtime: { getURL: (path) => "chrome-extension://aeon/" + path } },
  };
}

function initialTabs() {
  return new Map([
    [
      10,
      {
        id: 10,
        index: 1,
        windowId: 1,
        groupId: 7,
        pinned: true,
        active: true,
        splitViewId: -1,
        url: "chrome-extension://aeon/chat.html?chatId=test",
      },
    ],
    [
      20,
      {
        id: 20,
        index: 0,
        windowId: 1,
        groupId: -1,
        pinned: false,
        active: false,
        splitViewId: -1,
        url: "https://www.yahoo.com/",
      },
    ],
  ]);
}
