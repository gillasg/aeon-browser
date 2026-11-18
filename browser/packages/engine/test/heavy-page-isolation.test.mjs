// A heavy page (or a stuck cell) in one chat must not kill or hold the cells of another chat.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const host = readFileSync(new URL("../src/code-runtime-host.ts", import.meta.url), "utf8");
const offscreen = readFileSync(new URL("../src/code-offscreen.ts", import.meta.url), "utf8");
const inventory = readFileSync(
  new URL("../src/native-inventory-client.ts", import.meta.url),
  "utf8",
);
const tabs = readFileSync(new URL("../src/native-browser-tabs.ts", import.meta.url), "utf8");

test("resetting one chat's realm closes the shared document only when its thread is blocked", () => {
  // Closing the shared offscreen document ends every other chat's running cell, so a busy document
  // (one that still answers) is never closed. Only one that cannot answer for 15 s is: its thread is
  // blocked, every chat in it is already stuck, and closing it is the only recovery.
  assert.match(host, /kind: "reset", chatId/);
  assert.match(host, /RESET_ANSWER_MS = 15_000/);
  assert.match(host, /if \(!answered\) \{\s*await chrome\.offscreen\.closeDocument\(\)/);
  // The offscreen handler drops just the frames of the chat named in the message, and answers at once.
  assert.match(offscreen, /drop\(message\.chatId\);\s*reply\(true\)/);
  assert.match(offscreen, /realms\.delete\(chatId\)/);
});

test("browser.tabs() bounds its wait on the inventory chain shared by every chat and tab", () => {
  assert.match(inventory, /maxWaitMs\?: number/);
  assert.match(inventory, /withTimeout\(work, maxWaitMs\)/);
  assert.match(tabs, /ACTIVE_REFRESH_MS/);
  assert.match(tabs, /refreshInventoryTab\(live\.id, ACTIVE_REFRESH_MS\)/);
});

test("a bounded chain wait resolves current state without cancelling the queued work", async () => {
  const { withTimeout } = await import("../dist/native-inventory-client.js");
  let release = () => undefined;
  const work = new Promise((done) => {
    release = () => done("fresh");
  });
  // The wait gives up while the chain is still busy; the queued work keeps running.
  assert.equal(await withTimeout(work, 20), undefined);
  release();
  assert.equal(await work, "fresh");
  // A call that settles in time still gets the value.
  assert.equal(await withTimeout(Promise.resolve("now"), 100), "now");
  // A failure in the chain still reaches the caller.
  await assert.rejects(withTimeout(Promise.reject(new Error("sync lost")), 100), /sync lost/);
});

const cleanup = readFileSync(
  new URL("../src/native-browser-tab-cleanup.ts", import.meta.url),
  "utf8",
);
test("a parallel chat's regroup cannot strip a chat's tab while it is still using it", () => {
  assert.match(cleanup, /GROUP_UNTRACK_MS/);
  assert.match(cleanup, /recentlyUsed[\s\S]*?forgetAgentTab/);
});

test("a group change is ignored while the owning chat still uses the tab", () => {
  assert.match(cleanup, /Date\.now\(\) - entry\.touched < GROUP_UNTRACK_MS/);
  assert.match(cleanup, /if \(!recentlyUsed\) forgetAgentTab\(tabId\)/);
});
