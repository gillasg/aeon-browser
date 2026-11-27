import assert from "node:assert/strict";
import test from "node:test";
import { resolveTabWindow } from "../dist/native-browser-tab-window.js";

const source = (windows) => ({ windowOfTab: async (tabId) => windows[tabId] });

test("a new tab follows the chat's newest open tab to the window it was moved to", async () => {
  // Tab 1 stayed in window 10; tab 2, used last, was dragged to window 20.
  const windowId = await resolveTabWindow(source({ 1: 10, 2: 20 }), { ownTabs: [2, 1] });
  assert.equal(windowId, 20);
});

test("windowOf opens beside the named tab, whatever the chat's tabs say", async () => {
  const windowId = await resolveTabWindow(source({ 1: 10, 2: 20, 7: 30 }), {
    windowOf: 7,
    ownTabs: [1, 2],
  });
  assert.equal(windowId, 30);
});

test("a closed tab or window falls back to the next open tab, then Chrome's default", async () => {
  assert.equal(await resolveTabWindow(source({ 1: 10 }), { ownTabs: [2, 1] }), 10);
  assert.equal(await resolveTabWindow(source({}), { ownTabs: [1, 2] }), undefined);
  assert.equal(await resolveTabWindow(source({}), { ownTabs: [] }), undefined);
});

test("windowOf naming a tab that is gone is an error, not a silent guess", async () => {
  await assert.rejects(
    resolveTabWindow(source({ 1: 10 }), { windowOf: 99, ownTabs: [1] }),
    /INVALID_TARGET/,
  );
});
