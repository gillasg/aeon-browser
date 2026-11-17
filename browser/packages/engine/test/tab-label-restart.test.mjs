// Tab labels (p1, p2…) are durable: a Chrome restart keeps them and re-binds them by URL when a
// tab's id changes. chrome.storage.session alone would lose them on restart.
import assert from "node:assert/strict";
import test from "node:test";

const local = {};
const session = {};
const tabs = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: local[key] }),
      set: async (items) => Object.assign(local, items),
    },
    session: {
      get: async (key) => ({ [key]: session[key] }),
      set: async (items) => Object.assign(session, items),
    },
  },
  tabs: {
    get: async (id) => tabs.get(id),
    query: async () => [...tabs.values()],
    onRemoved: { addListener() {} },
  },
  runtime: { sendMessage: async () => undefined, onMessage: { addListener() {} } },
};

const chatId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const url = "https://example.test/orders";

test("a label survives a restart and re-binds to the same URL with a new tab id", async () => {
  const first = await import("../dist/native-browser-spaces.js");
  first.noteSpace(chatId, "tabs");
  assert.equal(first.noteLabel(chatId, 5, url), "p1");
  assert.equal(first.labelOf(chatId, 5), "p1");
  // Durable, not session-only.
  assert.ok(local["browserkit-spaces"]?.length === 1);
  assert.equal(session["browserkit-spaces"], undefined);

  // A fresh engine (new service worker after Chrome restarted) reads the durable store.
  const afterRestart = await import("../dist/native-browser-spaces.js?restart");
  await afterRestart.ensureSpacesRestored();
  assert.equal(afterRestart.labelOf(chatId, 5), "p1");

  // The tab now has a different id; the same URL keeps its label.
  tabs.set(99, { id: 99, url });
  assert.equal(afterRestart.noteLabel(chatId, 99, url), "p1");
  assert.equal(afterRestart.labelOf(chatId, 99), "p1");
  tabs.clear();
  // Let the module's fire-and-forget writes settle inside the test, not after it.
  await new Promise((resolve) => setTimeout(resolve, 20));
});
