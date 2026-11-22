import assert from "node:assert/strict";
import test from "node:test";
import { browserContextApi } from "../dist/code-api-context.js";

// Another chat's tab is titled with that chat's prompt. browser.context() once listed it as the
// user's open tab, and a repair task followed it into a different task's site.

test("browser.context leaves Aeon's own chat and Manage tabs out of the user's tabs", async () => {
  const browser = {
    tabs: async () => [
      {
        id: 1,
        active: true,
        aeonUi: true,
        title: "how many lamps · Aeon",
        url: "chrome-extension://x/chat.html",
      },
      {
        id: 2,
        active: false,
        aeonUi: true,
        title: "Aeon · Manage",
        url: "chrome-extension://x/home.html",
      },
      { id: 3, active: true, title: "Shop", url: "http://127.0.0.1:8790/shop/" },
    ],
    history: { search: async () => [], top: async () => ({ groups: [] }) },
    bookmarks: { search: async () => [] },
  };
  const context = new Function(
    "browser",
    "__focusedWindowId",
    `${browserContextApi}; return __context("", {});`,
  );
  const result = await context(browser, undefined);
  assert.deepEqual(
    result.openTabs.map((tab) => tab.id),
    [3],
  );
  assert.equal(result.activeTab.id, 3);
});
